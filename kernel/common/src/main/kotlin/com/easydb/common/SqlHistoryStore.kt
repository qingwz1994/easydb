package com.easydb.common

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.time.Instant
import java.util.UUID

/**
 * SQL 执行历史持久化存储
 * 保存到 ~/.easydb/sql-history.json，最多保留 500 条
 */
class SqlHistoryStore(
    private val storageDir: File = File(System.getProperty("user.home"), ".easydb"),
    private val maxEntries: Int = 500
) {
    private val storageFile = File(storageDir, "sql-history.json")
    private val entries = mutableListOf<SqlHistoryEntry>()

    private val json = Json {
        prettyPrint = false
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    init {
        loadFromDisk()
    }

    /** 记录一条 SQL 执行历史 */
    fun add(connectionId: String, database: String, sql: String, result: SqlResult) {
        val entry = SqlHistoryEntry(
            id = UUID.randomUUID().toString(),
            connectionId = connectionId,
            database = database,
            sql = sql,
            type = result.type,
            duration = result.duration,
            rowCount = result.rows?.size?.toLong() ?: result.affectedRows?.toLong(),
            error = result.error,
            executedAt = result.executedAt
        )

        synchronized(entries) {
            entries.add(0, entry)
            // 超出上限时截断
            if (entries.size > maxEntries) {
                entries.subList(maxEntries, entries.size).clear()
            }
        }

        saveToDisk()
    }

    /** 获取历史列表（支持按 connectionId 和关键词筛选） */
    fun list(connectionId: String? = null, keyword: String? = null, limit: Int = 100): List<SqlHistoryEntry> {
        return synchronized(entries) {
            entries
                .filter { connectionId == null || it.connectionId == connectionId }
                .filter { keyword == null || it.sql.contains(keyword, ignoreCase = true) }
                .take(limit)
        }
    }

    /** 清空历史 */
    fun clear() {
        synchronized(entries) { entries.clear() }
        saveToDisk()
    }

    // ─── 磁盘 I/O ───────────────────────────────────────────

    private fun loadFromDisk() {
        if (!storageFile.exists()) return
        try {
            val text = storageFile.readText()
            if (text.isBlank()) return
            val list = json.decodeFromString<List<SqlHistoryEntry>>(text)
            synchronized(entries) {
                entries.clear()
                entries.addAll(list)
            }
        } catch (e: Exception) {
            System.err.println("[SqlHistoryStore] Failed to load: ${e.message}")
        }
    }

    @Synchronized
    private fun saveToDisk() {
        try {
            storageDir.mkdirs()
            val snapshot = synchronized(entries) { entries.toList() }
            storageFile.writeText(json.encodeToString(snapshot))
        } catch (e: Exception) {
            System.err.println("[SqlHistoryStore] Failed to save: ${e.message}")
        }
    }
}

@Serializable
data class SqlHistoryEntry(
    val id: String,
    val connectionId: String,
    val database: String,
    val sql: String,
    val type: String,         // query | update | error
    val duration: Long,
    val rowCount: Long? = null,
    val error: String? = null,
    val executedAt: String
)
