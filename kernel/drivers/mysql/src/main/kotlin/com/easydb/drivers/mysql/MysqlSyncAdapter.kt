package com.easydb.drivers.mysql

import com.easydb.common.*
import java.sql.ResultSet
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers

/**
 * MySQL 同步适配器
 * 实现 MySQL → MySQL 同构表级数据同步
 *
 * 性能优化要点：
 * 1. 首次导入（目标表不存在/为空）使用 INSERT INTO，避免不必要的冲突检测
 * 2. 增量同步使用 INSERT ... ON DUPLICATE KEY UPDATE
 * 3. 会话级禁用 UNIQUE_CHECKS 和 FOREIGN_KEY_CHECKS
 * 4. 动态 batch size（普通表 5000，大表 10000）
 * 5. 使用全限定表名避免 USE 语句互相覆盖
 */
class MysqlSyncAdapter : SyncAdapter {

    private val dialect = MysqlDialectAdapter()
    private val metadata = MysqlMetadataAdapter()

    companion object {
        private const val DEFAULT_BATCH_SIZE = 5000
        private const val LARGE_TABLE_BATCH_SIZE = 10000
        private const val LARGE_TABLE_ROW_THRESHOLD = 100_000L
    }

    override fun preview(config: SyncConfig, sessions: SessionPair): SyncPreview {
        val allObjects = getAllSyncObjects(sessions.source, config.sourceDatabase)
            .filter { config.tables.isEmpty() || config.tables.contains(it.name) }

        val targetTableNames = try {
            metadata.listTables(sessions.target, config.targetDatabase).map { it.name }
        } catch (_: Exception) { emptyList() }

        val previews = allObjects.map { obj ->
            if (obj.type == "table") {
                val existsInTarget = targetTableNames.contains(obj.name)
                SyncTablePreview(
                    tableName = obj.name,
                    insertCount = if (!existsInTarget) (obj.rowCount?.toInt() ?: 0) else 0,
                    updateCount = if (existsInTarget) (obj.rowCount?.toInt() ?: 0) else 0,
                    canSync = true,
                    reason = if (!existsInTarget) "目标表不存在，将自动创建" else null
                )
            } else {
                SyncTablePreview(
                    tableName = obj.name,
                    insertCount = 0,
                    updateCount = 0,
                    canSync = true,
                    reason = "${getTypeLabel(obj.type)}：覆盖式同步定义"
                )
            }
        }

        val warnings = previews.filter { it.reason != null }.map { "${it.tableName}：${it.reason}" }

        return SyncPreview(
            totalTables = previews.size,
            tables = previews,
            warnings = warnings
        )
    }

