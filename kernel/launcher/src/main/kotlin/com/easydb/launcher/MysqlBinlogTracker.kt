/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
package com.easydb.launcher

import com.easydb.common.*
import com.easydb.drivers.mysql.MysqlDatabaseSession
import com.github.shyiko.mysql.binlog.BinaryLogClient
import com.github.shyiko.mysql.binlog.event.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import org.slf4j.LoggerFactory
import java.io.Serializable
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.Timer
import java.util.TimerTask

/**
 * MySQL Binlog 变更追踪器
 *
 * 通过 mysql-binlog-connector-java 模拟 MySQL Slave，
 * 实时接收并解析 ROW 格式的 binlog 事件。
 *
 * 架构: 后端全量存储 + SSE 轻量通知 + 前端按需分页拉取
 */
class MysqlBinlogTracker : ChangeTracker {

    private val logger = LoggerFactory.getLogger(MysqlBinlogTracker::class.java)

    // 活跃会话: sessionId -> TrackerSession
    private val sessions = ConcurrentHashMap<String, TrackerSession>()

    // 每个会话的内部状态
    private data class TrackerSession(
        val sessionId: String,
        val connectionId: String,
        val config: TrackerSessionConfig,
        val client: BinaryLogClient,
        @Volatile var thread: Thread? = null,
        val eventStore: EventStore,
        val tickFlow: MutableSharedFlow<SseTick>,
        val tickTimer: Timer,
        var status: String = "running",
        var errorMessage: String? = null,
        val startedAt: String = Instant.now().toString(),
        val eventCount: AtomicLong = AtomicLong(0),
        // 速率统计: 每秒重置
        val rateCounter: AtomicLong = AtomicLong(0),
        var lastRate: Long = 0,
        var latestEventId: String? = null,
        // TABLE_MAP 缓存: tableId -> (database, table)
        val tableMapCache: ConcurrentHashMap<Long, Pair<String, String>> = ConcurrentHashMap(),
        // 列名缓存: "database.table" -> List<String>
        val columnCache: ConcurrentHashMap<String, List<String>> = ConcurrentHashMap(),
        // 用于查询列名的 session
        val dbSession: DatabaseSession,
        // replay 模式：追踪是否已到达截止文件（用于只指定 endFile 的场景）
        @Volatile var reachedEndFile: Boolean = false,
        // 事务追踪：当前活跃事务的 ID（QUERY:BEGIN 时设置，XID 提交后清空）
        @Volatile var currentTransactionId: String? = null,
        // 追踪最后实际处理的位点，用于防止 client 在 ROTATE 后虚报进度
        @Volatile var lastProcessedFile: String? = null,
        @Volatile var lastProcessedPosition: Long = 0L
    )

    /**
     * 无限容量的事件存储（ArrayList + 同步锁）
     * 后端全量保存所有事件，前端按需分页拉取
     */
    private class EventStore {
        private val events = ArrayList<ChangeEvent>()
        // 增量统计缓存
        private var insertCount = 0L
        private var updateCount = 0L
        private var deleteCount = 0L
        private val tableSet = LinkedHashSet<String>()
        private var minTimestamp = Long.MAX_VALUE
        private var maxTimestamp = Long.MIN_VALUE

        /**
         * 添加事件到存储，返回是否实际存储成功
         */
        @Synchronized
        fun add(event: ChangeEvent): Boolean {
            events.add(event)
            // 增量更新统计
            when (event.eventType) {
                "INSERT" -> insertCount++
                "UPDATE" -> updateCount++
                "DELETE" -> deleteCount++
            }
            tableSet.add(event.table)
            if (event.timestamp < minTimestamp) minTimestamp = event.timestamp
            if (event.timestamp > maxTimestamp) maxTimestamp = event.timestamp
            return true
        }

        @Synchronized
        fun size(): Int = events.size

