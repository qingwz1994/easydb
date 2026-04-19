package com.easydb.launcher

import com.easydb.common.*
import com.easydb.drivers.mysql.MysqlDatabaseAdapter
import com.easydb.tunnel.SshTunnelManager

/**
 * 服务注册中心
 * 全局单例，持有所有内核服务实例
 */
object ServiceRegistry {
    val mysqlAdapter = MysqlDatabaseAdapter()
    val connectionManager = ConnectionManager()
    val sqlService = SqlExecutionService()
    val sqlQuerySessionManager = SqlQuerySessionManager()
    val connectionStore = ConnectionStore()
    val groupStore = GroupStore()
    val taskManager = TaskManager()
    val sqlHistoryStore = SqlHistoryStore()
    val scriptManager = ScriptManager()
    val changeTracker: ChangeTracker = MysqlBinlogTracker()
    val sshTunnelManager = SshTunnelManager()   // SSH 隧道管理器（P0）
}
