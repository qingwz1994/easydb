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
                setProperty("socketTimeout", "30000")
                setProperty("useSSL", "false")
                setProperty("allowPublicKeyRetrieval", "true")
                setProperty("serverTimezone", "UTC")
                setProperty("characterEncoding", "UTF-8")
            }

            val db = config.database?.let { "/$it" } ?: ""
            val url = "jdbc:mysql://${config.host}:${config.port}$db"
            return DriverManager.getConnection(url, props)
        }
    }
}