        /**
         * 服务端分页查询 + 筛选
         */
        @Synchronized
        fun query(
            page: Int,
            pageSize: Int,
            filterTable: String? = null,
            filterType: String? = null,
            keyword: String? = null,
            startTime: Long? = null,
            endTime: Long? = null
        ): PagedHistoryResponse {
            // 应用筛选条件
            var filtered: List<ChangeEvent> = events

            if (!filterTable.isNullOrBlank()) {
                filtered = filtered.filter { it.table == filterTable }
            }
            if (!filterType.isNullOrBlank()) {
                filtered = filtered.filter { it.eventType == filterType }
            }
            if (startTime != null) {
                filtered = filtered.filter { it.timestamp >= startTime }
            }
            if (endTime != null) {
                filtered = filtered.filter { it.timestamp <= endTime }
            }
            if (!keyword.isNullOrBlank()) {
                val kw = keyword.lowercase()
                filtered = filtered.filter { event ->
                    event.database.lowercase().contains(kw)
                        || event.table.lowercase().contains(kw)
                        || event.eventType.lowercase().contains(kw)
                        || event.rowsBefore?.any { row -> row.values.any { v -> v?.lowercase()?.contains(kw) == true } } == true
                        || event.rowsAfter?.any { row -> row.values.any { v -> v?.lowercase()?.contains(kw) == true } } == true
                }
            }

            val total = filtered.size.toLong()

            // 倒序（最新的在前面）
            val reversed = filtered.asReversed()

            // 分页 — 必须用 toList() 做防御性复制！
            // 因为 asReversed() 和 subList() 只是原始 events 的视图引用，
            // 一旦 query() 返回后（synchronized 锁释放），在 JSON 序列化期间
            // 如果有并发 add() 修改 events，会导致 ConcurrentModificationException
            // 或更隐蔽地产生重复/错位数据 — 这是页面重复显示的根本原因。
            val start = page * pageSize
            val items = if (start >= reversed.size) emptyList()
                else reversed.subList(start, minOf(start + pageSize, reversed.size)).toList()

            // 统计（基于全量数据，不受筛选影响）
            val stats = getStats()

            return PagedHistoryResponse(
                items = items,
                total = total,
                page = page,
                pageSize = pageSize,
                stats = stats
            )
        }

        @Synchronized
        fun findById(id: String): ChangeEvent? {
            return events.find { it.id == id }
        }

        @Synchronized
        fun findByIds(ids: List<String>): List<ChangeEvent> {
            val idSet = ids.toHashSet()
            return events.filter { it.id in idSet }
        }

        @Synchronized
        fun getStats(): HistoryStats {
            return HistoryStats(
                insertCount = insertCount,
                updateCount = updateCount,
                deleteCount = deleteCount,
                tables = tableSet.toList(),
                timeRange = if (events.isEmpty()) emptyList()
                    else listOf(minTimestamp, maxTimestamp)
            )
        }

        @Synchronized
        fun clear() {
            events.clear()
            events.trimToSize()
            insertCount = 0
            updateCount = 0
            deleteCount = 0
            tableSet.clear()
            minTimestamp = Long.MAX_VALUE
            maxTimestamp = Long.MIN_VALUE
        }
    }

