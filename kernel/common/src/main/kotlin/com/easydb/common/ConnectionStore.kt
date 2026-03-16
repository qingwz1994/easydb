package com.easydb.common

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 连接配置持久化存储
 * 使用本地 JSON 文件保存连接信息，内存中维护 ConcurrentHashMap 作为缓存
 *
 * 存储路径：~/.easydb/connections.json
 */
class ConnectionStore(
    private val storageDir: File = File(System.getProperty("user.home"), ".easydb")
) {
    private val storageFile = File(storageDir, "connections.json")
    private val cache = ConcurrentHashMap<String, ConnectionConfig>()

    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    init {
        loadFromDisk()
    }

    /** 获取所有连接 */
    fun getAll(): List<ConnectionConfig> = cache.values.toList()

    /** 根据 ID 获取 */
    fun getById(id: String): ConnectionConfig? = cache[id]

    /** 保存连接（新建或更新） */
    fun save(config: ConnectionConfig): ConnectionConfig {
        cache[config.id] = config
        saveToDisk()
        return config
    }

    /** 删除连接 */
    fun delete(id: String): Boolean {
        val removed = cache.remove(id) != null
        if (removed) saveToDisk()
        return removed
    }

    /** 更新连接状态 */
    fun updateStatus(id: String, status: String) {
        cache[id]?.let {
            cache[id] = it.copy(status = status)
            saveToDisk()
        }
    }

    /** 是否包含该连接 */
    fun contains(id: String): Boolean = cache.containsKey(id)

    /** 连接数量 */
    fun count(): Int = cache.size

    // ─── 磁盘 I/O ───────────────────────────────────────────

    private fun loadFromDisk() {
        if (!storageFile.exists()) return
        try {
            val text = storageFile.readText()
            if (text.isBlank()) return
            val list = json.decodeFromString<List<ConnectionConfig>>(text)
            list.forEach { cache[it.id] = it.copy(status = "disconnected") }
        } catch (e: Exception) {
            System.err.println("[ConnectionStore] Failed to load connections: ${e.message}")
        }
    }

    @Synchronized
    private fun saveToDisk() {
        try {
            storageDir.mkdirs()
            val list = cache.values.toList().map {
                // 持久化时清除运行时状态
                it.copy(status = "disconnected")
            }
            storageFile.writeText(json.encodeToString(list))
        } catch (e: Exception) {
            System.err.println("[ConnectionStore] Failed to save connections: ${e.message}")
        }
    }
}
