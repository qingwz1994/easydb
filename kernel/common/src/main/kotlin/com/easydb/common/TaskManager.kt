package com.easydb.common

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.Timer
import java.util.TimerTask

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
    companion object {
        private const val EXPORT_RETENTION_MILLIS = 3L * 24 * 60 * 60 * 1000
    }

    private val tasks = ConcurrentHashMap<String, TaskInfo>()
    private val cancelFlags = ConcurrentHashMap<String, AtomicBoolean>()
    private val taskLogs = ConcurrentHashMap<String, MutableList<TaskLogEntry>>()
    private val logWriters = ConcurrentHashMap<String, java.io.PrintWriter>()
    private val timeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")

    private val storageFile = File(storageDir, "tasks.json")
    private val exportDir = File(storageDir, "exports")
    private val json = Json {
        prettyPrint = true
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    // 防抖存盘机制 (C3): 必须在 init 之前声明，避免初始化顺序 NPE
    private val dirty = AtomicBoolean(false)
    private val debounceTimer = Timer("TaskManager-SaveDebounce", true)
    private var pendingTask: TimerTask? = null

    init {
        loadFromDisk()
        cleanupExpiredExportFiles()
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
        cancelFlags[task.id] = AtomicBoolean(false)
        taskLogs[task.id] = java.util.Collections.synchronizedList(mutableListOf())
        saveImmediately()
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
        taskLogs[taskId]?.let { list ->
            synchronized(list) { list.toList() }
        } ?: emptyList()

    /** 取消任务 */
    fun cancel(taskId: String) {
        // 先设置原子标志——导出协程通过这个标志检测取消，无并发延迟
        cancelFlags[taskId]?.set(true)
        tasks[taskId]?.let {
            tasks[taskId] = it.copy(status = "cancelled")
            closeLogWriter(taskId)
            saveImmediately()
        }
    }

    /** 删除任务（仅允许删除已完成/失败/已取消的任务） */
    fun delete(taskId: String): Boolean {
        val task = tasks[taskId] ?: return false
        if (task.status == "running" || task.status == "pending") return false
        deleteManagedExportFile(task)
        tasks.remove(taskId)
        taskLogs.remove(taskId)
        closeLogWriter(taskId)
        File(storageDir, "logs/$taskId.log").delete()
        saveImmediately()
        return true
    }

    /** 清空所有已完成的任务 */
    fun clearCompleted(): Int {
        val toRemove = tasks.values.filter { it.status in listOf("completed", "failed", "cancelled") }
        toRemove.forEach {
            deleteManagedExportFile(it)
            tasks.remove(it.id)
            taskLogs.remove(it.id)
            closeLogWriter(it.id)
            File(storageDir, "logs/${it.id}.log").delete()
        }
        if (toRemove.isNotEmpty()) saveImmediately()
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
                    progressMessage = message,
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
            // 优先检查原子标志（零延迟），再回退到 tasks map
            return cancelFlags[taskId]?.get() == true || tasks[taskId]?.status == "cancelled"
        }
    }

    private fun getLogWriter(taskId: String): java.io.PrintWriter {
        return logWriters.getOrPut(taskId) {
            val logDir = File(storageDir, "logs")
            logDir.mkdirs()
            java.io.PrintWriter(java.io.FileWriter(File(logDir, "$taskId.log"), true))
        }
    }

    private fun closeLogWriter(taskId: String) {
        logWriters.remove(taskId)?.close()
    }

    private fun isManagedExportFile(file: File): Boolean {
        val exportsPath = exportDir.canonicalFile.toPath()
        val filePath = file.canonicalFile.toPath()
        return filePath.startsWith(exportsPath)
    }

    private fun deleteManagedExportFile(task: TaskInfo) {
        val filePath = task.payload?.get("filePath") ?: return
        val file = File(filePath)
        try {
            if (file.exists() && isManagedExportFile(file)) {
                file.delete()
            }
        } catch (_: Exception) {
            // 忽略清理异常，避免影响任务主流程
        }
    }

    private fun cleanupExpiredExportFiles() {
        val expireBefore = System.currentTimeMillis() - EXPORT_RETENTION_MILLIS
        var tasksChanged = false

        tasks.forEach { (taskId, task) ->
            val filePath = task.payload?.get("filePath") ?: return@forEach
            val file = File(filePath)

            val shouldClearPayload = try {
                when {
                    !isManagedExportFile(file) -> false
                    !file.exists() -> true
                    file.lastModified() < expireBefore -> {
                        file.delete()
                        true
                    }
                    else -> false
                }
            } catch (_: Exception) {
                false
            }

            if (shouldClearPayload) {
                tasks[taskId] = task.copy(payload = null)
                tasksChanged = true
            }
        }

        if (exportDir.exists()) {
            exportDir.listFiles()?.forEach { file ->
                try {
                    if (file.isFile && file.lastModified() < expireBefore) {
                        file.delete()
                    }
                } catch (_: Exception) {
                    // 忽略单文件清理异常
                }
            }
        }

        if (tasksChanged) {
            saveImmediately()
        }
    }

    // ─── 存储管理 API ──────────────────────────────────────

    data class StorageCategoryInfo(
        val size: Long,
        val sizeText: String,
        val fileCount: Int
    )

    data class StorageInfo(
        val basePath: String,
        val exports: StorageCategoryInfo,
        val logs: StorageCategoryInfo,
        val config: StorageCategoryInfo,
        val backups: StorageCategoryInfo,
        val totalSize: Long,
        val totalSizeText: String
    )

    data class CleanupResult(
        val deletedCount: Int,
        val freedSize: Long,
        val freedSizeText: String
    )

    /** 获取存储占用信息 */
    fun getStorageInfo(): StorageInfo {
        val exportsInfo = calcDirInfo(exportDir)
        val logsDir = File(storageDir, "logs")
        val logsInfo = calcDirInfo(logsDir)
        val backupsDir = File(storageDir, "backups")
        val backupsInfo = calcDirInfo(backupsDir, filter = { it.extension == "edbkp" })
        val configSize = storageFile.let { if (it.exists()) it.length() else 0L }
        val configInfo = StorageCategoryInfo(configSize, formatSize(configSize), if (storageFile.exists()) 1 else 0)
        val totalSize = exportsInfo.size + logsInfo.size + configInfo.size + backupsInfo.size
        return StorageInfo(
            basePath = storageDir.absolutePath,
            exports = exportsInfo,
            logs = logsInfo,
            config = configInfo,
            backups = backupsInfo,
            totalSize = totalSize,
            totalSizeText = formatSize(totalSize)
        )
    }

    /** 清理存储
     * @param target "exports" | "logs" | "tasks"
     * @param mode "older_than_days" | "all"
     * @param days 仅 mode=older_than_days 时有效
     */
    fun cleanupStorage(target: String, mode: String, days: Int = 3): CleanupResult {
        var deletedCount = 0
        var freedSize = 0L

        when (target) {
            "exports" -> {
                val expireBefore = if (mode == "all") Long.MAX_VALUE
                    else System.currentTimeMillis() - days.toLong() * 24 * 60 * 60 * 1000

                // 清理 tasks 中关联的导出文件
                val tasksToUpdate = mutableListOf<Pair<String, TaskInfo>>()
                tasks.forEach { (taskId, task) ->
                    val filePath = task.payload?.get("filePath") ?: return@forEach
                    val file = File(filePath)
                    try {
                        if (isManagedExportFile(file) && file.exists()) {
                            if (mode == "all" || file.lastModified() < expireBefore) {
                                freedSize += file.length()
                                file.delete()
                                deletedCount++
                                tasksToUpdate.add(taskId to task)
                            }
                        }
                    } catch (_: Exception) {}
                }
                tasksToUpdate.forEach { (taskId, task) ->
                    tasks[taskId] = task.copy(payload = null)
                }

                // 清理孤立的导出文件（无关联任务的）
                if (exportDir.exists()) {
                    exportDir.listFiles()?.forEach { file ->
                        try {
                            if (file.isFile && (mode == "all" || file.lastModified() < expireBefore)) {
                                freedSize += file.length()
                                file.delete()
                                deletedCount++
                            }
                        } catch (_: Exception) {}
                    }
                }

                if (tasksToUpdate.isNotEmpty()) saveImmediately()
            }

            "logs" -> {
                val logsDir = File(storageDir, "logs")
                if (logsDir.exists()) {
                    val expireBefore = if (mode == "all") Long.MAX_VALUE
                        else System.currentTimeMillis() - days.toLong() * 24 * 60 * 60 * 1000
                    // 保护正在运行的任务日志
                    val runningTaskIds = tasks.values
                        .filter { it.status == "running" || it.status == "pending" }
                        .map { it.id }
                        .toSet()

                    logsDir.listFiles()?.forEach { file ->
                        try {
                            val taskId = file.nameWithoutExtension
                            if (file.isFile && taskId !in runningTaskIds &&
                                (mode == "all" || file.lastModified() < expireBefore)) {
                                freedSize += file.length()
                                file.delete()
                                deletedCount++
                            }
                        } catch (_: Exception) {}
                    }
                }
            }

            "tasks" -> {
                deletedCount = clearCompleted()
            }

            "backups" -> {
                val backupsDir = File(storageDir, "backups")
                if (backupsDir.exists()) {
                    val expireBefore = if (mode == "all") Long.MAX_VALUE
                        else System.currentTimeMillis() - days.toLong() * 24 * 60 * 60 * 1000
                    backupsDir.listFiles()?.forEach { file ->
                        try {
                            if (file.isFile && file.extension == "edbkp" &&
                                (mode == "all" || file.lastModified() < expireBefore)) {
                                freedSize += file.length()
                                file.delete()
                                deletedCount++
                            }
                        } catch (_: Exception) {}
                    }
                }
            }
        }

        return CleanupResult(deletedCount, freedSize, formatSize(freedSize))
    }

    private fun calcDirInfo(dir: File, filter: ((File) -> Boolean)? = null): StorageCategoryInfo {
        if (!dir.exists()) return StorageCategoryInfo(0L, "0 B", 0)
        var totalSize = 0L
        var count = 0
        dir.listFiles()?.forEach { file ->
            if (file.isFile && (filter == null || filter(file))) {
                totalSize += file.length()
                count++
            }
        }
        return StorageCategoryInfo(totalSize, formatSize(totalSize), count)
    }

    private fun formatSize(bytes: Long): String {
        return when {
            bytes >= 1_073_741_824 -> String.format("%.1f GB", bytes / 1_073_741_824.0)
            bytes >= 1_048_576 -> String.format("%.1f MB", bytes / 1_048_576.0)
            bytes >= 1_024 -> String.format("%.1f KB", bytes / 1_024.0)
            else -> "$bytes B"
        }
    }

    private fun addLog(taskId: String, level: String, message: String) {
        val timestamp = LocalDateTime.now().format(timeFormatter)
        
        // 1. In-memory buffer (capped at 1000 lines for frontend UI)
        val list = taskLogs.getOrPut(taskId) { java.util.Collections.synchronizedList(mutableListOf()) }
        synchronized(list) {
            list.add(TaskLogEntry(timestamp, level, message))
            // OOM Guard: Cap at 1000 lines to prevent blowing up the frontend React virtual DOM and the HTTP response
            if (list.size > 1200) {
                val trimmed = list.subList(list.size - 1000, list.size).toList()
                list.clear()
                list.addAll(trimmed)
            }
        }
        
        // 2. Physical disk persistence (unbounded, for log export)
        try {
            val writer = getLogWriter(taskId)
            writer.println("[$timestamp] [$level] $message")
            writer.flush()
        } catch (e: Exception) {
            System.err.println("[TaskManager] Failed to write physical log: ${e.message}")
        }
    }

    fun markFailed(taskId: String, error: String, result: TaskResult? = null) {
        tasks[taskId]?.let {
            tasks[taskId] = it.copy(
                status = "failed",
                errorMessage = error,
                successCount = result?.successCount,
                failureCount = result?.failureCount,
                skippedCount = result?.skippedCount,
                verification = result?.verification,
                payload = result?.payload
            )
            closeLogWriter(taskId)
            saveImmediately()
        }
    }

    fun markCompleted(taskId: String, duration: Long, result: TaskResult? = null) {
        tasks[taskId]?.let {
            if (it.status == "cancelled") return
            tasks[taskId] = it.copy(
                status = "completed",
                progress = 100,
                duration = duration,
                successCount = result?.successCount,
                failureCount = result?.failureCount,
                skippedCount = result?.skippedCount,
                verification = result?.verification,
                payload = result?.payload
            )
            closeLogWriter(taskId)
            saveImmediately()
        }
    }

    /** 标记任务为已取消（保留已用时长） */
    fun markCancelled(taskId: String, duration: Long, result: TaskResult? = null) {
        tasks[taskId]?.let {
            tasks[taskId] = it.copy(
                status = "cancelled",
                duration = duration,
                successCount = result?.successCount,
                failureCount = result?.failureCount,
                skippedCount = result?.skippedCount,
                payload = result?.payload
            )
            closeLogWriter(taskId)
            saveImmediately()
        }
    }

    // ─── 磁盘 I/O ───────────────────────────────────────────

    /**
     * C3: saveToDisk 防抖机制
     * 高频状态更新（如 onProgress 每秒多次调用）不再每次都同步写磁盘。
     * 改为设置 dirty 标记后延迟 2 秒批量写入一次。
     * 关键的终态操作（createTask / markCompleted / markFailed / markCancelled / delete）
     * 仍然调用 saveImmediately() 确保数据不丢失。
     */
    // (dirty, debounceTimer, pendingTask 已移至 init 前声明)

    /** 延迟批量写入（用于高频更新如 onProgress） */
    private fun scheduleSave() {
        dirty.set(true)
        synchronized(this) {
            pendingTask?.cancel()
            pendingTask = object : TimerTask() {
                override fun run() {
                    if (dirty.compareAndSet(true, false)) {
                        doSaveToDisk()
                    }
                }
            }
            debounceTimer.schedule(pendingTask, 2000)
        }
    }

    /** 立即写入（用于终态操作，确保不丢数据） */
    private fun saveImmediately() {
        synchronized(this) {
            pendingTask?.cancel()
        }
        dirty.set(false)
        doSaveToDisk()
    }

    /** 兼容原有 saveToDisk 调用 */
    private fun saveToDisk() {
        scheduleSave()
    }

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
    private fun doSaveToDisk() {
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
    val progressMessage: String? = null,
    val startedAt: String? = null,
    val duration: Long? = null,
    val errorMessage: String? = null,
    val successCount: Int? = null,
    val failureCount: Int? = null,
    val skippedCount: Int? = null,
    val verification: List<TableVerifyResult>? = null,
    val payload: Map<String, String>? = null
)

@Serializable
data class TaskLogEntry(
    val timestamp: String,
    val level: String,    // INFO | WARN | ERROR
    val message: String
)
