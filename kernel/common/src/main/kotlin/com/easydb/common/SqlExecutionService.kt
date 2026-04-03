package com.easydb.common

import java.io.BufferedReader
import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.sql.Statement
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * SQL 执行服务
 * - 普通 SQL 编辑器执行：返回结构化结果
 * - SQL 文件导入：流式读取文件，避免前端把超大文件整体读入内存
 */
class SqlExecutionService {

    companion object {
        private const val IMPORT_PROGRESS_MIN = 1
        private const val IMPORT_PROGRESS_MAX_BEFORE_COMPLETE = 99
        private const val IMPORT_PROGRESS_UPDATE_EVERY_BYTES = 4L * 1024 * 1024
        private const val IMPORT_LOG_EVERY_STATEMENTS = 100
        private const val IMPORT_PROGRESS_LOG_EVERY_STATEMENTS = 20

        /**
         * B3: 单条 SQL 语句内存硬上限（32MB）。
         * 超出此阈值的语句会被直接拒绝执行，避免服务端 JVM 因单条超长 INSERT 被撑爆 OOM。
         * 用户将收到明确提示，建议改用分批切割模式重新导出。
         */
        private const val MAX_SINGLE_SQL_SIZE_BYTES = 32L * 1024 * 1024

        /**
         * INSERT...VALUES 自动拆分阈值（8MB）。
         * 当单条 INSERT 累积超过此阈值时，自动按 VALUES 行边界切割为多个小批次执行。
         * 远小于 32MB 硬上限，确保有足够缓冲空间完成切割。
         */
        private const val BATCH_SPLIT_THRESHOLD = 8L * 1024 * 1024

        /**
         * SQL 结果中原始 SQL 文本的最大长度（字符）。
         * 超过该长度的 SQL 会被截断，避免超长 INSERT 等拖垂前端渲染。
         */
        private const val MAX_RESULT_SQL_DISPLAY_LENGTH = 2000

        /**
         * SQL 编辑器查询结果最大行数（防 OOM 保护）。
         * 类似 DBeaver 默认只取 200 行，这里设为 5000 行兼顾实用性。
         * 超出时在结果中标记 hasMore=true，提示用户添加 LIMIT。
         */
        private const val MAX_QUERY_ROWS = 5000

        /**
         * 单元格最大字符数。超长内容会被截断，防止大 BLOB/TEXT 撑爆内存。
         */
        private const val MAX_CELL_CHARS = 4096
    }

    /** 截断超长 SQL，防止 JSON 序列化撒到前端拖垂渲染 */
    private fun truncateSql(sql: String): String {
        return if (sql.length > MAX_RESULT_SQL_DISPLAY_LENGTH) {
            sql.take(MAX_RESULT_SQL_DISPLAY_LENGTH) + " …[SQL 已截断，原始长度 ${sql.length} 字符]"
        } else {
            sql
        }
    }

    private val timeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

