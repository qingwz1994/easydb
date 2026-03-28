package com.easydb.drivers.mysql

import com.easydb.common.*
import java.sql.ResultSet
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers

/**
 * MySQL 迁移适配器
 * 实现 MySQL → MySQL 同构迁移：DDL 复制 + 批量数据 INSERT
 */
class MysqlMigrationAdapter : MigrationAdapter {

    private val dialect = MysqlDialectAdapter()
    private val metadata = MysqlMetadataAdapter()

    override fun preview(config: MigrationConfig, sessions: SessionPair): MigrationPreview {
        val tables = metadata.listTables(sessions.source, config.sourceDatabase)
            .filter { it.type == "table" }
            .filter { config.tables.isEmpty() || config.tables.contains(it.name) }

        val previews = tables.map { table ->
            val hasStructure = config.mode != "data_only"
            val hasData = config.mode != "structure_only"

            // 检查目标是否已存在同名表
            val targetTables = try {
                metadata.listTables(sessions.target, config.targetDatabase).map { it.name }
            } catch (_: Exception) { emptyList() }

            val risk = if (targetTables.contains(table.name) && hasStructure) {
                "目标库已存在同名表 ${table.name}，将被覆盖"
            } else null

            MigrationTablePreview(
                tableName = table.name,
                rowCount = table.rowCount,
                hasStructure = hasStructure,
                hasData = hasData,
                risk = risk
            )
        }

        val warnings = previews.mapNotNull { it.risk }

        return MigrationPreview(
            totalTables = previews.size,
            totalRows = previews.sumOf { it.rowCount ?: 0L },
            tables = previews,
            warnings = warnings
        )
    }

    override fun execute(
        config: MigrationConfig,
        sessions: SessionPair,
        reporter: TaskReporter
    ): TaskResult {
        val sourceSession = sessions.source as MysqlDatabaseSession
        val targetSession = sessions.target as MysqlDatabaseSession
        val sourceConn = sourceSession.connection
        val targetConn = targetSession.connection

        val tables = metadata.listTables(sessions.source, config.sourceDatabase)
            .filter { it.type == "table" }
            .filter { config.tables.isEmpty() || config.tables.contains(it.name) }

        if (tables.isEmpty()) {
            return TaskResult(success = true, successCount = 0)
        }

        var successCount = 0
        var failureCount = 0
        val totalTables = tables.size
        val tableRowCounts = mutableMapOf<String, Long>()  // 表名 → 实际写入行数
        val tableErrors = mutableMapOf<String, String>()    // 表名 → 失败原因

        reporter.onLog("INFO", "开始迁移：${config.sourceDatabase} → ${config.targetDatabase}，共 $totalTables 张表")

        // 禁用外键检查和唯一性检查，避免因表依赖顺序或约束冲突导致插入失败
        targetConn.createStatement().use { it.execute("SET FOREIGN_KEY_CHECKS=0") }
        targetConn.createStatement().use { it.execute("SET UNIQUE_CHECKS=0") }

        // 源库和目标库的全限定前缀（关键：避免源目标共用同一连接时 USE 互相覆盖）
        val sourcePrefix = "${dialect.quoteIdentifier(config.sourceDatabase)}."
        val targetPrefix = "${dialect.quoteIdentifier(config.targetDatabase)}."

        for ((index, table) in tables.withIndex()) {
            if (reporter.isCancelled()) {
                reporter.onLog("WARN", "迁移已被取消")
                break
            }

            val tableName = table.name
            val progress = (((index + 1).toDouble() / totalTables) * 100).toInt().coerceAtMost(99)
            reporter.onProgress(progress, "迁移表 $tableName (${ index + 1}/$totalTables)")

            try {
                // 步骤 1：迁移结构
                if (config.mode != "data_only") {
                    reporter.onStep(tableName, TaskStatus.RUNNING, "迁移结构")
                    migrateStructure(sourceConn, targetConn, sourcePrefix, targetPrefix, tableName)
                    reporter.onLog("INFO", "[$tableName] 结构迁移完成")
                }

                // 步骤 2：迁移数据
                if (config.mode != "structure_only") {
                    // data_only 模式下先清空目标表，避免主键冲突
                    if (config.mode == "data_only") {
                        val fullTarget = "$targetPrefix${dialect.quoteIdentifier(tableName)}"
                        targetConn.createStatement().use { it.execute("TRUNCATE TABLE $fullTarget") }
                        reporter.onLog("INFO", "[$tableName] 已清空目标表数据")
                    }
                    reporter.onStep(tableName, TaskStatus.RUNNING, "迁移数据")
                    val rowCount = migrateData(sourceConn, targetConn, sourcePrefix, targetPrefix, tableName)
                    tableRowCounts[tableName] = rowCount
                    reporter.onLog("INFO", "[$tableName] 数据迁移完成，共 $rowCount 行")
                } else {
                    tableRowCounts[tableName] = 0L
                }

                reporter.onStep(tableName, TaskStatus.COMPLETED)
                successCount++
            } catch (e: Exception) {
                tableRowCounts[tableName] = 0L
                tableErrors[tableName] = e.message ?: "未知错误"
                failureCount++
                reporter.onStep(tableName, TaskStatus.FAILED, e.message)
                reporter.onLog("ERROR", "[$tableName] 迁移失败：${e.message}")
            }
        }

        // 恢复外键检查和唯一性检查
        try {
            targetConn.createStatement().use { it.execute("SET FOREIGN_KEY_CHECKS=1") }
            targetConn.createStatement().use { it.execute("SET UNIQUE_CHECKS=1") }
        } catch (_: Exception) {
            reporter.onLog("WARN", "恢复外键/唯一性检查设置失败")
        }

        // ─── 数据验证（迁移后精确对比：COUNT(*) 查目标表实际行数）───
        reporter.onLog("INFO", "开始数据验证，对比 ${tableRowCounts.size} 张表...")
        val verification = buildVerification(
            targetConn, config.targetDatabase, tableRowCounts, tableErrors, reporter
        )
        val matchCount = verification.count { it.status == "match" }
        val mismatchCount = verification.count { it.status == "mismatch" }
        val failedCount2 = verification.count { it.status == "failed" }
        reporter.onLog("INFO", "数据验证完成：匹配 $matchCount，不匹配 $mismatchCount，失败 $failedCount2")

        reporter.onProgress(100, "迁移完成")
        reporter.onLog("INFO", "迁移结束：成功 $successCount，失败 $failureCount")

        return TaskResult(
            success = failureCount == 0,
            successCount = successCount,
            failureCount = failureCount,
            errorMessage = if (failureCount > 0) "部分表迁移失败" else null,
            verification = verification
        )
    }