    override fun execute(
        config: SyncConfig,
        sessions: SessionPair,
        reporter: TaskReporter
    ): TaskResult {
        val sourceSession = sessions.source as MysqlDatabaseSession
        val targetSession = sessions.target as MysqlDatabaseSession
        val sourceConn = sourceSession.connection
        val targetConn = targetSession.connection

        val allObjects = getAllSyncObjects(sessions.source, config.sourceDatabase)
            .filter { config.tables.isEmpty() || config.tables.contains(it.name) }
        val tables = allObjects.filter { it.type == "table" }
        val nonTableObjects = allObjects.filter { it.type != "table" }

        if (allObjects.isEmpty()) {
            return TaskResult(success = true, successCount = 0)
        }

        var successCount = 0
        var failureCount = 0
        val totalObjects = allObjects.size
        val tableRowCounts = mutableMapOf<String, Long>()
        val tableErrors = mutableMapOf<String, String>()

        val sourcePrefix = "${dialect.quoteIdentifier(config.sourceDatabase)}."
        val targetPrefix = "${dialect.quoteIdentifier(config.targetDatabase)}."

        reporter.onLog("INFO", "开始同步：${config.sourceDatabase} → ${config.targetDatabase}，共 $totalObjects 个对象（表 ${tables.size} / 其他 ${nonTableObjects.size}）")

        // ─── 会话级 bulk load 优化 ─────────────────────────────
        applyBulkLoadSettings(targetConn, reporter)

        try {
            // 先同步表数据
            for ((index, table) in tables.withIndex()) {
                if (reporter.isCancelled()) {
                    reporter.onLog("WARN", "同步已被取消")
                    break
                }

                val tableName = table.name
                val progress = ((index.toDouble() / totalObjects) * 100).toInt().coerceAtMost(99)
                reporter.onProgress(progress, "同步表 $tableName (${index + 1}/$totalObjects)")

                try {
                    reporter.onStep(tableName, TaskStatus.RUNNING, "同步中")

                    val tableCreated = ensureTargetTable(sourceConn, targetConn, sourcePrefix, targetPrefix, tableName)

                    val isLargeTable = (table.rowCount ?: 0) > LARGE_TABLE_ROW_THRESHOLD
                    val batchSize = if (isLargeTable) LARGE_TABLE_BATCH_SIZE else DEFAULT_BATCH_SIZE
                    val useInsert = tableCreated || isTargetTableEmpty(targetConn, targetPrefix, tableName)

                    if (isLargeTable) {
                        reporter.onLog("INFO", "[$tableName] 大表模式：预估 ${table.rowCount} 行，batch=$batchSize")
                    }

                    val rowCount = syncTableData(
                        sourceConn, targetConn,
                        sourcePrefix, targetPrefix,
                        tableName, useInsert, batchSize, reporter
                    )

                    tableRowCounts[tableName] = rowCount
                    reporter.onStep(tableName, TaskStatus.COMPLETED, "同步 $rowCount 行")
                    reporter.onLog("INFO", "[$tableName] 同步完成，共 $rowCount 行${if (useInsert) "（INSERT）" else "（UPSERT）"}")
                    successCount++
                } catch (e: Exception) {
                    tableRowCounts[tableName] = 0L
                    tableErrors[tableName] = e.message ?: "未知错误"
                    failureCount++
                    reporter.onStep(tableName, TaskStatus.FAILED, e.message)
                    reporter.onLog("ERROR", "[$tableName] 同步失败：${e.message}")
                }
            }

            // 再同步非表对象（覆盖式：DROP IF EXISTS + CREATE）
            for ((idx, obj) in nonTableObjects.withIndex()) {
                if (reporter.isCancelled()) break
                val objName = obj.name
                val progress = (((tables.size + idx + 1).toDouble() / totalObjects) * 100).toInt().coerceAtMost(99)
                reporter.onProgress(progress, "同步${getTypeLabel(obj.type)} $objName")
                try {
                    reporter.onStep(objName, TaskStatus.RUNNING, "同步${getTypeLabel(obj.type)}定义")
                    syncNonTableObject(sessions.source, targetConn, config.sourceDatabase, config.targetDatabase, objName, obj.type)
                    reporter.onStep(objName, TaskStatus.COMPLETED, "定义已同步")
                    reporter.onLog("INFO", "[$objName] ${getTypeLabel(obj.type)}定义同步完成")
                    successCount++
                } catch (e: Exception) {
                    failureCount++
                    tableErrors[objName] = e.message ?: "未知错误"
                    reporter.onStep(objName, TaskStatus.FAILED, e.message)
                    reporter.onLog("ERROR", "[$objName] 同步失败：${e.message}")
                }
            }
        } finally {
            // ─── 恢复会话设置 ─────────────────────────────────────
            restoreSessionSettings(targetConn, reporter)
        }

        // ─── 数据验证（迁移后精确对比：COUNT(*) 查目标表实际行数）───
        reporter.onLog("INFO", "开始数据验证，对比 ${tableRowCounts.size} 张表...")
        val verification = buildVerification(
            targetConn, config.targetDatabase, tableRowCounts, tableErrors, reporter
        )
        val matchCount = verification.count { it.status == "match" }
        val mismatchCount = verification.count { it.status == "mismatch" }
        val failedCount = verification.count { it.status == "failed" }
        reporter.onLog("INFO", "数据验证完成：匹配 $matchCount，不匹配 $mismatchCount，失败 $failedCount")

        reporter.onProgress(100, "同步完成")
        reporter.onLog("INFO", "同步结束：成功 $successCount，失败 $failureCount")

        return TaskResult(
            success = failureCount == 0,
            successCount = successCount,
            failureCount = failureCount,
            errorMessage = if (failureCount > 0) "部分对象同步失败" else null,
            verification = verification
        )
    }

