package com.easydb.launcher

import com.easydb.common.*
import com.easydb.drivers.mysql.MysqlDatabaseAdapter

/**
 * 服务注册中心
 * 全局单例，持有所有内核服务实例
 */
object ServiceRegistry {
    val mysqlAdapter = MysqlDatabaseAdapter()
    val connectionManager = ConnectionManager()
    val sqlService = SqlExecutionService()
    val connectionStore = ConnectionStore()
    val taskManager = TaskManager()
    val sqlHistoryStore = SqlHistoryStore()
}