    override fun start(session: DatabaseSession, config: TrackerSessionConfig): String {
        val sessionId = UUID.randomUUID().toString()
        val mysqlSession = session as MysqlDatabaseSession
        val connConfig = mysqlSession.config

        val client = BinaryLogClient(
            connConfig.host,
            connConfig.port,
            connConfig.username,
            connConfig.password
        )

        // 设置 server-id（避免与其他 slave 冲突）
        client.serverId = (System.currentTimeMillis() % 100000 + 10000).toLong()

        // 如果指定了起始位置
        config.startFile?.let { client.binlogFilename = it }
        config.startPosition?.let { client.binlogPosition = it }

        val eventStore = EventStore()
        val tickFlow = MutableSharedFlow<SseTick>(extraBufferCapacity = 64)

        // 每秒发送一次 tick 通知
        val tickTimer = Timer("tick-timer-$sessionId", true)

        val trackerSession = TrackerSession(
            sessionId = sessionId,
            connectionId = config.connectionId,
            config = config,
            client = client,
            eventStore = eventStore,
            tickFlow = tickFlow,
            tickTimer = tickTimer,
            dbSession = session
        )

        // 启动 tick 定时器: 每秒向 SSE 推送一次计数通知
        tickTimer.scheduleAtFixedRate(object : TimerTask() {
            override fun run() {
                val count = trackerSession.eventCount.get()
                val rate = trackerSession.rateCounter.getAndSet(0)
                trackerSession.lastRate = rate
                tickFlow.tryEmit(SseTick(
                    type = if (trackerSession.status == "completed") "completed"
                           else if (trackerSession.status == "error") "error"
                           else "tick",
                    totalCount = count,
                    rate = rate,
                    latestId = trackerSession.latestEventId,
                    message = if (trackerSession.status == "completed") "回放完成"
                              else trackerSession.errorMessage
                ))
            }
        }, 1000, 1000)

        // 注册事件监听器
        client.registerEventListener { event ->
            try {
                handleBinlogEvent(event, trackerSession)
            } catch (e: Exception) {
                logger.error("Error handling binlog event: ${e.message}", e)
            }
        }

        // 生命周期监听
        client.registerLifecycleListener(object : BinaryLogClient.LifecycleListener {
            override fun onConnect(client: BinaryLogClient) {
                logger.info("[Tracker:$sessionId] Connected to MySQL binlog")
            }

            override fun onCommunicationFailure(client: BinaryLogClient, ex: Exception) {
                logger.error("[Tracker:$sessionId] Communication failure: ${ex.message}")
                trackerSession.status = "error"
                trackerSession.errorMessage = ex.message
            }

            override fun onEventDeserializationFailure(client: BinaryLogClient, ex: Exception) {
                logger.warn("[Tracker:$sessionId] Event deserialization failure: ${ex.message}")
            }

            override fun onDisconnect(client: BinaryLogClient) {
                logger.info("[Tracker:$sessionId] Disconnected from MySQL binlog")
                if (trackerSession.status == "running") {
                    trackerSession.status = "stopped"
                }
            }
        })

        // 在独立线程中启动连接（阻塞式）
        val thread = Thread({
            try {
                client.connect()
            } catch (e: Exception) {
                logger.error("[Tracker:$sessionId] Failed to connect: ${e.message}", e)
                trackerSession.status = "error"
                trackerSession.errorMessage = e.message
            }
        }, "binlog-tracker-$sessionId")
        thread.isDaemon = true
        trackerSession.thread = thread
        thread.start()

        sessions[sessionId] = trackerSession

        logger.info("[Tracker:$sessionId] Started for connection ${config.connectionId}")
        return sessionId
    }

    override fun stop(sessionId: String) {
        val session = sessions.remove(sessionId) ?: return
        try {
            session.tickTimer.cancel()
            session.client.disconnect()
            session.thread?.interrupt()
            session.status = "stopped"
            logger.info("[Tracker:$sessionId] Stopped")
        } catch (e: Exception) {
            logger.error("[Tracker:$sessionId] Error stopping: ${e.message}")
        }
    }

    override fun status(sessionId: String): TrackerSessionStatus? {
        val session = sessions[sessionId] ?: return null
        return TrackerSessionStatus(
            sessionId = session.sessionId,
            connectionId = session.connectionId,
            status = session.status,
            currentFile = session.lastProcessedFile ?: session.client.binlogFilename,
            currentPosition = if (session.lastProcessedPosition > 0) session.lastProcessedPosition else session.client.binlogPosition,
            eventCount = session.eventCount.get(),
            startedAt = session.startedAt,
            errorMessage = session.errorMessage,
            database = session.config.database
        )
    }

    override fun getHistory(
        sessionId: String,
        page: Int,
        pageSize: Int,
        filterTable: String?,
        filterType: String?,
        keyword: String?,
        startTime: Long?,
        endTime: Long?
    ): PagedHistoryResponse {
        val session = sessions[sessionId]
            ?: return PagedHistoryResponse(emptyList(), 0, page, pageSize, HistoryStats())
        return session.eventStore.query(page, pageSize, filterTable, filterType, keyword, startTime, endTime)
    }

    override fun subscribe(sessionId: String): Flow<SseTick> {
        val session = sessions[sessionId]
            ?: throw IllegalArgumentException("Session not found: $sessionId")
        return session.tickFlow.asSharedFlow()
    }

    override fun generateRollbackSql(
        sessionId: String,
        eventIds: List<String>,
        session: DatabaseSession,
        database: String
    ): RollbackSqlResult {
        val trackerSession = sessions[sessionId]
            ?: return RollbackSqlResult(emptyList(), emptyList(), 0, listOf("Session not found"))

        val events = trackerSession.eventStore.findByIds(eventIds)
        if (events.isEmpty()) {
            return RollbackSqlResult(emptyList(), emptyList(), 0, listOf("No matching events found"))
        }

        return RollbackGenerator.generate(events, database)
    }

