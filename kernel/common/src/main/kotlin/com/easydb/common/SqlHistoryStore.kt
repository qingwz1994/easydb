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
            sql = if (sql.length > 2000) sql.take(2000) + " …[truncated]" else sql,
            type = result.type,
            duration = result.duration,
            rowCount = result.rows?.size?.toLong() ?: result.affectedRows?.toLong(),
            error = result.error,
            executedAt = result.executedAt
        )

        synchronized(entries) {
            entries.add(0, entry)
            if (entries.size > maxEntries) {
                entries.subList(maxEntries, entries.size).clear()
            }
        }

        scheduleSave()
    }

    /** 获取历史列表（支持按 connectionId、database 和关键词筛选） */
    fun list(connectionId: String? = null, database: String? = null, keyword: String? = null, limit: Int = 100): List<SqlHistoryEntry> {
        return synchronized(entries) {
            entries
                .filter { connectionId == null || it.connectionId == connectionId }
                .filter { database == null     || it.database    == database      }
                .filter { keyword == null      || it.sql.contains(keyword, ignoreCase = true) }
                .take(limit)
        }
    }

    /** 清空全部历史 */
    fun clear() {
        synchronized(entries) { entries.clear() }
        saveToDiskNow()
    }

    /** 按连接 ID 清空历史（不影响其他连接） */
    fun clearByConnection(connectionId: String) {
        synchronized(entries) {
            entries.removeAll { it.connectionId == connectionId }
        }
        scheduleSave()
    }

    // ─── 异步防抖保存 ───────────────────────────────────────

    private val saveExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
    @Volatile private var pendingSave = false

    /** 防抖：短时间多次 add 只触发一次磁盘写入 */
    private fun scheduleSave() {
        if (pendingSave) return
        pendingSave = true
        saveExecutor.submit {
            try {
                Thread.sleep(2000) // 2 秒防抖
                saveToDiskNow()
            } finally {
                pendingSave = false
            }
        }
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
                entries.addAll(list.take(maxEntries))
            }
        } catch (e: Exception) {
            System.err.println("[SqlHistoryStore] Failed to load: ${e.message}")
        }
    }

    private fun saveToDiskNow() {
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
