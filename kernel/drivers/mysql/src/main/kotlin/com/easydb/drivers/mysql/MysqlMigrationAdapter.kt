package com.easydb.drivers.mysql

import com.easydb.common.*
import java.sql.ResultSet
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers

/**
 * MySQL 迁移适配器
 * 实现 MySQL → MySQL 同构迁移：
 * - 表：DDL 复制 + 批量数据 INSERT
 * - 视图/存储过程/函数/触发器：仅 DDL 复制
 */
class MysqlMigrationAdapter : MigrationAdapter {

    private val dialect = MysqlDialectAdapter()
    private val metadata = MysqlMetadataAdapter()

    override fun preview(config: MigrationConfig, sessions: SessionPair): MigrationPreview {
        // 获取全部对象（表+视图+存储过程+函数+触发器）
        val allObjects = getAllMigrationObjects(sessions.source, config.sourceDatabase)
            .filter { config.tables.isEmpty() || config.tables.contains(it.name) }

        val targetTables = try {
            metadata.listTables(sessions.target, config.targetDatabase).map { it.name }
        } catch (_: Exception) { emptyList() }

        val previews = allObjects.map { obj ->
            val isTable = obj.type == "table"
            val hasStructure = config.mode != "data_only"
            val hasData = isTable && config.mode != "structure_only"

            val risk = if (targetTables.contains(obj.name) && hasStructure && isTable) {
                "目标库已存在同名表 ${obj.name}，将被覆盖"
            } else null

            MigrationTablePreview(
                tableName = obj.name,
                rowCount = if (isTable) obj.rowCount else null,
                hasStructure = hasStructure || !isTable, // 非表对象始终迁移结构
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

        val allObjects = getAllMigrationObjects(sessions.source, config.sourceDatabase)
            .filter { config.tables.isEmpty() || config.tables.contains(it.name) }

        if (allObjects.isEmpty()) {
            return TaskResult(success = true, successCount = 0)
        }

        // 分组：表优先，然后存储过程/函数，再视图，最后触发器
        val tables = allObjects.filter { it.type == "table" }
        val procedures = allObjects.filter { it.type == "procedure" }
        val functions = allObjects.filter { it.type == "function" }
        val views = allObjects.filter { it.type == "view" }
        val triggers = allObjects.filter { it.type == "trigger" }
        val orderedObjects = tables + procedures + functions + views + triggers

        var successCount = 0
        var failureCount = 0
        val totalObjects = orderedObjects.size
        val tableRowCounts = mutableMapOf<String, Long>()
        val tableErrors = mutableMapOf<String, String>()

        reporter.onLog("INFO", "开始迁移：${config.sourceDatabase} → ${config.targetDatabase}，共 $totalObjects 个对象（表 ${tables.size} / 视图 ${views.size} / 存储过程 ${procedures.size} / 函数 ${functions.size} / 触发器 ${triggers.size}）")

        // 禁用外键检查和唯一性检查
        targetConn.createStatement().use { it.execute("SET FOREIGN_KEY_CHECKS=0") }
        targetConn.createStatement().use { it.execute("SET UNIQUE_CHECKS=0") }

        val sourcePrefix = "${dialect.quoteIdentifier(config.sourceDatabase)}."
        val targetPrefix = "${dialect.quoteIdentifier(config.targetDatabase)}."

        for ((index, obj) in orderedObjects.withIndex()) {
            if (reporter.isCancelled()) {
                reporter.onLog("WARN", "迁移已被取消")
                break
            }

            val objName = obj.name
            val progress = (((index + 1).toDouble() / totalObjects) * 100).toInt().coerceAtMost(99)
            reporter.onProgress(progress, "迁移${getTypeLabel(obj.type)} $objName (${index + 1}/$totalObjects)")

            try {
                if (obj.type == "table") {
                    // ═══ 表迁移（原有逻辑）═══
                    if (config.mode != "data_only") {
                        reporter.onStep(objName, TaskStatus.RUNNING, "迁移结构")
                        migrateStructure(sourceConn, targetConn, sourcePrefix, targetPrefix, objName)
                        reporter.onLog("INFO", "[$objName] 结构迁移完成")
                    }

                    if (config.mode != "structure_only") {
                        if (config.mode == "data_only") {
                            val fullTarget = "$targetPrefix${dialect.quoteIdentifier(objName)}"
                            targetConn.createStatement().use { it.execute("TRUNCATE TABLE $fullTarget") }
                            reporter.onLog("INFO", "[$objName] 已清空目标表数据")
                        }
                        reporter.onStep(objName, TaskStatus.RUNNING, "迁移数据")
                        val rowCount = migrateData(sourceConn, targetConn, sourcePrefix, targetPrefix, objName)
                        tableRowCounts[objName] = rowCount
                        reporter.onLog("INFO", "[$objName] 数据迁移完成，共 $rowCount 行")
                    } else {
                        tableRowCounts[objName] = 0L
                    }
                } else {
                    // ═══ 非表对象（视图/存储过程/函数/触发器）：仅 DDL 复制 ═══
                    if (config.mode == "data_only") {
                        // 仅数据模式下跳过非表对象
                        reporter.onLog("INFO", "[$objName] 仅数据模式，跳过${getTypeLabel(obj.type)}")
                        reporter.onStep(objName, TaskStatus.COMPLETED, "已跳过")
                        successCount++
                        continue
                    }
                    reporter.onStep(objName, TaskStatus.RUNNING, "迁移${getTypeLabel(obj.type)}定义")
                    migrateNonTableObject(sessions.source, targetConn, config.sourceDatabase, config.targetDatabase, objName, obj.type)
                    tableRowCounts[objName] = 0L
                    reporter.onLog("INFO", "[$objName] ${getTypeLabel(obj.type)}定义迁移完成")
                }

                reporter.onStep(objName, TaskStatus.COMPLETED)
                successCount++
            } catch (e: Exception) {
                tableRowCounts[objName] = 0L
                tableErrors[objName] = e.message ?: "未知错误"
                failureCount++
                reporter.onStep(objName, TaskStatus.FAILED, e.message)
                reporter.onLog("ERROR", "[$objName] 迁移失败：${e.message}")
            }
        }

        // 恢复外键检查和唯一性检查
        try {
            targetConn.createStatement().use { it.execute("SET FOREIGN_KEY_CHECKS=1") }
            targetConn.createStatement().use { it.execute("SET UNIQUE_CHECKS=1") }
        } catch (_: Exception) {
            reporter.onLog("WARN", "恢复外键/唯一性检查设置失败")
        }

        // 数据验证（仅对表执行行数验证）
        val tableOnlyCounts = tableRowCounts.filter { (name, _) ->
            tables.any { it.name == name }
        }
        reporter.onLog("INFO", "开始数据验证，对比 ${tableOnlyCounts.size} 张表...")
        val verification = buildVerification(
            targetConn, config.targetDatabase, tableOnlyCounts, tableErrors, reporter
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
            errorMessage = if (failureCount > 0) "部分对象迁移失败" else null,
            verification = verification
        )
    }

    // ─── 私有方法 ─────────────────────────────────────────────

    /**
     * 获取全部可迁移对象（表+视图+存储过程+函数+触发器），统一为 TableInfo
     */
    private fun getAllMigrationObjects(session: DatabaseSession, database: String): List<TableInfo> {
        val tables = metadata.listTables(session, database) // 已包含 table + view
        val routines = metadata.listRoutines(session, database)
        val triggers = metadata.listTriggers(session, database)

        val routineInfos = routines.map { r ->
            TableInfo(
                name = r.name,
                schema = database,
                type = r.type.lowercase(), // PROCEDURE / FUNCTION → procedure / function
                comment = r.comment
            )
        }
        val triggerInfos = triggers.map { t ->
            TableInfo(
                name = t.name,
                schema = database,
                type = "trigger",
                comment = "${t.timing} ${t.event} ON ${t.table}"
            )
        }

        return tables + routineInfos + triggerInfos
    }

    /**
     * 迁移非表对象：获取 DDL → 在目标库 DROP IF EXISTS + 执行
     */
    private fun migrateNonTableObject(
        sourceSession: DatabaseSession,
        targetConn: java.sql.Connection,
        sourceDatabase: String,
        targetDatabase: String,
        name: String,
        type: String
    ) {
        val ddl = metadata.getObjectDdl(sourceSession, sourceDatabase, name, type)
        if (ddl.isBlank()) {
            throw Exception("无法获取 $name 的 DDL")
        }

        val quotedName = dialect.quoteIdentifier(name)
        val targetDbQuoted = dialect.quoteIdentifier(targetDatabase)

        // 切换到目标库上下文
        targetConn.createStatement().use { it.execute("USE $targetDbQuoted") }

        // DROP IF EXISTS
        val dropSql = when (type) {
            "view" -> "DROP VIEW IF EXISTS $quotedName"
            "procedure" -> "DROP PROCEDURE IF EXISTS $quotedName"
            "function" -> "DROP FUNCTION IF EXISTS $quotedName"
            "trigger" -> "DROP TRIGGER IF EXISTS $quotedName"
            else -> throw Exception("不支持的对象类型：$type")
        }
        targetConn.createStatement().use { it.execute(dropSql) }

        // 执行 DDL（需要清理 DEFINER 和源库引用）
        var cleanedDdl = ddl
            .replace(Regex("""DEFINER\s*=\s*`[^`]*`@`[^`]*`\s*"""), "")
            // 替换 DDL 中的源库全限定引用为目标库
            .replace("`$sourceDatabase`.", "`$targetDatabase`.")

        // 触发器/存储过程/函数 DDL 可能包含 /*!50003 ... */ 条件注释中的 SET 语句
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

        targetConn.createStatement().use {
            it.execute("DROP TABLE IF EXISTS $targetPrefix$quotedTable")
        }

        var ddl = sourceConn.createStatement().use { stmt ->
            stmt.executeQuery("SHOW CREATE TABLE $sourcePrefix$quotedTable").use { rs ->
                if (rs.next()) rs.getString(2) else throw Exception("无法获取 $tableName 的 DDL")
            }
        }

        ddl = ddl.replace(Regex("""\s*AUTO_INCREMENT=\d+"""), "")

        targetConn.createStatement().use { it.execute("USE ${targetPrefix.removeSuffix(".")}") }
        targetConn.createStatement().use { it.execute(ddl) }
    }

    /**
     * 迁移数据：SELECT * → 批量 INSERT（协程 Channel 背压管道）
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

        val channel = Channel<List<Array<Any?>>>(capacity = 2)

        runBlocking {
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

            try {
                sourceConn.createStatement(
                    java.sql.ResultSet.TYPE_FORWARD_ONLY,
                    java.sql.ResultSet.CONCUR_READ_ONLY
                ).use { stmt ->
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
                                channel.send(currentBatch)
                                currentBatch = ArrayList(batchSize)
                            }
                        }
                        if (currentBatch.isNotEmpty()) {
                            channel.send(currentBatch)
                        }
                    }
                }
            } finally {
                channel.close()
            }
        }

        return totalRows
    }

    /**
     * 数据验证：对比源库实际读取行数与目标库精确行数
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
                0L
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
