/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
package com.easydb.drivers.mysql

import com.easydb.common.*
import java.sql.Connection
import java.sql.DriverManager
import java.util.Properties

/**
 * MySQL 连接适配器
 * 负责创建、测试、关闭 MySQL JDBC 连接
 */
class MysqlConnectionAdapter : ConnectionAdapter {

    override fun testConnection(config: ConnectionConfig): ConnectionTestResult {
        val start = System.currentTimeMillis()
        return try {
            createJdbcConnection(config).use { conn ->
                val valid = conn.isValid(5)
                val latency = System.currentTimeMillis() - start
                if (valid) {
                    ConnectionTestResult(success = true, message = "连接成功", latencyMs = latency)
                } else {
                    ConnectionTestResult(success = false, message = "连接验证失败")
                }
            }
        } catch (e: Exception) {
            ConnectionTestResult(success = false, message = e.message ?: "连接失败")
        }
    }

    override fun open(config: ConnectionConfig): DatabaseSession {
        val conn = createJdbcConnection(config)
        return MysqlDatabaseSession(
            connectionId = config.id,
            config = config,
            connection = conn
        )
    }

    override fun close(session: DatabaseSession) {
        session.close()
    }

    companion object {
        /**
         * 创建 JDBC 连接
         */
        fun createJdbcConnection(config: ConnectionConfig): Connection {
            Class.forName("com.mysql.cj.jdbc.Driver")

            val props = Properties().apply {
                setProperty("user", config.username)
                setProperty("password", config.password)
                setProperty("connectTimeout", "5000")
                setProperty("socketTimeout", "300000") // 设置为5分钟，绝对不能设置为 0 (无限等待)，否则在防火墙丢包或连接数被打满时会导致后端线程永久挂起
                setProperty("useSSL", "false")
                setProperty("allowPublicKeyRetrieval", "true")
                setProperty("allowMultiQueries", "true") // 支持多语句执行
                setProperty("serverTimezone", "UTC")
                setProperty("characterEncoding", "UTF-8")
                setProperty("rewriteBatchedStatements", "true") // 批量写入优化：合并为多值 INSERT
                setProperty("cachePrepStmts", "true")
            }

            val db = config.database?.let { "/$it" } ?: ""
            val url = "jdbc:mysql://${config.host}:${config.port}$db"
            return DriverManager.getConnection(url, props)
        }
    }
}