    /**
     * 执行 SQL（支持多语句），返回每条语句的结果列表
     */
    fun execute(session: DatabaseSession, database: String, sql: String): List<SqlResult> {
        val jdbcSession = session as? com.easydb.common.DatabaseSession
            ?: return listOf(SqlResult(
                type = "error", duration = 0, sql = sql,
                executedAt = LocalDateTime.now().format(timeFormatter),
                error = "无效的数据库会话"
            ))

        val start = System.currentTimeMillis()
        return try {
            val conn = getConnection(jdbcSession)

            // 切换到目标数据库
            conn.createStatement().use { stmt ->
                stmt.execute("USE `$database`")
            }

            conn.createStatement(
                java.sql.ResultSet.TYPE_FORWARD_ONLY,
                java.sql.ResultSet.CONCUR_READ_ONLY
            ).use { stmt ->
                // 行数上限保护：多取 1 行判断 hasMore，防止大表 SELECT * 导致 OOM
                stmt.maxRows = MAX_QUERY_ROWS + 1

                var hasResult = stmt.execute(sql)
                val results = mutableListOf<SqlResult>()

                while (true) {
                    val duration = System.currentTimeMillis() - start

                    if (hasResult) {
                        val rs = stmt.resultSet
                        val meta = rs.metaData
                        val columnCount = meta.columnCount
                        val columns = (1..columnCount).map { meta.getColumnLabel(it) }
                        val rows = mutableListOf<Map<String, String?>>()
                        var queryHasMore = false

                        while (rs.next()) {
                            if (rows.size >= MAX_QUERY_ROWS) {
                                queryHasMore = true
                                break
                            }
                            val row = mutableMapOf<String, String?>()
                            for (i in 1..columnCount) {
                                val value = rs.getString(i)
                                row[columns[i - 1]] = when {
                                    value == null -> null
                                    value.length > MAX_CELL_CHARS -> value.take(MAX_CELL_CHARS) + " …[已截断]"
                                    else -> value
                                }
                            }
                            rows.add(row)
                        }
                        rs.close()

                        results.add(SqlResult(
                            type = "query", columns = columns, rows = rows,
                            hasMore = queryHasMore,
                            loadedRows = rows.size,
                            duration = duration, sql = truncateSql(sql),
                            executedAt = LocalDateTime.now().format(timeFormatter)
                        ))
                    } else {
                        val updateCount = stmt.updateCount
                        if (updateCount == -1) {
                            break
                        }
                        results.add(SqlResult(
                            type = "update", affectedRows = updateCount,
                            duration = duration, sql = truncateSql(sql),
                            executedAt = LocalDateTime.now().format(timeFormatter)
                        ))
                    }

                    hasResult = stmt.moreResults
                }

                if (results.isEmpty()) {
                    results.add(SqlResult(
                        type = "update", affectedRows = 0,
                        duration = System.currentTimeMillis() - start, sql = truncateSql(sql),
                        executedAt = LocalDateTime.now().format(timeFormatter)
                    ))
                }

                results
            }
        } catch (e: Exception) {
            val duration = System.currentTimeMillis() - start
            listOf(SqlResult(
                type = "error", duration = duration, sql = truncateSql(sql),
                executedAt = LocalDateTime.now().format(timeFormatter),
                error = e.message ?: "SQL 执行异常"
            ))
        }
    }

    /**
     * 查询预览模式：
     * - 仅加载一页结果，避免一次性把整个结果集读入 JVM / 前端
     * - 支持 offset 分页（通过重新执行查询并跳过前 N 行实现，先保证正确性）
     * - 超长单元格会截断，降低传输与渲染开销
     */
    fun previewQuery(
        session: DatabaseSession,
        database: String,
        sql: String,
        offset: Int,
        pageSize: Int,
        maxCellChars: Int
    ): SqlResult {
        val jdbcSession = session as? com.easydb.common.DatabaseSession
            ?: return SqlResult(
                type = "error",
                duration = 0,
                sql = sql,
                executedAt = LocalDateTime.now().format(timeFormatter),
                error = "无效的数据库会话"
            )

        val start = System.currentTimeMillis()
        val safeOffset = offset.coerceAtLeast(0)
        val safePageSize = pageSize.coerceIn(1, 1000)
        val safeMaxCellChars = maxCellChars.coerceIn(128, 16 * 1024)

        return try {
            val conn = getConnection(jdbcSession)

            conn.createStatement().use { stmt ->
                stmt.execute("USE `$database`")
            }

            conn.createStatement(
                java.sql.ResultSet.TYPE_FORWARD_ONLY,
                java.sql.ResultSet.CONCUR_READ_ONLY
            ).use { stmt ->
                stmt.fetchSize = safePageSize.coerceAtLeast(100)
                stmt.queryTimeout = 120

                val hasResult = stmt.execute(sql)
                val duration = System.currentTimeMillis() - start

                if (!hasResult) {
                    val updateCount = stmt.updateCount
                    return if (updateCount >= 0) {
                        SqlResult(
                            type = "update",
                            affectedRows = updateCount,
                            duration = duration,
                            sql = sql,
                            executedAt = LocalDateTime.now().format(timeFormatter)
                        )
                    } else {
                        SqlResult(
                            type = "error",
                            duration = duration,
                            sql = sql,
                            executedAt = LocalDateTime.now().format(timeFormatter),
                            error = "当前语句没有可预览的结果集"
                        )
                    }
                }

                stmt.resultSet.use { rs ->
                    val meta = rs.metaData
                    val columnCount = meta.columnCount
                    val columns = (1..columnCount).map { meta.getColumnLabel(it) }
                    val rows = mutableListOf<Map<String, String?>>()
                    var skipped = 0
                    var truncatedCellCount = 0

                    while (skipped < safeOffset && rs.next()) {
                        skipped++
                    }

                    var hasMore = false
                    while (rs.next()) {
                        if (rows.size >= safePageSize) {
                            hasMore = true
                            break
                        }

                        val row = mutableMapOf<String, String?>()
                        for (i in 1..columnCount) {
                            val value = rs.getString(i)
                            row[columns[i - 1]] = when {
                                value == null -> null
                                value.length > safeMaxCellChars -> {
                                    truncatedCellCount++
                                    value.take(safeMaxCellChars) + " …[truncated]"
                                }
                                else -> value
                            }
                        }
                        rows.add(row)
                    }

                    SqlResult(
                        type = "query",
                        columns = columns,
                        rows = rows,
                        preview = true,
                        hasMore = hasMore,
                        offset = safeOffset,
                        pageSize = safePageSize,
                        loadedRows = rows.size,
                        truncatedCellCount = truncatedCellCount,
                        duration = System.currentTimeMillis() - start,
                        sql = sql,
                        executedAt = LocalDateTime.now().format(timeFormatter)
                    )
                }
            }
        } catch (e: Exception) {
            SqlResult(
                type = "error",
                duration = System.currentTimeMillis() - start,
                sql = sql,
                executedAt = LocalDateTime.now().format(timeFormatter),
                error = e.message ?: "SQL 预览异常"
            )
        }
    }

