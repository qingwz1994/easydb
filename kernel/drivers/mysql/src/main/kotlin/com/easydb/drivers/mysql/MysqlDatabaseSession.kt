package com.easydb.drivers.mysql

import com.easydb.common.ConnectionConfig
import com.easydb.common.DatabaseSession
import java.sql.Connection

/**
 * MySQL 数据库会话
 * 封装 JDBC Connection，跟踪连接 ID 和配置
 */
class MysqlDatabaseSession(
    override val connectionId: String,
    override val config: ConnectionConfig,
    val connection: Connection
) : DatabaseSession {

    override fun isValid(): Boolean {
        return try {
            !connection.isClosed && connection.isValid(3)
        } catch (_: Exception) {
            false
        }
    }

    override fun close() {
        try {
            if (!connection.isClosed) {
                connection.close()
            }
        } catch (_: Exception) {
            // 忽略关闭异常
        }
    }

    override fun getJdbcConnection(): java.sql.Connection = connection
}