    // ─── 私有方法 ─────────────────────────────────────────────

    /**
     * 获取全部可同步对象（表+视图+存储过程+函数+触发器）
     */
    private fun getAllSyncObjects(session: DatabaseSession, database: String): List<TableInfo> {
        val tables = metadata.listTables(session, database)
        val routines = metadata.listRoutines(session, database)
        val triggers = metadata.listTriggers(session, database)

        val routineInfos = routines.map { r ->
            TableInfo(name = r.name, schema = database, type = r.type.lowercase(), comment = r.comment)
        }
        val triggerInfos = triggers.map { t ->
            TableInfo(name = t.name, schema = database, type = "trigger", comment = "${t.timing} ${t.event} ON ${t.table}")
        }

        return tables + routineInfos + triggerInfos
    }

    /**
     * 同步非表对象：DROP IF EXISTS + 重建 DDL
     */
    private fun syncNonTableObject(
        sourceSession: DatabaseSession,
        targetConn: java.sql.Connection,
        sourceDatabase: String,
        targetDatabase: String,
        name: String,
        type: String
    ) {
        val ddl = metadata.getObjectDdl(sourceSession, sourceDatabase, name, type)
        if (ddl.isBlank()) throw Exception("无法获取 $name 的 DDL")

        val quotedName = dialect.quoteIdentifier(name)
        val targetDbQuoted = dialect.quoteIdentifier(targetDatabase)

        targetConn.createStatement().use { it.execute("USE $targetDbQuoted") }

        val dropSql = when (type) {
            "view" -> "DROP VIEW IF EXISTS $quotedName"
            "procedure" -> "DROP PROCEDURE IF EXISTS $quotedName"
            "function" -> "DROP FUNCTION IF EXISTS $quotedName"
            "trigger" -> "DROP TRIGGER IF EXISTS $quotedName"
            else -> throw Exception("不支持的对象类型：$type")
        }
        targetConn.createStatement().use { it.execute(dropSql) }

        var cleanedDdl = ddl
            .replace(Regex("""DEFINER\s*=\s*`[^`]*`@`[^`]*`\s*"""), "")
            .replace("`$sourceDatabase`.", "`$targetDatabase`.")

        if (type in listOf("trigger", "procedure", "function")) {
            cleanedDdl = cleanedDdl
                .replace(Regex("""/\*!\d+\s*"""), "")
                .replace(Regex("""\s*\*/"""), "")
            val createIdx = cleanedDdl.indexOf("CREATE", ignoreCase = true)
            if (createIdx > 0) {
                cleanedDdl = cleanedDdl.substring(createIdx)
            }
        }

        targetConn.createStatement().use { it.execute(cleanedDdl) }
    }

    private fun getTypeLabel(type: String): String = when (type) {
        "table" -> "表"
        "view" -> "视图"
        "procedure" -> "存储过程"
        "function" -> "函数"
        "trigger" -> "触发器"
        else -> type
    }

    /**
     * 启用 bulk load 会话优化
     */
    private fun applyBulkLoadSettings(conn: java.sql.Connection, reporter: TaskReporter) {
        try {
            conn.createStatement().use { it.execute("SET SESSION unique_checks = 0") }
            conn.createStatement().use { it.execute("SET SESSION foreign_key_checks = 0") }
            reporter.onLog("INFO", "已启用 bulk load 优化（unique_checks=0, foreign_key_checks=0）")
        } catch (e: Exception) {
            reporter.onLog("WARN", "启用 bulk load 设置失败：${e.message}")
        }
    }

    /**
     * 恢复会话设置
     */
    private fun restoreSessionSettings(conn: java.sql.Connection, reporter: TaskReporter) {
        try {
            conn.createStatement().use { it.execute("SET SESSION unique_checks = 1") }
            conn.createStatement().use { it.execute("SET SESSION foreign_key_checks = 1") }
            reporter.onLog("INFO", "已恢复会话设置")
        } catch (e: Exception) {
            reporter.onLog("WARN", "恢复会话设置失败：${e.message}")
        }
    }