    override fun generateForwardSql(
        sessionId: String,
        eventIds: List<String>,
        session: DatabaseSession,
        database: String
    ): RollbackSqlResult {
        val trackerSession = sessions[sessionId]
            ?: return RollbackSqlResult(emptyList(), emptyList(), 0, listOf("Session not found"))

        val events = trackerSession.eventStore.findByIds(eventIds)
        if (events.isEmpty()) {
            return RollbackSqlResult(emptyList(), emptyList(), 0, listOf("No matching events found"))
        }

        return ForwardSqlGenerator.generate(events, database)
    }

    override fun checkServerCompatibility(session: DatabaseSession): TrackerServerCheck {
        val conn = (session as MysqlDatabaseSession).connection
        val issues = mutableListOf<String>()
        var binlogEnabled = false
        var binlogFormat: String? = null
        var binlogRowImage: String? = null
        var hasReplicationPriv = false
        var currentFile: String? = null
        var currentPosition: Long? = null

        try {
            // 检查 binlog 是否开启
            conn.createStatement().use { stmt ->
                stmt.executeQuery("SHOW VARIABLES LIKE 'log_bin'").use { rs ->
                    if (rs.next()) {
                        binlogEnabled = rs.getString("Value").equals("ON", ignoreCase = true)
                    }
                }
            }
            if (!binlogEnabled) {
                issues.add("Binlog 未开启，请在 MySQL 配置中添加 log_bin = mysql-bin 并重启")
            }

            // 检查 binlog_format
            conn.createStatement().use { stmt ->
                stmt.executeQuery("SHOW VARIABLES LIKE 'binlog_format'").use { rs ->
                    if (rs.next()) {
                        binlogFormat = rs.getString("Value")
                        if (!binlogFormat.equals("ROW", ignoreCase = true)) {
                            issues.add("binlog_format 应为 ROW，当前为 $binlogFormat")
                        }
                    }
                }
            }

            // 检查 binlog_row_image
            conn.createStatement().use { stmt ->
                stmt.executeQuery("SHOW VARIABLES LIKE 'binlog_row_image'").use { rs ->
                    if (rs.next()) {
                        binlogRowImage = rs.getString("Value")
                        if (!binlogRowImage.equals("FULL", ignoreCase = true)) {
                            issues.add("binlog_row_image 建议设置为 FULL，当前为 $binlogRowImage")
                        }
                    }
                }
            }

            // 检查当前 binlog 位置
            conn.createStatement().use { stmt ->
                stmt.executeQuery("SHOW MASTER STATUS").use { rs ->
                    if (rs.next()) {
                        currentFile = rs.getString("File")
                        currentPosition = rs.getLong("Position")
                    }
                }
            }

            // 检查 REPLICATION 权限
            conn.createStatement().use { stmt ->
                stmt.executeQuery("SHOW GRANTS FOR CURRENT_USER()").use { rs ->
                    while (rs.next()) {
                        val grant = rs.getString(1).uppercase()
                        if (grant.contains("REPLICATION SLAVE") || grant.contains("ALL PRIVILEGES")) {
                            hasReplicationPriv = true
                        }
                    }
                }
            }
            if (!hasReplicationPriv) {
                issues.add("当前用户缺少 REPLICATION SLAVE 权限")
            }

        } catch (e: Exception) {
            issues.add("检查失败: ${e.message}")
        }

        return TrackerServerCheck(
            compatible = binlogEnabled && binlogFormat.equals("ROW", ignoreCase = true) && hasReplicationPriv,
            binlogEnabled = binlogEnabled,
            binlogFormat = binlogFormat,
            binlogRowImage = binlogRowImage,
            hasReplicationPrivilege = hasReplicationPriv,
            currentFile = currentFile,
            currentPosition = currentPosition,
            issues = issues
        )
    }

    override fun getActiveSessions(): List<TrackerSessionStatus> {
        return sessions.values.map { session ->
            TrackerSessionStatus(
                sessionId = session.sessionId,
                connectionId = session.connectionId,
                status = session.status,
                currentFile = session.lastProcessedFile ?: session.client.binlogFilename,
                currentPosition = if (session.lastProcessedPosition > 0) session.lastProcessedPosition else session.client.binlogPosition,
                eventCount = session.eventCount.get(),
                startedAt = session.startedAt,
                errorMessage = session.errorMessage,
                database = session.config.database
            )
        }
    }

