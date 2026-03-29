package com.easydb.launcher

import com.easydb.api.ok
import com.easydb.api.fail
import com.easydb.common.*
import com.easydb.drivers.mysql.MysqlConnectionAdapter
import com.easydb.drivers.mysql.MysqlDatabaseSession
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.io.File
import java.io.FileOutputStream
import java.sql.Connection
import java.sql.Types
import java.text.SimpleDateFormat
import java.util.Date
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@Serializable
data class ExportRequest(
    val connectionId: String,
    val database: String,
    val tables: List<String>,
    // "STRUCTURE_ONLY", "DATA_ONLY", "STRUCTURE_AND_DATA"
    val exportContent: String,
    // "SQL_ZIP", "CSV_ZIP"
    val exportFormat: String,
    val addDropTable: Boolean = false
)

@Serializable
data class ExportEstimateRequest(
    val connectionId: String,
    val database: String,
    val tables: List<String>,
    val exportContent: String,
    val exportFormat: String
)

@Serializable
data class ExportTableEstimateDto(
    val tableName: String,
    val estimatedRows: Long,
    val estimatedBytes: Long,
    val progressUnits: Long,
    val risk: String
)

@Serializable
data class ExportEstimateResult(
    val totalTables: Int,
    val selectedTables: Int,
    val includeData: Boolean,
    val exportContent: String,
    val exportFormat: String,
    val estimatedRows: Long,
    val estimatedBytes: Long,
    val largeTableCount: Int,
    val tables: List<ExportTableEstimateDto>,
    val warnings: List<String> = emptyList()
)

private const val EXPORT_PROGRESS_MIN = 1
private const val EXPORT_PROGRESS_MAX_BEFORE_COMPLETE = 99
private const val EXPORT_PROGRESS_UPDATE_EVERY_ROWS = 10_000L
private const val EXPORT_PROGRESS_LOG_EVERY_ROWS = 100_000L
private const val EXPORT_PROGRESS_BASE_UNITS_PER_TABLE = 10_000L
private const val EXPORT_PROGRESS_DATA_UNITS_CAP_PER_TABLE = 500_000L
private const val EXPORT_QUERY_TIMEOUT_SECONDS = 14400  // 4 小时，后台导出任务不应被短超时误杀
private const val EXPORT_MIN_DISK_SPACE_BYTES = 5L * 1024 * 1024 * 1024  // 5 GB

/** 专用协程域：替代 GlobalScope，支持统一生命周期治理 */
private val exportTaskScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

/**
 * 安全转义 SQL 字符串字面量，覆盖所有 MySQL 关键特殊字符。
 * 防止导出后再次导入时因字符逃逸导致 SQL 语法断裂或数据丢失。
 */
private fun escapeSqlLiteral(value: String): String {
    val sb = StringBuilder(value.length + 16)
    for (ch in value) {
        when (ch) {
            '\u0000' -> sb.append("\\0")     // NUL 字节
            '\'' -> sb.append("\\'")
            '\"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            '\u0008' -> sb.append("\\b")     // Backspace
            '\u001A' -> sb.append("\\Z")     // Ctrl+Z (Windows EOF)
            else -> sb.append(ch)
        }
    }
    return sb.toString()
}

/**
 * 判断列类型是否为二进制类型（BLOB / BINARY / VARBINARY 等）
 */
private fun isBinaryColumn(columnType: Int): Boolean {
    return columnType in setOf(
        Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY,
        Types.BLOB
    )
}

/**
 * 将字节数组转换为 MySQL 十六进制字面量：X'ABCD...'
 */
private fun bytesToHexLiteral(bytes: ByteArray): String {
    val sb = StringBuilder(bytes.size * 2 + 3)
    sb.append("X'")
    for (b in bytes) {
        sb.append(String.format("%02X", b))
    }
    sb.append("'")
    return sb.toString()
}

private data class TableExportEstimate(
    val estimatedRows: Long,
    val estimatedBytes: Long,
    val progressUnits: Long
)

private fun shouldExportData(exportContent: String): Boolean {
    return exportContent == "DATA_ONLY" || exportContent == "STRUCTURE_AND_DATA"
}

private fun estimateRisk(estimatedRows: Long, estimatedBytes: Long, includeData: Boolean): String {
    if (!includeData) return "low"
    return when {
        estimatedBytes >= 200L * 1024L * 1024L || estimatedRows >= 1_000_000L -> "high"
        estimatedBytes >= 50L * 1024L * 1024L || estimatedRows >= 100_000L -> "medium"
        else -> "low"
    }
}