    /**
     * 流式导入 SQL 文件。
     * 以“读一段 -> 解析出完整语句 -> 立即执行”的方式进行，避免整体读入前端/后端内存。
     */
    fun importSqlFile(
        session: DatabaseSession,
        database: String,
        file: File,
        reporter: TaskReporter
    ): TaskResult {
        if (!file.exists() || !file.isFile) {
            return TaskResult(success = false, errorMessage = "SQL 文件不存在或不可读")
        }

        val jdbcSession = session as? com.easydb.common.DatabaseSession
            ?: return TaskResult(success = false, errorMessage = "无效的数据库会话")

        val totalBytes = file.length().coerceAtLeast(1L)
        val conn = getConnection(jdbcSession)

        reporter.onLog("INFO", "开始流式导入 SQL 文件: ${file.absolutePath}")
        reporter.onLog("INFO", "文件大小: ${formatBytes(totalBytes)}")
        reporter.onProgress(IMPORT_PROGRESS_MIN, "正在初始化 SQL 文件导入...")

        conn.createStatement().use { stmt ->
            stmt.execute("USE `$database`")
        }

        val state = SqlParseState()
        val currentStatement = StringBuilder()
        var successCount = 0
        var failureCount = 0
        var skippedCount = 0
        var lastProgressBytes = 0L

        fun updateProgress(bytesRead: Long, message: String? = null) {
            reporter.onProgress(
                calculateImportProgress(bytesRead, totalBytes),
                message ?: "正在导入 SQL 文件... 已读取 ${formatBytes(bytesRead)}/${formatBytes(totalBytes)}，已执行 ${successCount + failureCount} 条语句"
            )
        }

        fun executeStatement(stmt: Statement, sql: String) {
            if (reporter.isCancelled()) return

            val normalizedSql = normalizeSqlStatement(sql)
            if (normalizedSql.isBlank()) {
                skippedCount++
                return
            }

            val result = executeImportStatement(stmt, normalizedSql)
            if (result.errorMessage != null) {
                failureCount++
                reporter.onLog(
                    "ERROR",
                    "[${successCount + failureCount}] 失败: ${result.errorMessage}\n  → ${previewSql(normalizedSql)}"
                )
            } else {
                successCount++
                if (successCount <= 3 || successCount % IMPORT_LOG_EVERY_STATEMENTS == 0) {
                    val suffix = if (result.affectedRows > 0) "（影响 ${result.affectedRows} 行）" else ""
                    reporter.onLog("INFO", "已执行 ${successCount + failureCount} 条语句，最近成功$suffix：${previewSql(normalizedSql)}")
                }
            }

            if ((successCount + failureCount) % IMPORT_PROGRESS_LOG_EVERY_STATEMENTS == 0) {
                updateProgress(
                    lastProgressBytes.coerceAtLeast(0L),
                    "正在导入 SQL 文件... 已读取 ${formatBytes(lastProgressBytes)}/${formatBytes(totalBytes)}，已执行 ${successCount + failureCount} 条语句"
                )
            }
        }

        CountingInputStream(FileInputStream(file)).use { input ->
            BufferedReader(InputStreamReader(input, Charsets.UTF_8), 128 * 1024).use { reader ->
                conn.createStatement().use { stmt ->
                    stmt.queryTimeout = 0

                    var line = reader.readLine()
                    while (line != null) {
                        if (reporter.isCancelled()) break

                        parseSqlChunk("$line\n", state, currentStatement) { sql ->
                            lastProgressBytes = input.bytesRead
                            executeStatement(stmt, sql)
                        }

                        val bytesRead = input.bytesRead
                        if (bytesRead - lastProgressBytes >= IMPORT_PROGRESS_UPDATE_EVERY_BYTES) {
                            lastProgressBytes = bytesRead
                            updateProgress(bytesRead)
                        }

                        line = reader.readLine()
                    }

                    if (!reporter.isCancelled()) {
                        val tail = normalizeSqlStatement(currentStatement.toString())
                        if (tail.isNotBlank()) {
                            lastProgressBytes = input.bytesRead
                            executeStatement(stmt, tail)
                        }
                    }
                }
            }
        }

        if (reporter.isCancelled()) {
            reporter.onLog(
                "WARN",
                "导入已取消：成功 ${successCount}，失败 ${failureCount}，跳过 ${skippedCount}"
            )
            return TaskResult(
                success = false,
                successCount = successCount,
                failureCount = failureCount,
                skippedCount = skippedCount,
                errorMessage = "导入已取消"
            )
        }

        val summary = "导入完成：成功 ${successCount}，失败 ${failureCount}，跳过 ${skippedCount}"
        if (failureCount > 0) {
            reporter.onLog("WARN", summary)
        } else {
            reporter.onLog("INFO", summary)
        }

        return TaskResult(
            success = failureCount == 0,
            successCount = successCount,
            failureCount = failureCount,
            skippedCount = skippedCount,
            errorMessage = if (failureCount > 0) "部分 SQL 语句执行失败，请查看日志" else null
        )
    }