    override fun listBinlogFiles(session: DatabaseSession): List<BinlogFileInfo> {
        val conn = (session as MysqlDatabaseSession).connection
        val files = mutableListOf<BinlogFileInfo>()
        try {
            conn.createStatement().use { stmt ->
                stmt.executeQuery("SHOW BINARY LOGS").use { rs ->
                    while (rs.next()) {
                        files.add(
                            BinlogFileInfo(
                                file = rs.getString("Log_name"),
                                size = rs.getLong("File_size"),
                                encrypted = try { rs.getString("Encrypted") } catch (_: Exception) { null }
                            )
                        )
                    }
                }
            }
        } catch (e: Exception) {
            logger.error("Failed to list binlog files: ${e.message}")
        }
        return files
    }

    /**
     * 比较两个 binlog 文件名的顺序
     * mysql-bin.000001 < mysql-bin.000002
     */
    private fun compareBinlogFiles(file1: String?, file2: String?): Int {
        if (file1 == null || file2 == null) return 0
        val num1 = file1.substringAfterLast('.').toLongOrNull() ?: 0
        val num2 = file2.substringAfterLast('.').toLongOrNull() ?: 0
        return num1.compareTo(num2)
    }

    // ─── 内部事件处理 ────────────────────────────────────────

    private fun handleBinlogEvent(event: Event, session: TrackerSession) {
        if (session.status != "running") return // 防止 client 关闭后继续推送幽灵事件

        val header = event.getHeader<EventHeaderV4>()
        val currentFile = session.client.binlogFilename

        // Replay 模式：检查是否已达截止位点
        if (session.config.mode == "replay") {
            val endFile = session.config.endFile            // 如果已经标记为到达截止文件，但当前文件被重置（可能发生了文件切换），立即停止
            if (session.reachedEndFile) {
                val fileCmp = compareBinlogFiles(currentFile, session.config.endFile)
                if (fileCmp != 0) {
                    logger.info("[Tracker:${session.sessionId}] Replay completed, file switched from ${session.config.endFile} to $currentFile, stopping")
                    session.status = "completed"
                    emitCompletionAndDisconnect(session)
                    return
                }
            }

            // 如果指定了截止文件，进行判断
            if (endFile != null) {
                val fileCmp = compareBinlogFiles(currentFile, endFile)

                when {
                    // 当前文件已超过截止文件：立即停止
                    fileCmp > 0 -> {
                        logger.info("[Tracker:${session.sessionId}] Replay passed end file $endFile (current: $currentFile), stopping")
                        session.status = "completed"
                        emitCompletionAndDisconnect(session)
                        return
                    }
                    // 当前文件等于截止文件：检查位置或标记已达截止文件
                    fileCmp == 0 -> {
                        session.reachedEndFile = true  // 标记已达到截止文件

                        val endPos = session.config.endPosition
                        val currentPos = header.position
                        if (endPos != null) {
                            if (currentPos >= endPos) {
                                logger.info("[Tracker:${session.sessionId}] Replay reached end position $endFile:$endPos (current: $currentPos), stopping")
                                session.status = "completed"
                                emitCompletionAndDisconnect(session)
                                return
                            }
                        }
                        // 未指定 endPosition 的情况：继续处理该文件的所有事件
                        // 当下一个事件到来时，如果文件切换，会在上面的 reachedEndFile 检测中停止
                    }
                    // 当前文件小于截止文件：继续正常处理
                    else -> { /* continue */ }
                }
            }
            // endFile == null：未指定截止位点，继续（实时模式）
        }

        when (header.eventType) {
            // TABLE_MAP: 建立 tableId <-> tableName 映射
            EventType.TABLE_MAP -> {
                val data = event.getData<TableMapEventData>()

                // 内核级白名单过滤（最早阶段）：targetTables 非空时，只登记白名单内的表。
                // 未登记的表在后续 ROW 事件中 tableMapCache[tableId] 返回 null 直接 return，零解析开销。
                val targetTables = session.config.targetTables
                if (targetTables.isNotEmpty() && data.table !in targetTables) {
                    return  // 不记录此表的 tableId，后续 ROW 事件自动丢弃
                }

                session.tableMapCache[data.tableId] = Pair(data.database, data.table)
                // 预加载列名
                val key = "${data.database}.${data.table}"
                if (!session.columnCache.containsKey(key)) {
                    loadColumnNames(session, data.database, data.table)
                }
            }

            // INSERT
            EventType.WRITE_ROWS, EventType.EXT_WRITE_ROWS -> {
                val data = event.getData<WriteRowsEventData>()
                val tableInfo = session.tableMapCache[data.tableId] ?: return
                if (!matchesFilter(session, tableInfo.first, tableInfo.second, "INSERT")) return

                val columns = getColumnNames(session, tableInfo.first, tableInfo.second)
                val rows = data.rows.map { row -> rowToMap(columns, row) }

                val changeEvent = ChangeEvent(
                    id = UUID.randomUUID().toString(),
                    timestamp = header.timestamp,
                    database = tableInfo.first,
                    table = tableInfo.second,
                    eventType = "INSERT",
                    columns = columns,
                    rowsBefore = null,
                    rowsAfter = rows,
                    rowCount = rows.size,
                    sourceInfo = ChangeEventSource(
                        type = "mysql_binlog",
                        file = currentFile,
                        position = header.position,
                        serverId = header.serverId
                    )
                )

                session.lastProcessedFile = currentFile
                session.lastProcessedPosition = header.position
                emitEvent(session, changeEvent)
            }

            // UPDATE
            EventType.UPDATE_ROWS, EventType.EXT_UPDATE_ROWS -> {
                val data = event.getData<UpdateRowsEventData>()
                val tableInfo = session.tableMapCache[data.tableId] ?: return
                if (!matchesFilter(session, tableInfo.first, tableInfo.second, "UPDATE")) return

                val columns = getColumnNames(session, tableInfo.first, tableInfo.second)
                val beforeRows = data.rows.map { entry -> rowToMap(columns, entry.key) }
                val afterRows = data.rows.map { entry -> rowToMap(columns, entry.value) }

                val changeEvent = ChangeEvent(
                    id = UUID.randomUUID().toString(),
                    timestamp = header.timestamp,
                    database = tableInfo.first,
                    table = tableInfo.second,
                    eventType = "UPDATE",
                    columns = columns,
                    rowsBefore = beforeRows,
                    rowsAfter = afterRows,
                    rowCount = data.rows.size,
                    sourceInfo = ChangeEventSource(
                        type = "mysql_binlog",
                        file = currentFile,
                        position = header.position,
                        serverId = header.serverId
                    )
                )

                session.lastProcessedFile = currentFile
                session.lastProcessedPosition = header.position
                emitEvent(session, changeEvent)
            }

            // DELETE
            EventType.DELETE_ROWS, EventType.EXT_DELETE_ROWS -> {
                val data = event.getData<DeleteRowsEventData>()
                val tableInfo = session.tableMapCache[data.tableId] ?: return
                if (!matchesFilter(session, tableInfo.first, tableInfo.second, "DELETE")) return

                val columns = getColumnNames(session, tableInfo.first, tableInfo.second)
                val rows = data.rows.map { row -> rowToMap(columns, row) }

                val changeEvent = ChangeEvent(
                    id = UUID.randomUUID().toString(),
                    timestamp = header.timestamp,
                    database = tableInfo.first,
                    table = tableInfo.second,
                    eventType = "DELETE",
                    columns = columns,
                    rowsBefore = rows,
                    rowsAfter = null,
                    rowCount = rows.size,
                    sourceInfo = ChangeEventSource(
                        type = "mysql_binlog",
                        file = currentFile,
                        position = header.position,
                        serverId = header.serverId
                    )
                )

                session.lastProcessedFile = currentFile
                session.lastProcessedPosition = header.position
                emitEvent(session, changeEvent)
            }

            // XID: 事务提交（DML 事务的结束标志）
            EventType.XID -> {
                // XID 事件标志事务已提交，清除当前事务 ID
                session.currentTransactionId = null
            }

            // QUERY: DDL 或事务边界
            EventType.QUERY -> {
                val data = event.getData<QueryEventData>()
                val sql = data.sql?.trim()?.uppercase()
                if (sql == "BEGIN") {
                    // 新事务开始，生成一个新的事务 ID
                    session.currentTransactionId = UUID.randomUUID().toString().substring(0, 8)
                }
                // 其他 DDL 语句（CREATE/ALTER/DROP 等）暂不处理
            }

            else -> { /* 忽略其他事件类型 */ }
        }
    }

