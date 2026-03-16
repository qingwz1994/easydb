package com.easydb.drivers.mysql

import com.easydb.common.*

/**
 * MySQL 同步适配器
 * 实现 MySQL → MySQL 同构表级数据同步
 * 策略：REPLACE INTO（主键冲突时覆盖，不存在时插入）
 */
class MysqlSyncAdapter : SyncAdapter {

    private val dialect = MysqlDialectAdapter()
    private val metadata = MysqlMetadataAdapter()

    override fun preview(config: SyncConfig, sessions: SessionPair): SyncPreview {
        val sourceTables = metadata.listTables(sessions.source, config.sourceDatabase)
            .filter { it.type == "table" }
            .filter { config.tables.isEmpty() || config.tables.contains(it.name) }

        val targetTableNames = try {
            metadata.listTables(sessions.target, config.targetDatabase).map { it.name }
        } catch (_: Exception) { emptyList() }

        val previews = sourceTables.map { table ->
            val existsInTarget = targetTableNames.contains(table.name)
            SyncTablePreview(
                tableName = table.name,
                insertCount = if (!existsInTarget) (table.rowCount?.toInt() ?: 0) else 0,
                updateCount = if (existsInTarget) (table.rowCount?.toInt() ?: 0) else 0,
                canSync = true,
                reason = if (!existsInTarget) "目标表不存在，将自动创建" else null
            )
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

        val tables = metadata.listTables(sessions.source, config.sourceDatabase)
            .filter { it.type == "table" }
            .filter { config.tables.isEmpty() || config.tables.contains(it.name) }

        if (tables.isEmpty()) {
            return TaskResult(success = true, successCount = 0)
        }

        var successCount = 0
        var failureCount = 0
        val totalTables = tables.size

        reporter.onLog("INFO", "开始同步：${config.sourceDatabase} → ${config.targetDatabase}，共 $totalTables 张表")

        sourceConn.createStatement().use { it.execute("USE ${dialect.quoteIdentifier(config.sourceDatabase)}") }
        targetConn.createStatement().use { it.execute("USE ${dialect.quoteIdentifier(config.targetDatabase)}") }

        for ((index, table) in tables.withIndex()) {
            if (reporter.isCancelled()) {
                reporter.onLog("WARN", "同步已被取消")
                break
            }

            val tableName = table.name
            val progress = ((index.toDouble() / totalTables) * 100).toInt()
            reporter.onProgress(progress, "同步表 $tableName (${index + 1}/$totalTables)")

            try {
                reporter.onStep(tableName, TaskStatus.RUNNING, "同步中")

                // 确保目标表存在，不存在则从源复制结构
                ensureTargetTable(sourceConn, targetConn, config.sourceDatabase, tableName)

                // REPLACE INTO 同步数据
                val rowCount = syncTableData(sourceConn, targetConn, tableName)

                reporter.onStep(tableName, TaskStatus.COMPLETED, "同步 $rowCount 行")
                reporter.onLog("INFO", "[$tableName] 同步完成，共 $rowCount 行")
                successCount++
            } catch (e: Exception) {
                failureCount++
                reporter.onStep(tableName, TaskStatus.FAILED, e.message)
                reporter.onLog("ERROR", "[$tableName] 同步失败：${e.message}")
            }
        }

        reporter.onProgress(100, "同步完成")
        reporter.onLog("INFO", "同步结束：成功 $successCount，失败 $failureCount")

        return TaskResult(
            success = failureCount == 0,
            successCount = successCount,
            failureCount = failureCount,
            errorMessage = if (failureCount > 0) "部分表同步失败" else null
        )
    }

    // ─── 私有方法 ─────────────────────────────────────────────

    /**
     * 确保目标表存在，不存在则从源库复制 DDL
     */
    private fun ensureTargetTable(
        sourceConn: java.sql.Connection,
        targetConn: java.sql.Connection,
        sourceDatabase: String,
        tableName: String
    ) {
        val quotedTable = dialect.quoteIdentifier(tableName)

        // 检查目标表是否存在
        val exists = targetConn.createStatement().use { stmt ->
            stmt.executeQuery("SHOW TABLES LIKE '$tableName'").use { it.next() }
        }

        if (!exists) {
            // 从源库获取 DDL 并在目标库创建
            val ddl = sourceConn.createStatement().use { stmt ->
                stmt.executeQuery(
                    "SHOW CREATE TABLE ${dialect.quoteIdentifier(sourceDatabase)}.$quotedTable"
                ).use { rs ->
                    if (rs.next()) rs.getString(2)
                    else throw Exception("无法获取 $tableName 的 DDL")
                }
            }
            targetConn.createStatement().use { it.execute(ddl) }
        }
    }

    /**
     * 同步表数据：SELECT * → REPLACE INTO（主键冲突覆盖）
     */
    private fun syncTableData(
        sourceConn: java.sql.Connection,
        targetConn: java.sql.Connection,
        tableName: String
    ): Long {
        val quotedTable = dialect.quoteIdentifier(tableName)
        val batchSize = 1000
        var totalRows = 0L

        sourceConn.createStatement().use { stmt ->
            stmt.fetchSize = batchSize
            stmt.executeQuery("SELECT * FROM $quotedTable").use { rs ->
                val meta = rs.metaData
                val columnCount = meta.columnCount
                val columns = (1..columnCount).map { meta.getColumnName(it) }

                if (columns.isEmpty()) return 0L

                // 使用 REPLACE INTO 处理主键冲突
                val cols = columns.joinToString(", ") { dialect.quoteIdentifier(it) }
                val placeholders = columns.joinToString(", ") { "?" }
                val replaceSql = "REPLACE INTO $quotedTable ($cols) VALUES ($placeholders)"

                targetConn.autoCommit = false
                try {
                    targetConn.prepareStatement(replaceSql).use { ps ->
                        while (rs.next()) {
                            for (i in 1..columnCount) {
                                ps.setObject(i, rs.getObject(i))
                            }
                            ps.addBatch()
                            totalRows++

                            if (totalRows % batchSize == 0L) {
                                ps.executeBatch()
                                targetConn.commit()
                            }
                        }
                        ps.executeBatch()
                        targetConn.commit()
                    }
                } finally {
                    targetConn.autoCommit = true
                }
            }
        }

        return totalRows
    }
}