    /**
     * 提取底层 JDBC Connection
     * 通过反射获取 MysqlDatabaseSession 的 connection 字段
     * 避免 common 模块直接依赖 drivers/mysql
     */
    private fun getConnection(session: DatabaseSession): java.sql.Connection {
        val field = session.javaClass.getDeclaredField("connection")
        field.isAccessible = true
        return field.get(session) as java.sql.Connection
    }

    private fun parseSqlChunk(
        chunk: String,
        state: SqlParseState,
        currentStatement: StringBuilder,
        onStatement: (String) -> Unit
    ) {
        var index = 0
        while (index < chunk.length) {
            val ch = chunk[index]
            val next = chunk.getOrNull(index + 1)

            if (!state.inSingleQuote && !state.inDoubleQuote && !state.inBacktick && !state.inBlockComment) {
                if (ch == '-' && next == '-') {
                    state.inLineComment = true
                    currentStatement.append(ch).append(next)
                    index += 2
                    continue
                }
                if (ch == '#' && !state.inLineComment) {
                    state.inLineComment = true
                    currentStatement.append(ch)
                    index++
                    continue
                }
            }

            if (state.inLineComment) {
                currentStatement.append(ch)
                if (ch == '\n') {
                    state.inLineComment = false
                }
                index++
                continue
            }

            if (!state.inSingleQuote && !state.inDoubleQuote && !state.inBacktick) {
                if (ch == '/' && next == '*' && !state.inBlockComment) {
                    state.inBlockComment = true
                    currentStatement.append(ch).append(next)
                    index += 2
                    continue
                }
            }

            if (state.inBlockComment) {
                currentStatement.append(ch)
                if (ch == '*' && next == '/') {
                    currentStatement.append(next)
                    index += 2
                    state.inBlockComment = false
                    continue
                }
                index++
                continue
            }

            if (!state.inDoubleQuote && !state.inBacktick && ch == '\'' && !isEscaped(currentStatement)) {
                state.inSingleQuote = !state.inSingleQuote
            } else if (!state.inSingleQuote && !state.inBacktick && ch == '"' && !isEscaped(currentStatement)) {
                state.inDoubleQuote = !state.inDoubleQuote
            } else if (!state.inSingleQuote && !state.inDoubleQuote && ch == '`') {
                state.inBacktick = !state.inBacktick
            }

            if (ch == ';' && !state.inSingleQuote && !state.inDoubleQuote && !state.inBacktick) {
                val statement = currentStatement.toString().trim()
                if (statement.isNotBlank() && !isCommentOnly(statement)) {
                    onStatement(statement)
                }
                currentStatement.clear()
                index++
                continue
            }

            currentStatement.append(ch)

            // B3 增强：超长 INSERT...VALUES 自动拆分为多个小批次
            // 当累积超过 8MB 且处于非引号上下文时，尝试按 VALUES 行边界切割
            if (currentStatement.length > BATCH_SPLIT_THRESHOLD
                && !state.inSingleQuote && !state.inDoubleQuote && !state.inBacktick
                && !state.inBlockComment && !state.inLineComment
            ) {
                val accumulated = currentStatement.toString()
                val insertHeader = tryExtractInsertHeader(accumulated)

                if (insertHeader != null) {
                    // 找到最后一个完整的 '),\n' 或 '), ' 边界
                    val lastSplitPos = findLastValueSetBoundary(accumulated)
                    if (lastSplitPos > insertHeader.length) {
                        // 截取到最后一个完整的 value set，作为一个批次提交
                        val batch = accumulated.substring(0, lastSplitPos)
                        onStatement(batch)
                        // 保留 INSERT 头 + 剩余部分继续累积
                        val remaining = accumulated.substring(lastSplitPos + 1).trimStart(',', ' ', '\n', '\r')
                        currentStatement.clear()
                        currentStatement.append(insertHeader).append(remaining)
                    }
                } else if (currentStatement.length > MAX_SINGLE_SQL_SIZE_BYTES) {
                    // 非 INSERT 语句超过 32MB 硬上限，仍然报错
                    val preview = currentStatement.substring(0, 200.coerceAtMost(currentStatement.length))
                    currentStatement.clear()
                    throw IllegalStateException(
                        "单条 SQL 语句体积超过 ${MAX_SINGLE_SQL_SIZE_BYTES / 1024 / 1024} MB，" +
                        "为避免内存溢出已中断导入。请检查文件中是否有超长语句。语句开头：$preview"
                    )
                }
            }

            index++
        }
    }