    private fun matchesFilter(session: TrackerSession, database: String, table: String, type: String): Boolean {
        val config = session.config
        // 数据库过滤
        if (!config.database.isNullOrBlank() && config.database != database) return false
        // 表过滤
        if (config.filterTables.isNotEmpty() && table !in config.filterTables) return false
        // 类型过滤
        if (config.filterTypes.isNotEmpty() && type !in config.filterTypes) return false
        return true
    }

    private fun emitEvent(session: TrackerSession, event: ChangeEvent) {
        // 裁剪行数据：每条事件最多保留 10 行详情，减少内存占用
        var trimmed = if (event.rowCount > MAX_ROWS_PER_EVENT) {
            event.copy(
                rowsBefore = event.rowsBefore?.take(MAX_ROWS_PER_EVENT),
                rowsAfter = event.rowsAfter?.take(MAX_ROWS_PER_EVENT)
            )
        } else event

        // 注入事务 ID
        val txId = session.currentTransactionId
        if (txId != null) {
            trimmed = trimmed.copy(transactionId = txId)
        }

        // 存入全量存储（不再推送完整事件到 SSE）
        val stored = session.eventStore.add(trimmed)
        if (stored) {
            session.eventCount.incrementAndGet()
            session.rateCounter.incrementAndGet()
            session.latestEventId = trimmed.id
        }
        // tick 通知由定时器每秒发送，此处无需操作
    }

