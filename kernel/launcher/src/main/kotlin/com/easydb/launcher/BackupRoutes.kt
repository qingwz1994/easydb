package com.easydb.launcher

import com.easydb.api.ok
import com.easydb.api.fail
import com.easydb.backup.*
import com.easydb.common.TaskStatus
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File

private val backupTaskScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

fun Route.backupRoutes() {
    val backupService = LogicalBackupService()

    post("/estimate") {
        val config = call.receive<BackupConfig>()
        val session = ServiceRegistry.connectionManager.getPrimarySession(config.connectionId)
            ?: return@post call.fail("NOT_CONNECTED", "连接未激活，请先打开连接")
            
        val metadataAdapter = com.easydb.drivers.mysql.MysqlMetadataAdapter()
        
        // 在 IO 线程执行阻塞 JDBC 查询，并设置 15s 超时防止无限阻塞
        val tables = withContext(Dispatchers.IO) {
            withTimeoutOrNull(15_000L) {
                try {
                    metadataAdapter.listTables(session, config.database)
                } catch (e: Exception) {
                    emptyList()
                }
            } ?: emptyList()
        }
        
        val selected = tables.filter { config.tables.isEmpty() || config.tables.contains(it.name) }
        val estimatedRows = selected.sumOf { it.rowCount ?: 0L }
        val estimatedBytes = selected.sumOf { (it.dataLength ?: 0L) + (it.indexLength ?: 0L) }
        
        call.ok(BackupEstimateResult(
            database = config.database,
            selectedTables = selected.size,
            estimatedRows = estimatedRows,
            estimatedBytes = estimatedBytes,
            largeTableCount = selected.count { (it.rowCount ?: 0L) > 1_000_000L },
            warnings = if (tables.isEmpty()) listOf("元数据查询超时或无可用表") else emptyList()
        ))
    }

    post("/start") {
        val config = call.receive<BackupConfig>()
        val connConfig = ServiceRegistry.connectionStore.getById(config.connectionId)
            ?: return@post call.fail("NOT_FOUND", "连接配置不存在")
            
        val taskName = "Backup ${config.database}"
        val taskInfo = ServiceRegistry.taskManager.createTask(taskName, "backup")
        
        backupTaskScope.launch {
            val reporter = ServiceRegistry.taskManager.createReporter(taskInfo.id)
            val startTime = System.currentTimeMillis()
            reporter.onStep("Init", TaskStatus.RUNNING, "Starting logical backup...")
            
            try {
                val res = backupService.execute(config, connConfig, reporter)
                ServiceRegistry.taskManager.markCompleted(taskInfo.id, System.currentTimeMillis() - startTime, res)
            } catch (e: Exception) {
                if (reporter.isCancelled()) {
                    ServiceRegistry.taskManager.markCancelled(taskInfo.id, System.currentTimeMillis() - startTime)
                } else {
                    reporter.onLog("ERROR", e.stackTraceToString())
                    ServiceRegistry.taskManager.markFailed(taskInfo.id, e.message ?: "Unknown error")
                }
            }
        }
        
        call.ok(mapOf("taskId" to taskInfo.id))
    }

    get("/download") {
        val path = call.request.queryParameters["path"]
            ?: return@get call.fail("MISSING_PARAM", "缺少 path 参数")
        val file = File(path)
        if (!file.exists()) return@get call.fail("FILE_NOT_FOUND", "备份文件不存在: $path")
        call.response.header("Content-Disposition", "attachment; filename=\"${file.name}\"")
        call.respondFile(file)
    }

    get("/list") {
        val backupsDir = File(System.getProperty("user.home"), ".easydb/backups")
        val files = if (backupsDir.exists()) {
            backupsDir.listFiles { f -> f.isFile && f.name.endsWith(".edbkp") }
                ?.sortedByDescending { it.lastModified() }
                ?.map { f ->
                    mapOf(
                        "fileName" to f.name,
                        "filePath" to f.absolutePath,
                        "fileSizeBytes" to f.length().toString(),
                        "lastModified" to f.lastModified().toString()
                    )
                } ?: emptyList()
        } else emptyList()
        call.ok(files)
    }

    delete("/file") {
        val data = call.receive<Map<String, String>>()
        val path = data["filePath"]
            ?: return@delete call.fail("MISSING_PARAM", "缺少 filePath 参数")

        val file = File(path)
        val backupsDir = File(System.getProperty("user.home"), ".easydb/backups").canonicalPath

        // 安全校验：只允许删除备份目录下的 .edbkp 文件
        if (!file.canonicalPath.startsWith(backupsDir)) {
            return@delete call.fail("FORBIDDEN", "只能删除备份目录下的文件")
        }
        if (!file.name.endsWith(".edbkp")) {
            return@delete call.fail("FORBIDDEN", "只能删除 .edbkp 备份文件")
        }
        if (!file.exists()) {
            return@delete call.fail("NOT_FOUND", "文件不存在：${file.name}")
        }

        val deleted = file.delete()
        if (deleted) {
            call.ok(mapOf("deleted" to true, "fileName" to file.name))
        } else {
            call.fail("DELETE_FAILED", "删除失败，请检查文件权限")
        }
    }
}