    private fun normalizeSqlStatement(statement: String): String {
        return statement.trim().removePrefix("\uFEFF").trim()
    }

    /**
     * 尝试提取 INSERT INTO ... VALUES 的头部（不含具体值）。
     * 如果语句不是 INSERT...VALUES 模式，返回 null。
     */
    private fun tryExtractInsertHeader(sql: String): String? {
        val upper = sql.trimStart().take(500).uppercase()
        if (!upper.startsWith("INSERT")) return null

        val valuesIdx = upper.indexOf("VALUES")
        if (valuesIdx < 0) return null

        val headerEnd = valuesIdx + "VALUES".length
        return sql.substring(0, headerEnd) + " "
    }

    /**
     * 在 INSERT...VALUES (...),(...),... 中从尾部往前找最后一个完整的 `)` + `,` 边界。
     * 返回 `)` 之后的位置（切割点），用于将 VALUES 拆分为两段。
     */
    private fun findLastValueSetBoundary(sql: String): Int {
        var i = sql.length - 1
        // 跳过尾部的空白和逗号
        while (i > 0 && (sql[i] == ' ' || sql[i] == '\n' || sql[i] == '\r' || sql[i] == '\t')) {
            i--
        }
        // 从当前位置往前找 ),
        while (i > 0) {
            if (sql[i] == ')') {
                // 检查后面是否有逗号（即后续还有 value set）
                val afterClose = sql.substring(i + 1).trimStart()
                if (afterClose.startsWith(",") || afterClose.startsWith("(")) {
                    return i + 1
                }
            }
            i--
        }
        return -1
    }