private fun calculateExportProgress(
    completedUnits: Long,
    currentTableUnits: Long,
    totalUnits: Long
): Int {
    if (totalUnits <= 0L) return EXPORT_PROGRESS_MIN
    val boundedUnits = (completedUnits + currentTableUnits).coerceIn(0L, totalUnits)
    val ratio = boundedUnits.toDouble() / totalUnits.toDouble()
    return (EXPORT_PROGRESS_MIN + (ratio * (EXPORT_PROGRESS_MAX_BEFORE_COMPLETE - EXPORT_PROGRESS_MIN)).toInt())
        .coerceIn(EXPORT_PROGRESS_MIN, EXPORT_PROGRESS_MAX_BEFORE_COMPLETE)
}

private fun loadTableExportEstimates(
    connection: Connection,
    database: String,
    tables: List<String>,
    includeData: Boolean
): Map<String, TableExportEstimate> {
    if (tables.isEmpty()) return emptyMap()

    val fallback = tables.associateWith {
        TableExportEstimate(
            estimatedRows = if (includeData) EXPORT_PROGRESS_UPDATE_EVERY_ROWS else 1L,
            estimatedBytes = 0L,
            progressUnits = if (includeData) {
                EXPORT_PROGRESS_BASE_UNITS_PER_TABLE + EXPORT_PROGRESS_UPDATE_EVERY_ROWS
            } else {
                EXPORT_PROGRESS_BASE_UNITS_PER_TABLE
            }
        )
    }.toMutableMap()

    val placeholders = tables.joinToString(",") { "?" }
    val sql = """
        SELECT table_name,
               COALESCE(table_rows, 0) AS table_rows,
               COALESCE(data_length, 0) + COALESCE(index_length, 0) AS total_bytes
        FROM information_schema.tables
        WHERE table_schema = ? AND table_name IN ($placeholders)
    """.trimIndent()

    connection.prepareStatement(sql).use { stmt ->
        stmt.setString(1, database)
        tables.forEachIndexed { index, table ->
            stmt.setString(index + 2, table)
        }

        stmt.executeQuery().use { rs ->
            while (rs.next()) {
                val tableName = rs.getString("table_name") ?: continue
                val estimatedRows = rs.getLong("table_rows").coerceAtLeast(0L)
                val estimatedBytes = rs.getLong("total_bytes").coerceAtLeast(0L)
                fallback[tableName] = TableExportEstimate(
                    estimatedRows = when {
                        !includeData -> 1L
                        estimatedRows > 0L -> estimatedRows
                        estimatedBytes > 0L -> (estimatedBytes / 64_000L).coerceAtLeast(EXPORT_PROGRESS_UPDATE_EVERY_ROWS)
                        else -> EXPORT_PROGRESS_UPDATE_EVERY_ROWS
                    },
                    estimatedBytes = estimatedBytes,
                    progressUnits = if (!includeData) {
                        EXPORT_PROGRESS_BASE_UNITS_PER_TABLE
                    } else {
                        EXPORT_PROGRESS_BASE_UNITS_PER_TABLE +
                            estimatedRows.coerceAtLeast(EXPORT_PROGRESS_UPDATE_EVERY_ROWS)
                                .coerceAtMost(EXPORT_PROGRESS_DATA_UNITS_CAP_PER_TABLE)
                    }
                )
            }
        }
    }

    return fallback
}

