package com.easydb.common

import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * SQL 执行服务
 * 在给定的数据库会话上执行 SQL，返回结构化结果
 */
class SqlExecutionService {

    private val timeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

    fun execute(session: DatabaseSession, database: String, sql: String): SqlResult {
        val jdbcSession = session as? com.easydb.common.DatabaseSession
            ?: return SqlResult(
                type = "error", duration = 0, sql = sql,
                executedAt = LocalDateTime.now().format(timeFormatter),
                error = "无效的数据库会话"
            )

        val start = System.currentTimeMillis()
        return try {
            val conn = getConnection(session)

            // 切换到目标数据库
            conn.createStatement().use { stmt ->
                stmt.execute("USE `$database`")
            }

            conn.createStatement().use { stmt ->
                val hasResultSet = stmt.execute(sql)
                val duration = System.currentTimeMillis() - start

                if (hasResultSet) {
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

                    SqlResult(
                        type = "query", columns = columns, rows = rows,
                        duration = duration, sql = sql,
                        executedAt = LocalDateTime.now().format(timeFormatter)
                    )
                } else {
                    // UPDATE/INSERT/DELETE — 返回影响行数
                    SqlResult(
                        type = "update", affectedRows = stmt.updateCount,
                        duration = duration, sql = sql,
                        executedAt = LocalDateTime.now().format(timeFormatter)
                    )
                }
            }
        } catch (e: Exception) {
            val duration = System.currentTimeMillis() - start
            SqlResult(
                type = "error", duration = duration, sql = sql,
                executedAt = LocalDateTime.now().format(timeFormatter),
                error = e.message ?: "SQL 执行异常"
            )
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