    /**
     * 发送完成通知并断开连接
     */
    private fun emitCompletionAndDisconnect(session: TrackerSession) {
        session.tickFlow.tryEmit(SseTick(
            type = "completed",
            totalCount = session.eventCount.get(),
            rate = 0,
            latestId = session.latestEventId,
            message = "回放完成，共 ${session.eventCount.get()} 条事件"
        ))
        Thread {
            try { session.client.disconnect() } catch (_: Exception) {}
        }.start()
    }

    companion object {
        private const val MAX_ROWS_PER_EVENT = 10
    }

    private fun getColumnNames(session: TrackerSession, database: String, table: String): List<String> {
        val key = "$database.$table"
        return session.columnCache.getOrPut(key) {
            loadColumnNames(session, database, table)
        }
    }

    /**
     * 从 INFORMATION_SCHEMA 加载列名
     * binlog 事件只有列值（按序号），不包含列名
     */
    private fun loadColumnNames(session: TrackerSession, database: String, table: String): List<String> {
        val columns = mutableListOf<String>()
        try {
            val conn = (session.dbSession as MysqlDatabaseSession).connection
            conn.prepareStatement("""
                SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                ORDER BY ORDINAL_POSITION
            """.trimIndent()).use { stmt ->
                stmt.setString(1, database)
                stmt.setString(2, table)
                stmt.executeQuery().use { rs ->
                    while (rs.next()) {
                        columns.add(rs.getString("COLUMN_NAME"))
                    }
                }
            }
        } catch (e: Exception) {
            logger.warn("Failed to load columns for $database.$table: ${e.message}")
        }
        val key = "$database.$table"
        session.columnCache[key] = columns
        return columns
    }

    /**
     * 将 binlog 行数据（Serializable[] 数组）转换为 Map<列名, 值>
     */
    private fun rowToMap(columns: List<String>, row: Array<Serializable?>): Map<String, String?> {
        val map = LinkedHashMap<String, String?>()
        for (i in columns.indices) {
            val value = if (i < row.size) row[i] else null
            map[columns[i]] = when (value) {
                null -> null
                is ByteArray -> {
                    // 尝试作为 UTF-8 字符串，失败则用十六进制
                    try {
                        String(value, Charsets.UTF_8).let {
                            if (it.any { c -> c.code < 32 && c != '\n' && c != '\r' && c != '\t' }) {
                                "0x${value.joinToString("") { b -> "%02X".format(b) }}"
                            } else it
                        }
                    } catch (e: Exception) {
                        "0x${value.joinToString("") { b -> "%02X".format(b) }}"
                    }
                }
                is java.util.Date -> {
                    val instant = Instant.ofEpochMilli(value.time)
                    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
                        .withZone(ZoneId.systemDefault())
                        .format(instant)
                }
                else -> value.toString()
            }
        }
        return map
    }
}
