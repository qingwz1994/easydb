package com.easydb.common

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 连接分组持久化存储
 * 使用本地 JSON 文件保存分组信息，内存中维护 ConcurrentHashMap 作为缓存
 *
 * 存储路径：~/.easydb/groups.json
 */
class GroupStore(
    private val storageDir: File = File(System.getProperty("user.home"), ".easydb")
) {
    private val storageFile = File(storageDir, "groups.json")
    private val cache = ConcurrentHashMap<String, ConnectionGroup>()

    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    init {
        loadFromDisk()
    }

    /** 获取所有分组 */
    fun getAll(): List<ConnectionGroup> = cache.values.sortedBy { it.sortOrder }.toList()

    /** 根据 ID 获取 */
    fun getById(id: String): ConnectionGroup? = cache[id]

    /** 保存分组（新建或更新） */
    fun save(group: ConnectionGroup): ConnectionGroup {
        cache[group.id] = group
        saveToDisk()
        return group
    }

    /** 删除分组 */
    fun delete(id: String): Boolean {
        val removed = cache.remove(id) != null
        if (removed) saveToDisk()
        return removed
    }

    // ─── 磁盘 I/O ───────────────────────────────────────────

    private fun loadFromDisk() {
        if (!storageFile.exists()) return
        try {
            val text = storageFile.readText()
            if (text.isBlank()) return
            val list = json.decodeFromString<List<ConnectionGroup>>(text)
            list.forEach { cache[it.id] = it }
        } catch (e: Exception) {
            System.err.println("[GroupStore] Failed to load groups: ${e.message}")
        }
    }

    @Synchronized
    private fun saveToDisk() {
        try {
            storageDir.mkdirs()
            val list = cache.values.toList().sortedBy { it.sortOrder }
            storageFile.writeText(json.encodeToString(list))
        } catch (e: Exception) {
            System.err.println("[GroupStore] Failed to save groups: ${e.message}")
        }
    }
}