    /**
     * 确保目标表存在，不存在则从源库复制 DDL
     * @return true 如果新建了表
     */
    private fun ensureTargetTable(
        sourceConn: java.sql.Connection,
        targetConn: java.sql.Connection,
        sourcePrefix: String,
        targetPrefix: String,
        tableName: String
    ): Boolean {
        val quotedTable = dialect.quoteIdentifier(tableName)

        // 检查目标表是否存在（使用全限定查询）
        val exists = targetConn.createStatement().use { stmt ->
            val dbName = targetPrefix.removeSuffix(".").removeSurrounding("`")
            stmt.executeQuery(
                "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$dbName' AND TABLE_NAME = '$tableName'"
            ).use { rs -> rs.next() && rs.getInt(1) > 0 }
        }

        if (!exists) {
            // 从源库获取 DDL 并在目标库创建
            val ddl = sourceConn.createStatement().use { stmt ->
                stmt.executeQuery("SHOW CREATE TABLE $sourcePrefix$quotedTable").use { rs ->
                    if (rs.next()) rs.getString(2)
                    else throw Exception("无法获取 $tableName 的 DDL")
                }
            }
            // 切到目标库上下文执行 DDL
            targetConn.createStatement().use { it.execute("USE ${targetPrefix.removeSuffix(".")}") }
            targetConn.createStatement().use { it.execute(ddl) }
            return true
        }
        return false
    }

    /**
     * 检查目标表是否为空
     */
    private fun isTargetTableEmpty(
        targetConn: java.sql.Connection,
        targetPrefix: String,
        tableName: String
    ): Boolean {
        val quotedTable = dialect.quoteIdentifier(tableName)
        return targetConn.createStatement().use { stmt ->
            stmt.executeQuery("SELECT COUNT(*) FROM $targetPrefix$quotedTable LIMIT 1").use { rs ->
                rs.next() && rs.getLong(1) == 0L
            }
        }
    }

