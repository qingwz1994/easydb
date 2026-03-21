package com.easydb.common

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * 任务管理器
 * 跟踪迁移/同步任务的生命周期、进度和日志
 * 使用本地 JSON 文件持久化任务记录，重启后可恢复历史
 *
 * 存储路径：~/.easydb/tasks.json
 */
class TaskManager(
    private val storageDir: File = File(System.getProperty("user.home"), ".easydb")
) {

    private val tasks = ConcurrentHashMap<String, TaskInfo>()
    private val taskLogs = ConcurrentHashMap<String, MutableList<TaskLogEntry>>()
    private val timeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

    private val storageFile = File(storageDir, "tasks.json")
    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    init {
        loadFromDisk()
    }

    /** 创建新任务 */
    fun createTask(name: String, type: String): TaskInfo {
        val task = TaskInfo(
            id = UUID.randomUUID().toString(),
            name = name,
            type = type,
            status = "pending",
            progress = 0,
            startedAt = LocalDateTime.now().format(timeFormatter)
        )
        tasks[task.id] = task
        taskLogs[task.id] = mutableListOf()
        saveToDisk()
        return task
    }

    /** 获取任务列表 */
    fun list(statusFilter: String? = null): List<TaskInfo> {
        val all = tasks.values.toList().sortedByDescending { it.startedAt }
        return if (statusFilter.isNullOrBlank()) all
        else all.filter { it.status == statusFilter }
    }

    /** 获取单个任务 */
    fun get(taskId: String): TaskInfo? = tasks[taskId]

    /** 获取任务日志 */
    fun getLogs(taskId: String): List<TaskLogEntry> =
        taskLogs[taskId]?.toList() ?: emptyList()

    /** 取消任务 */
    fun cancel(taskId: String) {
        tasks[taskId]?.let {
            tasks[taskId] = it.copy(status = "cancelled")
            saveToDisk()
        }
    }

    /** 删除任务（仅允许删除已完成/失败/已取消的任务） */
    fun delete(taskId: String): Boolean {
        val task = tasks[taskId] ?: return false
        if (task.status == "running" || task.status == "pending") return false
        tasks.remove(taskId)
        taskLogs.remove(taskId)
        saveToDisk()
        return true
    }

    /** 清空所有已完成的任务 */
    fun clearCompleted(): Int {
        val toRemove = tasks.values.filter { it.status in listOf("completed", "failed", "cancelled") }
        toRemove.forEach {
            tasks.remove(it.id)
            taskLogs.remove(it.id)
        }
        if (toRemove.isNotEmpty()) saveToDisk()
        return toRemove.size
    }

    /** 创建 TaskReporter */
    fun createReporter(taskId: String): TaskReporter = InternalTaskReporter(taskId)

    // ─── 内部 Reporter ──────────────────────────────────────

    private inner class InternalTaskReporter(private val taskId: String) : TaskReporter {
        override fun onProgress(progress: Int, message: String?) {
            tasks[taskId]?.let {
                tasks[taskId] = it.copy(
                    progress = progress,
                    status = if (progress >= 100) "completed" else "running"
                )
            }
        }

        override fun onStep(stepName: String, status: TaskStatus, message: String?) {
            addLog(taskId, "INFO", "[$stepName] ${status.name}${message?.let { ": $it" } ?: ""}")
        }

        override fun onLog(level: String, message: String) {
            addLog(taskId, level, message)
        }

        override fun isCancelled(): Boolean {
            return tasks[taskId]?.status == "cancelled"
        }
    }

    private fun addLog(taskId: String, level: String, message: String) {
        taskLogs.getOrPut(taskId) { mutableListOf() }.add(
            TaskLogEntry(
                timestamp = LocalDateTime.now().format(timeFormatter),
                level = level,
                message = message
            )
        )
    }

    /** 标记任务为失败 */
    fun markFailed(taskId: String, error: String, result: TaskResult? = null) {
        tasks[taskId]?.let {
            tasks[taskId] = it.copy(
                status = "failed",
                errorMessage = error,
                successCount = result?.successCount,
                failureCount = result?.failureCount,
                verification = result?.verification
            )
            saveToDisk()
        }
    }

    /** 标记任务为完成（如果任务已被取消则不覆盖） */
    fun markCompleted(taskId: String, duration: Long, result: TaskResult? = null) {
        tasks[taskId]?.let {
            if (it.status == "cancelled") return
            tasks[taskId] = it.copy(
                status = "completed",
                progress = 100,
                duration = duration,
                successCount = result?.successCount,
                failureCount = result?.failureCount,
                verification = result?.verification
            )
            saveToDisk()
        }
    }

    /** 标记任务为已取消（保留已用时长） */
    fun markCancelled(taskId: String, duration: Long) {
        tasks[taskId]?.let {
            tasks[taskId] = it.copy(status = "cancelled", duration = duration)
            saveToDisk()
        }
    }

    // ─── 磁盘 I/O ───────────────────────────────────────────

    private fun loadFromDisk() {
        if (!storageFile.exists()) return
        try {
            val text = storageFile.readText()
            if (text.isBlank()) return
            val list = json.decodeFromString<List<TaskInfo>>(text)
            list.forEach { task ->
                // 恢复时将 running/pending 任务标记为 failed（上次异常退出）
                val restored = if (task.status == "running" || task.status == "pending") {
                    task.copy(status = "failed", errorMessage = "应用异常退出，任务中断")
                } else {
                    task
                }
                tasks[restored.id] = restored
            }
        } catch (e: Exception) {
            System.err.println("[TaskManager] Failed to load tasks: ${e.message}")
        }
    }

    @Synchronized
    private fun saveToDisk() {
        try {
            storageDir.mkdirs()
            storageFile.writeText(json.encodeToString(tasks.values.toList()))
        } catch (e: Exception) {
            System.err.println("[TaskManager] Failed to save tasks: ${e.message}")
        }
    }
}

// ─── 序列化模型 ──────────────────────────────────────────────

@Serializable
data class TaskInfo(
    val id: String,
    val name: String,
    val type: String,                // migration | sync
    val status: String = "pending",  // pending | running | completed | failed | cancelled
    val progress: Int = 0,
    val startedAt: String? = null,
    val duration: Long? = null,
    val errorMessage: String? = null,
    val successCount: Int? = null,
    val failureCount: Int? = null,
    val verification: List<TableVerifyResult>? = null
)

@Serializable
data class TaskLogEntry(
    val timestamp: String,
    val level: String,    // INFO | WARN | ERROR
    val message: String
)