    private fun isEscaped(buffer: StringBuilder): Boolean {
        var count = 0
        var index = buffer.length - 1
        while (index >= 0 && buffer[index] == '\\') {
            count++
            index--
        }
        return count % 2 == 1
    }

    private fun isCommentOnly(statement: String): Boolean {
        val lines = statement
            .lineSequence()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .toList()

        if (lines.isEmpty()) return true
        return lines.all { line ->
            if (line.startsWith("/*!")) {
                false
            } else {
                line.startsWith("--") || line.startsWith("#") || line.startsWith("/*")
            }
        }
    }

    private fun calculateImportProgress(bytesRead: Long, totalBytes: Long): Int {
        if (totalBytes <= 0L) return IMPORT_PROGRESS_MIN
        val ratio = bytesRead.coerceIn(0L, totalBytes).toDouble() / totalBytes.toDouble()
        return (IMPORT_PROGRESS_MIN + (ratio * (IMPORT_PROGRESS_MAX_BEFORE_COMPLETE - IMPORT_PROGRESS_MIN)).toInt())
            .coerceIn(IMPORT_PROGRESS_MIN, IMPORT_PROGRESS_MAX_BEFORE_COMPLETE)
    }

    private fun previewSql(sql: String, maxLength: Int = 120): String {
        val compact = sql.replace(Regex("\\s+"), " ").trim()
        return if (compact.length <= maxLength) compact else compact.take(maxLength) + "..."
    }

    private fun formatBytes(bytes: Long): String {
        val units = listOf("B", "KB", "MB", "GB", "TB")
        var value = bytes.toDouble()
        var unitIndex = 0
        while (value >= 1024 && unitIndex < units.lastIndex) {
            value /= 1024
            unitIndex++
        }
        return if (unitIndex == 0) {
            "${bytes} ${units[unitIndex]}"
        } else {
            String.format("%.1f %s", value, units[unitIndex])
        }
    }

    private fun executeImportStatement(stmt: Statement, sql: String): ImportStatementResult {
        return try {
            var hasResult = stmt.execute(sql)
            var totalAffectedRows = 0

            while (true) {
                if (hasResult) {
                    stmt.resultSet?.use { _ -> }
                } else {
                    val updateCount = stmt.updateCount
                    if (updateCount == -1) break
                    if (updateCount > 0) {
                        totalAffectedRows += updateCount
                    }
                }
                hasResult = stmt.moreResults
            }

            ImportStatementResult(affectedRows = totalAffectedRows)
        } catch (e: Exception) {
            ImportStatementResult(errorMessage = e.message ?: "SQL 执行异常")
        }
    }
}

private data class SqlParseState(
    var inSingleQuote: Boolean = false,
    var inDoubleQuote: Boolean = false,
    var inBacktick: Boolean = false,
    var inLineComment: Boolean = false,
    var inBlockComment: Boolean = false
)

private data class ImportStatementResult(
    val affectedRows: Int = 0,
    val errorMessage: String? = null
)

private class CountingInputStream(input: InputStream) : FilterInputStream(input) {
    var bytesRead: Long = 0
        private set

    override fun read(): Int {
        val value = super.read()
        if (value >= 0) bytesRead++
        return value
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        val count = super.read(b, off, len)
        if (count > 0) bytesRead += count.toLong()
        return count
    }
}
