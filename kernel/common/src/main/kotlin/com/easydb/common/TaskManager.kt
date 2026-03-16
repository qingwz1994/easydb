package com.easydb.common

import kotlinx.serialization.Serializable
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * 任务管理器
 * 跟踪迁移/同步任务的生命周期、进度和日志
 */
class TaskManager {

    private val tasks = ConcurrentHashMap<String, TaskInfo>()
    private val taskLogs = ConcurrentHashMap<String, MutableList<TaskLogEntry>>()
    private val timeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

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
        }
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
    fun markFailed(taskId: String, error: String) {
        tasks[taskId]?.let {
            tasks[taskId] = it.copy(status = "failed", errorMessage = error)
        }
    }

    /** 标记任务为完成 */
    fun markCompleted(taskId: String, duration: Long) {
        tasks[taskId]?.let {
            tasks[taskId] = it.copy(status = "completed", progress = 100, duration = duration)
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
    val errorMessage: String? = null
)

@Serializable
data class TaskLogEntry(
    val timestamp: String,
    val level: String,    // INFO | WARN | ERROR
    val message: String
)