    private fun syncTableData(
        sourceConn: java.sql.Connection,
        targetConn: java.sql.Connection,
        sourcePrefix: String,
        targetPrefix: String,
        tableName: String,
        useInsert: Boolean,
        batchSize: Int,
        reporter: TaskReporter
    ): Long {
        val quotedTable = dialect.quoteIdentifier(tableName)
        val fullSourceTable = "$sourcePrefix$quotedTable"
        val fullTargetTable = "$targetPrefix$quotedTable"
        var totalRows = 0L

        // 获取列元数据
        val columns = mutableListOf<String>()
        val timeColumns = mutableSetOf<Int>()
        var columnCount = 0

        sourceConn.createStatement().use { stmt ->
            stmt.executeQuery("SELECT * FROM $fullSourceTable LIMIT 0").use { rs ->
                val meta = rs.metaData
                columnCount = meta.columnCount
                for (i in 1..columnCount) {
                    columns.add(meta.getColumnName(i))
                    if (meta.getColumnType(i) == java.sql.Types.TIME) {
                        timeColumns.add(i)
                    }
                }
            }
        }

        if (columns.isEmpty()) return 0L

        val colsStr = columns.joinToString(", ") { dialect.quoteIdentifier(it) }
        val placeholders = columns.joinToString(", ") { "?" }

        // 根据策略生成 SQL
        val sql = if (useInsert) {
            "INSERT INTO $fullTargetTable ($colsStr) VALUES ($placeholders)"
        } else {
            val updateCols = columns.joinToString(", ") {
                val quoted = dialect.quoteIdentifier(it)
                "$quoted = VALUES($quoted)"
            }
            "INSERT INTO $fullTargetTable ($colsStr) VALUES ($placeholders) ON DUPLICATE KEY UPDATE $updateCols"
        }

        // 引入协程 Channel 构建背压管道 (容量=2 意味着内存最多缓冲 2 个批次的数据)
        val channel = Channel<List<Array<Any?>>>(capacity = 2)

        runBlocking {
            // 消费者协程：负责不断从 Channel 取数据并写入目标库
            launch(Dispatchers.IO) {
                targetConn.autoCommit = false
                try {
                    targetConn.prepareStatement(sql).use { ps ->
                        for (batch in channel) {
                            for (row in batch) {
                                for (i in 0 until columnCount) {
                                    if ((i + 1) in timeColumns && row[i] is String) {
                                        ps.setString(i + 1, row[i] as String)
                                    } else {
                                        ps.setObject(i + 1, row[i])
                                    }
                                }
                                ps.addBatch()
                                totalRows++
                            }
                            ps.executeBatch()
                            targetConn.commit()
                            
                            // 大数据量定期报告进度
                            if (totalRows % (batchSize * 10) == 0L) {
                                reporter.onLog("INFO", "[$tableName] 已同步 $totalRows 行...")
                            }
                        }
                    }
                } finally {
                    targetConn.autoCommit = true
                }
            }

            // 生产者：当前线程作为生产者，流式读取源库并填入 Channel
            try {
                sourceConn.createStatement(
                    java.sql.ResultSet.TYPE_FORWARD_ONLY,
                    java.sql.ResultSet.CONCUR_READ_ONLY
                ).use { stmt ->
                    // MySQL 核心机制：强制触发真正的流式传输而不是全部装入 JVM 内存！
                    stmt.fetchSize = Integer.MIN_VALUE
                    stmt.executeQuery("SELECT * FROM $fullSourceTable").use { rs ->
                        var currentBatch = ArrayList<Array<Any?>>(batchSize)
                        while (rs.next()) {
                            val row = Array<Any?>(columnCount) { null }
                            for (i in 1..columnCount) {
                                if (i in timeColumns) {
                                    row[i - 1] = rs.getString(i)
                                } else {
                                    row[i - 1] = rs.getObject(i)
                                }
                            }
                            currentBatch.add(row)

                            if (currentBatch.size >= batchSize) {
                                // 背压阻塞点：如果消费者较慢，Channel 满时挂起协程，停止向 MySQL 请求新数据
                                channel.send(currentBatch)
                                currentBatch = ArrayList(batchSize)
                            }
                        }
                        // 发送最后遗留的批次
                        if (currentBatch.isNotEmpty()) {
                            channel.send(currentBatch)
                        }
                    }
                }
            } finally {
                channel.close() // 读取完毕，关闭管道通知消费者终止循环
            }
        }

        return totalRows
    }

    /**
     * 数据验证：对比源库实际读取行数与目标库精确行数
     * sourceRows = 同步过程中从源表实际读取的行数（精确值）
     * targetRows = 目标表 COUNT(*)（精确值，迁移后执行）
     */
    private fun buildVerification(
        targetConn: java.sql.Connection,
        targetDatabase: String,
        tableRowCounts: Map<String, Long>,
        tableErrors: Map<String, String>,
        reporter: TaskReporter
    ): List<TableVerifyResult> {
        val targetPrefix = dialect.quoteIdentifier(targetDatabase)

        return tableRowCounts.map { (tableName, sourceRows) ->
            val error = tableErrors[tableName]

            val targetRows = if (error != null) {
                0L // 失败的表不需要 COUNT
            } else {
                try {
                    targetConn.createStatement().use { stmt ->
                        stmt.executeQuery(
                            "SELECT COUNT(*) FROM $targetPrefix.${dialect.quoteIdentifier(tableName)}"
                        ).use { rs ->
                            if (rs.next()) rs.getLong(1) else 0L
                        }
                    }
                } catch (e: Exception) {
                    reporter.onLog("WARN", "[$tableName] COUNT(*) 查询失败：${e.message}")
                    -1L
                }
            }

            val status = when {
                error != null -> "failed"
                targetRows < 0L -> "failed" // COUNT 查询本身出错
                sourceRows == targetRows -> "match"
                else -> "mismatch"
            }

            TableVerifyResult(
                tableName = tableName,
                sourceRows = sourceRows,
                targetRows = if (targetRows < 0L) 0L else targetRows,
                status = status,
                errorMessage = error ?: if (targetRows < 0L) "验证查询失败" else null
            )
        }.sortedWith(compareBy(
            { if (it.status == "failed") 0 else if (it.status == "mismatch") 1 else 2 },
            { it.tableName }
        ))
    }
}
