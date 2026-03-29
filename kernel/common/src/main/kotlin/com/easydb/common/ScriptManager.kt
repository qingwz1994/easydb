package com.easydb.common

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@Serializable
data class SavedScript(
    val id: String,
    val name: String,
    val content: String,
    val database: String? = null,
    val createdAt: String,
    val updatedAt: String
)

/**
 * SQL 脚本收藏夹管理器
 * 存储路径：~/.easydb/scripts.json
 */
class ScriptManager(
    private val storageDir: File = File(System.getProperty("user.home"), ".easydb")
) {

    private val scripts = ConcurrentHashMap<String, SavedScript>()
    private val timeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
    private val storageFile = File(storageDir, "scripts.json")
    
    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    init {
        loadFromDisk()
    }

    /** 拉取所有收藏的脚本，按更新时间倒序排列 */
    fun list(): List<SavedScript> {
        return scripts.values.toList().sortedByDescending { it.updatedAt }
    }

    /** 保存或更新脚本文本 */
    fun save(name: String, content: String, database: String? = null, existingId: String? = null): SavedScript {
        val now = LocalDateTime.now().format(timeFormatter)
        
        val script = if (existingId != null && scripts.containsKey(existingId)) {
            val existing = scripts[existingId]!!
            existing.copy(
                name = name,
                content = content,
                database = database,
                updatedAt = now
            )
        } else {
            SavedScript(
                id = UUID.randomUUID().toString(),
                name = name,
                content = content,
                database = database,
                createdAt = now,
                updatedAt = now
            )
        }
        
        scripts[script.id] = script
        saveToDisk()
        return script
    }

    /** 删除指定的脚本 */
    fun delete(id: String): Boolean {
        if (!scripts.containsKey(id)) return false
        scripts.remove(id)
        saveToDisk()
        return true
    }

    private fun loadFromDisk() {
        if (!storageFile.exists()) return
        try {
            val text = storageFile.readText()
            if (text.isBlank()) return
            val list = json.decodeFromString<List<SavedScript>>(text)
            list.forEach { scripts[it.id] = it }
        } catch (e: Exception) {
            System.err.println("[ScriptManager] Failed to load scripts: ${e.message}")
        }
    }

    @Synchronized
    private fun saveToDisk() {
        try {
            storageDir.mkdirs()
            storageFile.writeText(json.encodeToString(scripts.values.toList()))
        } catch (e: Exception) {
            System.err.println("[ScriptManager] Failed to save scripts: ${e.message}")
        }
    }
}
