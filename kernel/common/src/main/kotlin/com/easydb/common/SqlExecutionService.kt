package com.easydb.common

import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * SQL 执行服务
 * 在给定的数据库会话上执行 SQL，返回结构化结果
 * 支持单条和多条 SQL 语句（以分号分隔）
 */
class SqlExecutionService {

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
            val conn = getConnection(session)

            // 切换到目标数据库
            conn.createStatement().use { stmt ->
                stmt.execute("USE `$database`")
            }

            conn.createStatement().use { stmt ->
                var hasResult = stmt.execute(sql)
                val results = mutableListOf<SqlResult>()

                while (true) {
                    val duration = System.currentTimeMillis() - start

                    if (hasResult) {
                        // SELECT 查询 — 返回结果集
                        val rs = stmt.resultSet
                        val meta = rs.metaData
                        val columnCount = meta.columnCount
                        val columns = (1..columnCount).map { meta.getColumnLabel(it) }
                        val rows = mutableListOf<Map<String, String?>>()

                        while (rs.next()) {
                            val row = mutableMapOf<String, String?>()
                            for (i in 1..columnCount) {
                                row[columns[i - 1]] = rs.getString(i)
                            }
                            rows.add(row)
                        }
                        rs.close()

                        results.add(SqlResult(
                            type = "query", columns = columns, rows = rows,
                            duration = duration, sql = sql,
                            executedAt = LocalDateTime.now().format(timeFormatter)
                        ))
                    } else {
                        val updateCount = stmt.updateCount
                        if (updateCount == -1) {
                            // 没有更多结果了
                            break
                        }
                        // UPDATE/INSERT/DELETE — 返回影响行数
                        results.add(SqlResult(
                            type = "update", affectedRows = updateCount,
                            duration = duration, sql = sql,
                            executedAt = LocalDateTime.now().format(timeFormatter)
                        ))
                    }

                    hasResult = stmt.moreResults
                }

                // 如果没有收集到任何结果（不应该发生），返回空 update 结果
                if (results.isEmpty()) {
                    results.add(SqlResult(
                        type = "update", affectedRows = 0,
                        duration = System.currentTimeMillis() - start, sql = sql,
                        executedAt = LocalDateTime.now().format(timeFormatter)
                    ))
                }

                results
            }
        } catch (e: Exception) {
            val duration = System.currentTimeMillis() - start
            listOf(SqlResult(
                type = "error", duration = duration, sql = sql,
                executedAt = LocalDateTime.now().format(timeFormatter),
                error = e.message ?: "SQL 执行异常"
            ))
        }
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
}
