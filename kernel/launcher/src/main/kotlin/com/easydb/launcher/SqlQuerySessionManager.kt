package com.easydb.launcher

import com.easydb.common.DatabaseSession
import com.easydb.common.SqlResult
import com.easydb.drivers.mysql.MysqlConnectionAdapter
import com.easydb.drivers.mysql.MysqlDatabaseSession
import java.sql.Connection
import java.sql.ResultSet
import java.sql.Statement
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class SqlQuerySessionManager {

    companion object {
        private const val MIN_PAGE_SIZE = 1
        private const val MAX_PAGE_SIZE = 1000
        private const val MIN_CELL_CHARS = 128
        private const val MAX_CELL_CHARS = 16 * 1024
        private const val IDLE_TIMEOUT_MILLIS = 10 * 60 * 1000L
        private const val QUERY_TIMEOUT_SECONDS = 120
        private const val TRUNCATED_SQL_CELL_SUFFIX = " …[truncated]"
    }

    private val sessions = ConcurrentHashMap<String, QuerySession>()
    private val timeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
    private val countExecutor = Executors.newCachedThreadPool()

    fun start(
        session: DatabaseSession,
        database: String,
        sql: String,
        pageSize: Int,
        maxCellChars: Int
    ): SqlResult {
        cleanupExpiredSessions()

        val jdbcSession = session as? MysqlDatabaseSession
            ?: return errorResult(sql, "无效的数据库会话", 0L)

        val safePageSize = pageSize.coerceIn(MIN_PAGE_SIZE, MAX_PAGE_SIZE)
        val safeMaxCellChars = maxCellChars.coerceIn(MIN_CELL_CHARS, MAX_CELL_CHARS)
        val startAt = System.currentTimeMillis()
        var dedicatedConnection: Connection? = null
        var statement: Statement? = null
        var createdSessionId: String? = null

        return try {
            val dedicatedConfig = jdbcSession.config.copy(database = database)
            dedicatedConnection = MysqlConnectionAdapter.createJdbcConnection(dedicatedConfig)

            dedicatedConnection.createStatement().use { useStatement ->
                useStatement.execute("USE `${escapeIdentifier(database)}`")
            }

            statement = dedicatedConnection.createStatement(
                ResultSet.TYPE_FORWARD_ONLY,
                ResultSet.CONCUR_READ_ONLY
            ).apply {
                fetchSize = Integer.MIN_VALUE // MySQL 核心魔术常量，强制开启单向流式结果集传输
                queryTimeout = QUERY_TIMEOUT_SECONDS
            }

            val hasResult = statement.execute(sql)
            val duration = System.currentTimeMillis() - startAt
            if (!hasResult) {
                val updateCount = statement.updateCount
                closeQuietly(statement)
                closeQuietly(dedicatedConnection)
                return if (updateCount >= 0) {
                    SqlResult(
                        type = "update",
                        affectedRows = updateCount,
                        duration = duration,
                        sql = sql,
                        executedAt = now()
                    )
                } else {
                    errorResult(sql, "当前语句没有可预览的结果集", duration)
                }
            }

            val resultSet = statement.resultSet
            val meta = resultSet.metaData
            val columnCount = meta.columnCount
            val columns = (1..columnCount).map { meta.getColumnLabel(it) }
            val sessionId = UUID.randomUUID().toString()
            createdSessionId = sessionId

            val querySession = QuerySession(
                sessionId = sessionId,
                connectionId = jdbcSession.connectionId,
                sql = sql,
                executedAt = now(),
                database = database,
                totalRows = null, // 移除同步的 COUNT 阻塞，交由外层 scheduleResultRowCount 异步计算
                connection = dedicatedConnection,
                statement = statement,
                resultSet = resultSet,
                columns = columns
            )
            sessions[sessionId] = querySession

            val page = readNextPage(querySession, safePageSize, safeMaxCellChars)
            if (!page.hasMore) {
                querySession.totalRows = querySession.loadedRows
                removeAndCloseSession(sessionId)
            } else {
                scheduleResultRowCount(querySession, jdbcSession, database, sql)
            }

            val finalDuration = System.currentTimeMillis() - startAt
            SqlResult(
                type = "query",
                columns = columns,
                rows = page.rows,
                preview = true,
                hasMore = page.hasMore,
                querySessionId = sessionId,
                totalRows = querySession.totalRows,
                pageSize = safePageSize,
                loadedRows = page.rows.size,
                truncatedCellCount = page.truncatedCellCount,
                duration = finalDuration,
                sql = sql,
                executedAt = querySession.executedAt
            )
        } catch (e: Exception) {
            createdSessionId?.let { removeAndCloseSession(it) }
            closeQuietly(statement)
            closeQuietly(dedicatedConnection)
            errorResult(sql, e.message ?: "SQL 预览异常", System.currentTimeMillis() - startAt)
        }
    }

    fun fetch(querySessionId: String, pageSize: Int, maxCellChars: Int): SqlResult {
        cleanupExpiredSessions()

        val session = sessions[querySessionId]
            ?: return errorResult("", "查询会话不存在或已过期", 0L)

        val safePageSize = pageSize.coerceIn(MIN_PAGE_SIZE, MAX_PAGE_SIZE)
        val safeMaxCellChars = maxCellChars.coerceIn(MIN_CELL_CHARS, MAX_CELL_CHARS)
        val startAt = System.currentTimeMillis()

        return try {
            val page = readNextPage(session, safePageSize, safeMaxCellChars)
            if (!page.hasMore) {
                if (session.totalRows == null) {
                    session.totalRows = session.loadedRows
                }
                removeAndCloseSession(querySessionId)
            }

            SqlResult(
                type = "query",
                columns = session.columns,
                rows = page.rows,
                preview = true,
                hasMore = page.hasMore,
                querySessionId = querySessionId,
                totalRows = session.totalRows,
                pageSize = safePageSize,
                loadedRows = page.rows.size,
                truncatedCellCount = page.truncatedCellCount,
                duration = System.currentTimeMillis() - startAt,
                sql = session.sql,
                executedAt = session.executedAt
            )
        } catch (e: Exception) {
            removeAndCloseSession(querySessionId)
            errorResult(session.sql, e.message ?: "加载更多失败", System.currentTimeMillis() - startAt)
        }
    }

    fun close(querySessionId: String) {
        cleanupExpiredSessions()
        removeAndCloseSession(querySessionId)
    }

    fun getStatus(querySessionId: String): com.easydb.common.SqlQuerySessionStatus {
        cleanupExpiredSessions()
        val session = sessions[querySessionId]
            ?: return com.easydb.common.SqlQuerySessionStatus(
                querySessionId = querySessionId,
                exists = false
            )

        return com.easydb.common.SqlQuerySessionStatus(
            querySessionId = querySessionId,
            totalRows = session.totalRows,
            counting = session.counting,
            exists = true
        )
    }

    fun closeByConnectionId(connectionId: String) {
        cleanupExpiredSessions()
        sessions.entries
            .filter { it.value.connectionId == connectionId }
            .map { it.key }
            .forEach { removeAndCloseSession(it) }
    }

    private fun readNextPage(
        session: QuerySession,
        pageSize: Int,
        maxCellChars: Int
    ): PreviewPage {
        synchronized(session.lock) {
            val rows = mutableListOf<Map<String, String?>>()
            var truncatedCellCount = 0

            session.bufferedRow?.let { buffered ->
                rows.add(buffered.row)
                truncatedCellCount += buffered.truncatedCellCount
                session.bufferedRow = null
            }

            while (rows.size < pageSize && session.resultSet.next()) {
                val row = extractCurrentRow(session.resultSet, session.columns, maxCellChars)
                rows.add(row.row)
                truncatedCellCount += row.truncatedCellCount
            }

            val hasMore = session.resultSet.next()
            if (hasMore) {
                session.bufferedRow = extractCurrentRow(session.resultSet, session.columns, maxCellChars)
            }

            session.lastAccessAt = System.currentTimeMillis()
            session.loadedRows += rows.size.toLong()
            return PreviewPage(
                rows = rows,
                hasMore = hasMore,
                truncatedCellCount = truncatedCellCount
            )
        }
    }

    private fun scheduleResultRowCount(
        session: QuerySession,
        jdbcSession: MysqlDatabaseSession,
        database: String,
        sql: String
    ) {
        if (session.counting || session.totalRows != null) return
        session.counting = true

        countExecutor.submit {
            try {
                val totalRows = countResultRowsIfPossible(jdbcSession, database, sql)
                if (totalRows != null) {
                    session.totalRows = totalRows
                }
            } finally {
                session.counting = false
            }
        }
    }

    private fun extractCurrentRow(
        resultSet: ResultSet,
        columns: List<String>,
        maxCellChars: Int
    ): PreviewRow {
        var truncatedCellCount = 0
        val row = linkedMapOf<String, String?>()

        for ((index, column) in columns.withIndex()) {
            val value = resultSet.getString(index + 1)
            row[column] = when {
                value == null -> null
                value.length > maxCellChars -> {
                    truncatedCellCount++
                    value.take(maxCellChars) + TRUNCATED_SQL_CELL_SUFFIX
                }
                else -> value
            }
        }

        return PreviewRow(
            row = row,
            truncatedCellCount = truncatedCellCount
        )
    }

    private fun cleanupExpiredSessions() {
        val deadline = System.currentTimeMillis() - IDLE_TIMEOUT_MILLIS
        sessions.entries
            .filter { it.value.lastAccessAt < deadline }
            .map { it.key }
            .forEach { removeAndCloseSession(it) }
    }

    private fun countResultRowsIfPossible(
        session: MysqlDatabaseSession,
        database: String,
        sql: String
    ): Long? {
        val normalizedSql = sql.trimStart()
        if (!normalizedSql.startsWith("select", ignoreCase = true) &&
            !normalizedSql.startsWith("with", ignoreCase = true)
        ) {
            return null
        }

        return try {
            MysqlConnectionAdapter.createJdbcConnection(session.config.copy(database = database)).use { connection ->
                connection.createStatement().use { countStatement ->
                    countStatement.queryTimeout = QUERY_TIMEOUT_SECONDS
                    countStatement.execute("USE `${escapeIdentifier(database)}`")
                    countStatement.executeQuery(
                        "SELECT COUNT(*) FROM (${sql.trim().trimEnd(';')}) easydb_query_total"
                    )
                        .use { resultSet ->
                            if (resultSet.next()) resultSet.getLong(1) else null
                        }
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun removeAndCloseSession(querySessionId: String) {
        sessions.remove(querySessionId)?.close()
    }

    private fun errorResult(sql: String, message: String, duration: Long): SqlResult = SqlResult(
        type = "error",
        duration = duration,
        sql = sql,
        executedAt = now(),
        error = message
    )

    private fun escapeIdentifier(value: String): String = value.replace("`", "``")

    private fun now(): String = LocalDateTime.now().format(timeFormatter)

    private fun closeQuietly(resource: AutoCloseable?) {
        try {
            resource?.close()
        } catch (_: Exception) {
        }
    }

    private data class PreviewPage(
        val rows: List<Map<String, String?>>,
        val hasMore: Boolean,
        val truncatedCellCount: Int
    )

    private data class PreviewRow(
        val row: Map<String, String?>,
        val truncatedCellCount: Int
    )

    private data class QuerySession(
        val sessionId: String,
        val connectionId: String,
        val sql: String,
        val executedAt: String,
        val database: String,
        @Volatile var totalRows: Long?,
        val connection: Connection,
        val statement: Statement,
        val resultSet: ResultSet,
        val columns: List<String>,
        val lock: Any = Any(),
        var lastAccessAt: Long = System.currentTimeMillis(),
        var bufferedRow: PreviewRow? = null,
        var loadedRows: Long = 0,
        @Volatile var counting: Boolean = false
    ) {
        fun close() {
            try {
                resultSet.close()
            } catch (_: Exception) {
            }
            try {
                statement.close()
            } catch (_: Exception) {
            }
            try {
                connection.close()
            } catch (_: Exception) {
            }
        }
    }
}
