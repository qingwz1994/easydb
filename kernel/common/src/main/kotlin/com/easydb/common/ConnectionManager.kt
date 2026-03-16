package com.easydb.common

import java.util.concurrent.ConcurrentHashMap

/**
 * 连接管理器
 * 管理所有活跃的数据库连接会话
 */
class ConnectionManager {

    private val sessions = ConcurrentHashMap<String, DatabaseSession>()

    /**
     * 打开连接并缓存会话
     */
    fun openSession(adapter: ConnectionAdapter, config: ConnectionConfig): DatabaseSession {
        // 关闭已有同 ID 会话
        closeSession(config.id)

        val session = adapter.open(config)
        sessions[config.id] = session
        return session
    }

    /**
     * 获取已打开的会话
     */
    fun getSession(connectionId: String): DatabaseSession? {
        val session = sessions[connectionId]
        // 检查会话是否仍然有效
        if (session != null && !session.isValid()) {
            sessions.remove(connectionId)
            session.close()
            return null
        }
        return session
    }

    /**
     * 关闭指定连接会话
     */
    fun closeSession(connectionId: String) {
        sessions.remove(connectionId)?.close()
    }

    /**
     * 关闭所有会话
     */
    fun closeAll() {
        sessions.values.forEach { it.close() }
        sessions.clear()
    }

    /**
     * 获取所有活跃连接 ID
     */
    fun activeConnectionIds(): Set<String> = sessions.keys.toSet()
}