    // ─── 私有方法 ─────────────────────────────────────────────

    /**
     * 迁移表结构：获取源表 DDL → 在目标库执行
     */
    private fun migrateStructure(
        sourceConn: java.sql.Connection,
        targetConn: java.sql.Connection,
        sourcePrefix: String,
        targetPrefix: String,
        tableName: String
    ) {
        val quotedTable = dialect.quoteIdentifier(tableName)

        // 先在目标库删除同名表（使用全限定名）
        targetConn.createStatement().use {
            it.execute("DROP TABLE IF EXISTS $targetPrefix$quotedTable")
        }

        // 获取源表 DDL（使用全限定名）
        var ddl = sourceConn.createStatement().use { stmt ->
            stmt.executeQuery("SHOW CREATE TABLE $sourcePrefix$quotedTable").use { rs ->
                if (rs.next()) rs.getString(2) else throw Exception("无法获取 $tableName 的 DDL")
            }
        }

        // 清理 DDL 中的 AUTO_INCREMENT=N，避免目标表自增值被源表覆盖
        ddl = ddl.replace(Regex("""\s*AUTO_INCREMENT=\d+"""), "")

        // 在目标库上下文中执行 DDL：先切到目标库再执行
        targetConn.createStatement().use { it.execute("USE ${targetPrefix.removeSuffix(".")}") }
        targetConn.createStatement().use { it.execute(ddl) }
    }

    /**
     * 迁移数据：SELECT * → 批量 INSERT
     * 使用全限定表名，确保源目标不混淆
     * 使用 PreparedStatement + batch，每 1000 行提交一次
     */
    private fun migrateData(
        sourceConn: java.sql.Connection,
        targetConn: java.sql.Connection,
        sourcePrefix: String,
        targetPrefix: String,
        tableName: String
    ): Long {
        val quotedTable = dialect.quoteIdentifier(tableName)
        val fullSourceTable = "$sourcePrefix$quotedTable"
        val fullTargetTable = "$targetPrefix$quotedTable"
        val batchSize = 1000
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
        val insertSql = "INSERT INTO $fullTargetTable ($colsStr) VALUES ($placeholders)"

        // 引入协程 Channel 构建背压管道 (容量=2 意味着内存最多缓冲 2 个批次的数据，彻底杜绝 OOM)
        val channel = Channel<List<Array<Any?>>>(capacity = 2)

        runBlocking {
            // 消费者协程：负责不断从 Channel 取数据并写入目标库
            launch(Dispatchers.IO) {
                targetConn.autoCommit = false
                try {
                    targetConn.prepareStatement(insertSql).use { ps ->
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
     * sourceRows = 迁移过程中从源表实际读取的行数（精确值）
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
                targetRows < 0L -> "failed"
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
