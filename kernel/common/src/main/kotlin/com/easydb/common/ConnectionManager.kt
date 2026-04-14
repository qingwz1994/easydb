package com.easydb.common

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * 连接管理器
 * 管理所有活跃的数据库连接会话
 *
 * 增强机制：
 * - 双连接分离：每个 connectionId 持有两个独立 session
 *   · primarySession：元数据浏览（树/预览/DDL）专用
 *   · sqlSession：SQL 编辑器 execute 专用
 *   两者互不阻塞，解决"SQL 执行时工作台卡住"的问题
 * - 心跳保活：每 60 秒对所有活跃会话执行 isValid 检查
 * - 自动重连：检测到连接失效时，使用原始 config 自动重建
 */
class ConnectionManager {

    /**
     * 会话条目：保存双 session + 创建它的 adapter + 原始 config
     */
    private data class SessionEntry(
        val primarySession: DatabaseSession,   // 元数据浏览专用
        val sqlSession: DatabaseSession,       // SQL 编辑器执行专用
        val adapter: ConnectionAdapter,
        val config: ConnectionConfig
    )

    private val entries = ConcurrentHashMap<String, SessionEntry>()

    /**
     * 心跳线程：定期检查所有活跃连接的有效性
     */
    private val heartbeat: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "conn-heartbeat").apply { isDaemon = true }
    }

    init {
        heartbeat.scheduleAtFixedRate(::pingAll, 60, 60, TimeUnit.SECONDS)
    }

    /**
     * 打开连接：同时创建 primary 和 sql 两个 session
     * 返回 primarySession（向后兼容）
     */
    fun openSession(adapter: ConnectionAdapter, config: ConnectionConfig): DatabaseSession {
        closeSession(config.id)

        val primarySession = adapter.open(config)
        val sqlSession = adapter.open(config)
        entries[config.id] = SessionEntry(primarySession, sqlSession, adapter, config)
        return primarySession
    }

    /**
     * 获取元数据浏览会话（工作台树、表预览、DDL 等）
     * 兼容旧调用方：与原来的 getSession 行为一致
     */
    fun getSession(connectionId: String): DatabaseSession? {
        return getPrimarySession(connectionId)
    }

    /**
     * 获取元数据浏览专用会话
     */
    fun getPrimarySession(connectionId: String): DatabaseSession? {
        val entry = entries[connectionId] ?: return null
        if (!entry.primarySession.isValid()) {
            val reconnected = tryReconnectPrimary(connectionId, entry)
            if (reconnected != null) return reconnected
            // primary 重连失败不移除整个 entry（sqlSession 可能还活着）
            return null
        }
        return entry.primarySession
    }

    /**
     * 获取 SQL 执行专用会话
     * SQL 编辑器的 execute 操作使用此连接，不占用 primarySession
     */
    fun getSqlSession(connectionId: String): DatabaseSession? {
        val entry = entries[connectionId] ?: return null
        if (!entry.sqlSession.isValid()) {
            val reconnected = tryReconnectSql(connectionId, entry)
            if (reconnected != null) return reconnected
            return null
        }
        return entry.sqlSession
    }

    /**
     * 关闭指定连接的所有会话
     */
    fun closeSession(connectionId: String) {
        val entry = entries.remove(connectionId) ?: return
        entry.primarySession.close()
        entry.sqlSession.close()
    }

    /**
     * 关闭所有会话
     */
    fun closeAll() {
        entries.values.forEach {
            it.primarySession.close()
            it.sqlSession.close()
        }
        entries.clear()
    }

    /**
     * 停止心跳线程（应用关闭时调用）
     */
    fun shutdown() {
        heartbeat.shutdown()
        try {
            heartbeat.awaitTermination(3, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            heartbeat.shutdownNow()
        }
        closeAll()
    }

    /**
     * 获取所有活跃连接 ID
     */
    fun activeConnectionIds(): Set<String> = entries.keys.toSet()

    // ─── 内部方法 ──────────────────────────────────────────

    /**
     * 心跳：遍历所有活跃会话，检查有效性并尝试重连
     */
    private fun pingAll() {
        for ((id, entry) in entries) {
            try {
                if (!entry.primarySession.isValid()) {
                    tryReconnectPrimary(id, entry)
                }
            } catch (_: Exception) {}

            try {
                if (!entry.sqlSession.isValid()) {
                    tryReconnectSql(id, entry)
                }
            } catch (_: Exception) {}
        }
    }

    /**
     * 重连 primarySession
     */
    private fun tryReconnectPrimary(connectionId: String, entry: SessionEntry): DatabaseSession? {
        return try {
            try { entry.primarySession.close() } catch (_: Exception) {}
            val newSession = entry.adapter.open(entry.config)
            entries[connectionId] = entry.copy(primarySession = newSession)
            newSession
        } catch (_: Exception) {
            null
        }
    }

    /**
     * 重连 sqlSession
     */
    private fun tryReconnectSql(connectionId: String, entry: SessionEntry): DatabaseSession? {
        return try {
            try { entry.sqlSession.close() } catch (_: Exception) {}
            val newSession = entry.adapter.open(entry.config)
            entries[connectionId] = entry.copy(sqlSession = newSession)
            newSession
        } catch (_: Exception) {
            null
        }
    }
}