fun Route.exportRoutes() {
    get("/debug/threads") {
        val dump = StringBuilder()
        Thread.getAllStackTraces().forEach { (thread, stack) ->
            if (thread.name.contains("DefaultDispatcher") || thread.name.contains("Coroutines")) {
                dump.append("Thread: ${thread.name} (State: ${thread.state})\n")
                stack.forEach { s -> dump.append("  at $s\n") }
                dump.append("\n")
            }
        }
        call.respondText(dump.toString())
    }

    post("/start") {
        val req = call.receive<ExportRequest>()
        val connMgr = ServiceRegistry.connectionManager
        val taskMgr = ServiceRegistry.taskManager

        val session = connMgr.getSession(req.connectionId)
        if (session == null) {
            call.fail("NOT_CONNECTED", "连接未打开，请先打开连接")
            return@post
        }

        val config = session.config
        val task = taskMgr.createTask(
            name = "导出 ${req.database}",
            type = "export"
        )
        val reporter = taskMgr.createReporter(task.id)

        // 异步执行导出，Dispatchers.IO 防止阻塞式 JDBC 调用占用轻量延迟线程池
        exportTaskScope.launch {
            reporter.onProgress(1, "初始化导出环境...")
            val startTime = System.currentTimeMillis()

            var dedicatedConn: java.sql.Connection? = null
            var zipFile: java.io.File? = null
            try {
                // 使用 req.database 建立专用连接！绝对不能用 database=null，否则在某些分库分表中间件或云代理（如 MyCat/TiDB）下，
                // 会因为无法路由目标节点而导致握手包被永久黑洞（Hang）！
                val exportConfig = config.copy(database = req.database)
                reporter.onLog("INFO", "正在验证并建立专用导出连接 [${req.database}]...")
                val exportConn = kotlinx.coroutines.withTimeout(15000L) {
                    MysqlConnectionAdapter.createJdbcConnection(exportConfig)
                }
                dedicatedConn = exportConn
                exportConn.isReadOnly = true
                reporter.onLog("INFO", "专用连接已就绪，脱离主会话以防止心跳拥堵...")

                val taskSession = MysqlDatabaseSession(config.id, config, exportConn)
                val adapter = ServiceRegistry.mysqlAdapter.metadataAdapter()
                val dialect = ServiceRegistry.mysqlAdapter.dialectAdapter()

                val exportDir = File(System.getProperty("user.home"), ".easydb/exports")
                if (!exportDir.exists()) exportDir.mkdirs()

                // A4: 磁盘空间预检 —— 低于 5GB 直接拒绝启动
                val usableSpace = exportDir.usableSpace
                if (usableSpace < EXPORT_MIN_DISK_SPACE_BYTES) {
                    val spaceGB = String.format("%.1f", usableSpace.toDouble() / (1024 * 1024 * 1024))
                    throw Exception("磁盘剩余空间不足（仅剩 ${spaceGB} GB），请清理后重试")
                }

                val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss").format(Date())
                zipFile = File(exportDir, "export_${req.database}_$timestamp.zip")
                val totalTables = req.tables.size
                var currentTableIdx = 0
                val includeData = shouldExportData(req.exportContent)
                val tableEstimates = loadTableExportEstimates(exportConn, req.database, req.tables, includeData)
                val totalProgressUnits = req.tables.sumOf { table ->
                    tableEstimates[table]?.progressUnits ?: if (includeData) {
                        EXPORT_PROGRESS_BASE_UNITS_PER_TABLE + EXPORT_PROGRESS_UPDATE_EVERY_ROWS
                    } else {
                        EXPORT_PROGRESS_BASE_UNITS_PER_TABLE
                    }
                }.coerceAtLeast(req.tables.size.toLong())
                var completedProgressUnits = 0L
                reporter.onLog(
                    "INFO",
                    "已加载导出进度估算：${totalTables} 张表，预计 ${(totalProgressUnits / 10_000L).coerceAtLeast(1L)} 个进度单位"
                )

                ZipOutputStream(FileOutputStream(zipFile)).use { zos ->
                    if (req.exportFormat == "SQL_ZIP") {
                        // SQL 导出打包为单个文件
                        zos.putNextEntry(ZipEntry("${req.database}_dump.sql"))
                        val writer = zos.writer(Charsets.UTF_8)

                        writer.write("-- EasyDB SQL Dump\n")
                        writer.write("-- Database: ${req.database}\n")
                        writer.write("-- Generation Time: ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(Date())}\n\n")

                        for (table in req.tables) {
                            if (reporter.isCancelled()) break
                            currentTableIdx++
                            val tableEstimate = tableEstimates[table]
                                ?: TableExportEstimate(
                                    estimatedRows = if (includeData) EXPORT_PROGRESS_UPDATE_EVERY_ROWS else 1L,
                                    estimatedBytes = 0L,
                                    progressUnits = if (includeData) {
                                        EXPORT_PROGRESS_BASE_UNITS_PER_TABLE + EXPORT_PROGRESS_UPDATE_EVERY_ROWS
                                    } else {
                                        EXPORT_PROGRESS_BASE_UNITS_PER_TABLE
                                    }
                                )
                            reporter.onProgress(
                                calculateExportProgress(completedProgressUnits, 0L, totalProgressUnits),
                                "正在导出表: $table ($currentTableIdx/$totalTables)"
                            )
                            reporter.onLog("INFO", "开始导出表 [$currentTableIdx/$totalTables]: $table ...")

                            // 1. 结构导出
                            if (req.exportContent == "STRUCTURE_ONLY" || req.exportContent == "STRUCTURE_AND_DATA") {
                                writer.write("-- ----------------------------\n")
                                writer.write("-- Table structure for $table\n")
                                writer.write("-- ----------------------------\n")
                                if (req.addDropTable) {
                                    writer.write("DROP TABLE IF EXISTS ${dialect.quoteIdentifier(table)};\n")
                                }
                                try {
                                    val ddl = adapter.getDdl(taskSession, req.database, table)
                                    writer.write("$ddl;\n\n")
                                } catch (e: Exception) {
                                    reporter.onLog("WARN", "无法获取 $table 的 DDL: ${e.message}")
                                }
                            }

                            // 2. 数据导出 (流式查询，TYPE_FORWARD_ONLY + fetchSize=MIN_VALUE)
                            if (req.exportContent == "DATA_ONLY" || req.exportContent == "STRUCTURE_AND_DATA") {
                                writer.write("-- ----------------------------\n")
                                writer.write("-- Records of $table\n")
                                writer.write("-- ----------------------------\n")

                                // 使用独立连接，防止大表执行游标耗时导致整个 Workbench 连接瘫痪
                                exportConn.createStatement(
                                    java.sql.ResultSet.TYPE_FORWARD_ONLY,
                                    java.sql.ResultSet.CONCUR_READ_ONLY
                                ).use { stmt ->
                                    stmt.fetchSize = 1000
                                    // B1: 后台导出任务使用宽松超时（4小时），避免大表被误杀
                                    stmt.queryTimeout = EXPORT_QUERY_TIMEOUT_SECONDS
                                    reporter.onLog("INFO", "  [DEBUG] 开始执行查询: SELECT * FROM $table...")
                                    stmt.executeQuery(
                                        "SELECT * FROM ${dialect.quoteIdentifier(req.database)}.${dialect.quoteIdentifier(table)}"
                                    ).use { rs ->
                                        reporter.onLog("INFO", "  [DEBUG] 查询执行完毕，获取到 ResultSet")
                                        val meta = rs.metaData
                                        val colCount = meta.columnCount
                                        var rowsInBatch = 0
                                        var rowCount = 0L // 本地计数器（TYPE_FORWARD_ONLY 不支持 rs.row）

                                        while (true) {
                                            // 记录每次 next 的耗时
                                            val nextStart = System.currentTimeMillis()
                                            val hasNext = rs.next()
                                            val nextSpill = System.currentTimeMillis() - nextStart
                                            if (rowCount < 5 && nextSpill > 50) {
                                                reporter.onLog("WARN", "  [DEBUG] rs.next() 取第 ${rowCount+1} 行耗时: ${nextSpill}ms")
                                            }
                                            
                                            if (!hasNext) break
                                            if (reporter.isCancelled()) break
                                            
                                            if (rowCount == 0L) {
                                                reporter.onLog("INFO", "  [DEBUG] 成功读取到第一行数据！")
                                            }

                                            if (rowsInBatch == 0) {
                                                writer.write("INSERT INTO ${dialect.quoteIdentifier(table)} VALUES ")
                                            } else {
                                                writer.write(", ")
                                            }

                                            writer.write("(")
                                            for (i in 1..colCount) {
                                                if (rs.getObject(i) == null) {
                                                    writer.write("NULL")
                                                } else if (isBinaryColumn(meta.getColumnType(i))) {
                                                    // A2: BLOB/BINARY 列使用十六进制字面量，保证二进制数据完整性
                                                    val bytes = rs.getBytes(i)
                                                    writer.write(bytesToHexLiteral(bytes))
                                                } else {
                                                    // A1: 使用完善的转义函数覆盖所有特殊字符
                                                    val value = rs.getString(i)
                                                    writer.write("'${escapeSqlLiteral(value)}'")
                                                }
                                                if (i < colCount) writer.write(", ")
                                            }
                                            writer.write(")")

                                            rowsInBatch++
                                            rowCount++

                                            if (rowCount % EXPORT_PROGRESS_UPDATE_EVERY_ROWS == 0L) {
                                                val currentTableProgressUnits = EXPORT_PROGRESS_BASE_UNITS_PER_TABLE +
                                                    rowCount.coerceAtMost(tableEstimate.estimatedRows)
                                                        .coerceAtMost(EXPORT_PROGRESS_DATA_UNITS_CAP_PER_TABLE)
                                                reporter.onProgress(
                                                    calculateExportProgress(
                                                        completedProgressUnits,
                                                        currentTableProgressUnits,
                                                        totalProgressUnits
                                                    ),
                                                    "正在导出表: $table ($currentTableIdx/$totalTables, 已处理 ${rowCount} 行)"
                                                )
                                            }

                                            if (rowsInBatch >= 500) {
                                                writer.write(";\n")
                                                rowsInBatch = 0
                                            }

                                            // 每 10 万行打一次日志，防止 UI 无响应
                                            if (rowCount % EXPORT_PROGRESS_LOG_EVERY_ROWS == 0L) {
                                                reporter.onLog("INFO", "  已处理表 $table 的 $rowCount 行数据...")
                                            }
                                        }

                                        if (rowsInBatch > 0) {
                                            writer.write(";\n")
                                        }
                                        writer.write("\n")
                                    }
                                }
                            }

                            completedProgressUnits += tableEstimate.progressUnits
                            reporter.onProgress(
                                calculateExportProgress(completedProgressUnits, 0L, totalProgressUnits),
                                "已完成表: $table ($currentTableIdx/$totalTables)"
                            )
                            reporter.onLog("INFO", "完成表导出: $table")
                            writer.flush()
                        }

                        zos.closeEntry()

                    } else if (req.exportFormat == "CSV_ZIP") {
                        // CSV 导出，每个表一个文件
                        for (table in req.tables) {
                            if (reporter.isCancelled()) break
                            currentTableIdx++
                            val tableEstimate = tableEstimates[table]
                                ?: TableExportEstimate(
                                    estimatedRows = if (includeData) EXPORT_PROGRESS_UPDATE_EVERY_ROWS else 1L,
                                    estimatedBytes = 0L,
                                    progressUnits = if (includeData) {
                                        EXPORT_PROGRESS_BASE_UNITS_PER_TABLE + EXPORT_PROGRESS_UPDATE_EVERY_ROWS
                                    } else {
                                        EXPORT_PROGRESS_BASE_UNITS_PER_TABLE
                                    }
                                )
                            reporter.onProgress(
                                calculateExportProgress(completedProgressUnits, 0L, totalProgressUnits),
                                "正在导出表: $table (CSV, $currentTableIdx/$totalTables)"
                            )
                            reporter.onLog("INFO", "开始导出表 [$currentTableIdx/$totalTables]: $table (CSV) ...")

                            zos.putNextEntry(ZipEntry("$table.csv"))
                            val writer = zos.writer(Charsets.UTF_8)

                            if (req.exportContent == "DATA_ONLY" || req.exportContent == "STRUCTURE_AND_DATA") {
                                exportConn.createStatement(
                                    java.sql.ResultSet.TYPE_FORWARD_ONLY,
                                    java.sql.ResultSet.CONCUR_READ_ONLY
                                ).use { stmt ->
                                    stmt.fetchSize = 1000
                                    stmt.queryTimeout = EXPORT_QUERY_TIMEOUT_SECONDS
                                    stmt.executeQuery(
                                        "SELECT * FROM ${dialect.quoteIdentifier(req.database)}.${dialect.quoteIdentifier(table)}"
                                    ).use { rs ->
                                        val meta = rs.metaData
                                        val colCount = meta.columnCount

                                        // 写表头
                                        for (i in 1..colCount) {
                                            val name = meta.getColumnName(i)
                                            val escapedName = if (name.contains(",") || name.contains("\""))
                                                "\"${name.replace("\"", "\"\"")}\"" else name
                                            writer.write(escapedName)
                                            if (i < colCount) writer.write(",")
                                        }
                                        writer.write("\n")

                                        // 写数据
                                        var csvRowCount = 0L // 本地计数器，TYPE_FORWARD_ONLY 不支持 rs.row
                                        while (rs.next()) {
                                            if (reporter.isCancelled()) break
                                            for (i in 1..colCount) {
                                                val value = rs.getString(i)
                                                if (value != null) {
                                                    // A1(CSV): 增加 \r 检测，防止行边界错乱
                                                    val escaped = if (value.contains(",") || value.contains("\"") || value.contains("\n") || value.contains("\r"))
                                                        "\"${value.replace("\"", "\"\"")}\"" else value
                                                    writer.write(escaped)
                                                }
                                                if (i < colCount) writer.write(",")
                                            }
                                            writer.write("\n")
                                            csvRowCount++

                                            if (csvRowCount % EXPORT_PROGRESS_UPDATE_EVERY_ROWS == 0L) {
                                                val currentTableProgressUnits = EXPORT_PROGRESS_BASE_UNITS_PER_TABLE +
                                                    csvRowCount.coerceAtMost(tableEstimate.estimatedRows)
                                                        .coerceAtMost(EXPORT_PROGRESS_DATA_UNITS_CAP_PER_TABLE)
                                                reporter.onProgress(
                                                    calculateExportProgress(
                                                        completedProgressUnits,
                                                        currentTableProgressUnits,
                                                        totalProgressUnits
                                                    ),
                                                    "正在导出表: $table (CSV, $currentTableIdx/$totalTables, 已处理 ${csvRowCount} 行)"
                                                )
                                            }

                                            if (csvRowCount % EXPORT_PROGRESS_LOG_EVERY_ROWS == 0L) {
                                                reporter.onLog("INFO", "  已处理表 $table 的 $csvRowCount 行数据 (CSV)...")
                                            }
                                        }
                                    }
                                }
                            }

                            completedProgressUnits += tableEstimate.progressUnits
                            reporter.onProgress(
                                calculateExportProgress(completedProgressUnits, 0L, totalProgressUnits),
                                "已完成表: $table (CSV, $currentTableIdx/$totalTables)"
                            )
                            reporter.onLog("INFO", "完成表导出: $table")
                            writer.flush()
                            zos.closeEntry()
                        }
                    }
                }

                val duration = System.currentTimeMillis() - startTime
                if (reporter.isCancelled()) {
                    taskMgr.markCancelled(task.id, duration)
                    // 注意：这里不直接 delete，因为还在 ZipOutputStream.use {} 内文件被锁
                    // 延迟到 finally 块中清理
                } else {
                    reporter.onLog("INFO", "导出文件生成成功：${zipFile.absolutePath}")
                    taskMgr.markCompleted(
                        task.id, duration, TaskResult(
                            success = true,
                            successCount = req.tables.size,
                            payload = mapOf("filePath" to zipFile.absolutePath, "fileName" to zipFile.name)
                        )
                    )
                }
            } catch (e: Exception) {
                reporter.onLog("ERROR", "导出发生异常: ${e.message}")
                taskMgr.markFailed(task.id, e.message ?: "导出异常")
            } finally {
                // 先关闭连接，释放资源
                try { dedicatedConn?.close() } catch (ignored: Exception) {}

                // ZipOutputStream.use {} 已退出，文件流已关闭，现在可以安全删除
                val isCancelled = reporter.isCancelled()
                val taskStatus = taskMgr.get(task.id)?.status
                reporter.onLog("INFO", "[CLEANUP] isCancelled=$isCancelled, taskStatus=$taskStatus, zipFile=${zipFile?.name}, exists=${zipFile?.exists()}")
                try {
                    if (isCancelled || taskStatus == "failed") {
                        zipFile?.let { file ->
                            if (file.exists()) {
                                val deleted = file.delete()
                                reporter.onLog("INFO", if (deleted) "已清理半成品导出文件: ${file.name}" else "半成品文件清理失败: ${file.name}")
                            } else {
                                reporter.onLog("INFO", "[CLEANUP] 文件已不存在: ${file.name}")
                            }
                        } ?: reporter.onLog("WARN", "[CLEANUP] zipFile 为 null，跳过清理")
                    } else {
                        reporter.onLog("INFO", "[CLEANUP] 任务未取消且未失败，保留导出文件")
                    }
                } catch (e: Exception) {
                    reporter.onLog("WARN", "[CLEANUP] 清理异常: ${e.message}")
                }

                reporter.onLog("INFO", "资源清理完成")
            }
        }

        call.ok(TaskStartResult(taskId = task.id))
    }

    post("/estimate") {
        val req = call.receive<ExportEstimateRequest>()
        val connMgr = ServiceRegistry.connectionManager
        val session = connMgr.getSession(req.connectionId)
        if (session == null) {
            call.fail("NOT_CONNECTED", "连接未打开，请先打开连接")
            return@post
        }

        if (req.tables.isEmpty()) {
            call.ok(
                ExportEstimateResult(
                    totalTables = 0,
                    selectedTables = 0,
                    includeData = shouldExportData(req.exportContent),
                    exportContent = req.exportContent,
                    exportFormat = req.exportFormat,
                    estimatedRows = 0L,
                    estimatedBytes = 0L,
                    largeTableCount = 0,
                    tables = emptyList(),
                    warnings = listOf("请至少选择一张表")
                )
            )
            return@post
        }

        var dedicatedConn: Connection? = null
        try {
            val exportConfig = session.config.copy(database = req.database)
            val estimateConn = kotlinx.coroutines.withTimeout(15000L) {
                MysqlConnectionAdapter.createJdbcConnection(exportConfig)
            }
            dedicatedConn = estimateConn
            estimateConn.isReadOnly = true

            val includeData = shouldExportData(req.exportContent)
            val tableEstimates = loadTableExportEstimates(estimateConn, req.database, req.tables, includeData)
            val estimateTables = req.tables.map { tableName ->
                val estimate = tableEstimates[tableName]
                    ?: TableExportEstimate(
                        estimatedRows = if (includeData) EXPORT_PROGRESS_UPDATE_EVERY_ROWS else 1L,
                        estimatedBytes = 0L,
                        progressUnits = if (includeData) {
                            EXPORT_PROGRESS_BASE_UNITS_PER_TABLE + EXPORT_PROGRESS_UPDATE_EVERY_ROWS
                        } else {
                            EXPORT_PROGRESS_BASE_UNITS_PER_TABLE
                        }
                    )
                ExportTableEstimateDto(
                    tableName = tableName,
                    estimatedRows = estimate.estimatedRows,
                    estimatedBytes = estimate.estimatedBytes,
                    progressUnits = estimate.progressUnits,
                    risk = estimateRisk(estimate.estimatedRows, estimate.estimatedBytes, includeData)
                )
            }.sortedWith(
                compareByDescending<ExportTableEstimateDto> { it.estimatedBytes }
                    .thenByDescending { it.estimatedRows }
                    .thenBy { it.tableName }
            )

            val estimatedRows = estimateTables.sumOf { it.estimatedRows }
            val estimatedBytes = estimateTables.sumOf { it.estimatedBytes }
            val largeTableCount = estimateTables.count { it.risk == "high" || it.risk == "medium" }
            val warnings = buildList {
                if (!includeData) {
                    add("当前仅导出结构，执行速度通常会更快。")
                }
                if (largeTableCount > 0 && includeData) {
                    add("已检测到 $largeTableCount 张可能耗时较久的表，建议预留更长导出时间。")
                }
                if (estimatedBytes >= 200L * 1024L * 1024L && includeData) {
                    add("预计导出体积较大，生成压缩包期间磁盘与 CPU 占用会更明显。")
                }
            }

            call.ok(
                ExportEstimateResult(
                    totalTables = req.tables.size,
                    selectedTables = req.tables.size,
                    includeData = includeData,
                    exportContent = req.exportContent,
                    exportFormat = req.exportFormat,
                    estimatedRows = estimatedRows,
                    estimatedBytes = estimatedBytes,
                    largeTableCount = largeTableCount,
                    tables = estimateTables,
                    warnings = warnings
                )
            )
        } catch (e: Exception) {
            call.fail("EXPORT_ESTIMATE_FAILED", e.message ?: "导出估算失败")
        } finally {
            try {
                dedicatedConn?.close()
            } catch (_: Exception) {
            }
        }
    }

    get("/download/{taskId}") {
        val taskId = call.parameters["taskId"] ?: return@get call.fail("INVALID_ID", "缺少任务 ID")
        val taskMgr = ServiceRegistry.taskManager

        val task = taskMgr.get(taskId) ?: return@get call.fail("NOT_FOUND", "任务不存在")
        if (task.status != "completed") return@get call.fail("INVALID_STATUS", "任务未完成，无法下载")

        val filePath = task.payload?.get("filePath") ?: return@get call.fail("NO_FILE", "该任务未关联任何可下载文件")
        val fileName = task.payload?.get("fileName") ?: "export.zip"

        val file = File(filePath)
        if (!file.exists()) return@get call.fail("FILE_NOT_FOUND", "导出文件已丢失或被清理")

        call.response.header(io.ktor.http.HttpHeaders.ContentDisposition, "attachment; filename=\"$fileName\"")
        call.respondFile(file)
    }
}
