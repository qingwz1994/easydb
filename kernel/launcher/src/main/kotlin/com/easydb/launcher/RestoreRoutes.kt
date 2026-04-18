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
import java.io.File

private val restoreTaskScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

fun Route.restoreRoutes() {
    val restoreService = RestoreService()

    post("/inspect") {
        val data = call.receive<Map<String, String>>()
        val path = data["filePath"]
            ?: return@post call.fail("MISSING_PARAM", "缺少 filePath 参数")
        
        val validator = RestoreValidator(File(path))
        val result = validator.inspect()
        
        call.ok(result)
    }

    post("/start") {
        val config = call.receive<RestoreConfig>()
        val connConfig = ServiceRegistry.connectionStore.getById(config.targetConnectionId)
            ?: return@post call.fail("NOT_FOUND", "目标连接配置不存在")

        // 验证目标连接是否已激活
        val session = ServiceRegistry.connectionManager.getPrimarySession(config.targetConnectionId)
            ?: return@post call.fail("NOT_CONNECTED", "目标连接未激活，请先打开连接")

        val taskName = "Restore ${config.targetDatabase}"
        val taskInfo = ServiceRegistry.taskManager.createTask(taskName, "restore")

        restoreTaskScope.launch {
            val reporter = ServiceRegistry.taskManager.createReporter(taskInfo.id)
            val startTime = System.currentTimeMillis()
            reporter.onStep("Init", TaskStatus.RUNNING, "Starting logical restore...")

            try {
                val res = restoreService.execute(config, connConfig, reporter)
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
}
