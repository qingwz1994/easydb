package com.easydb.drivers.mysql

import com.easydb.common.*
import java.sql.ResultSet

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
                    reporter.onLog("INFO", "[$tableName] 数据迁移完成，共 $rowCount 行")
                }

                reporter.onStep(tableName, TaskStatus.COMPLETED)
                successCount++
            } catch (e: Exception) {
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

        reporter.onProgress(100, "迁移完成")
        reporter.onLog("INFO", "迁移结束：成功 $successCount，失败 $failureCount")

        return TaskResult(
            success = failureCount == 0,
            successCount = successCount,
            failureCount = failureCount,
            errorMessage = if (failureCount > 0) "部分表迁移失败" else null
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

        sourceConn.createStatement().use { stmt ->
            stmt.fetchSize = batchSize
            // 关键修复：使用全限定表名从源库读取数据
            stmt.executeQuery("SELECT * FROM $fullSourceTable").use { rs ->
                val meta = rs.metaData
                val columnCount = meta.columnCount
                val columns = (1..columnCount).map { meta.getColumnName(it) }

                if (columns.isEmpty()) return 0L

                // 关键修复：使用全限定表名插入到目标库
                val cols = columns.joinToString(", ") { dialect.quoteIdentifier(it) }
                val placeholders = columns.joinToString(", ") { "?" }
                val insertSql = "INSERT INTO $fullTargetTable ($cols) VALUES ($placeholders)"

                targetConn.autoCommit = false

                try {
                    targetConn.prepareStatement(insertSql).use { ps ->
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
                        // 提交剩余
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
