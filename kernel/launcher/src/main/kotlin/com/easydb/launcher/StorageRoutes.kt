package com.easydb.launcher

import com.easydb.api.fail
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable
data class CleanupRequest(
    val target: String,     // "exports" | "logs" | "tasks"
    val mode: String,       // "older_than_days" | "all"
    val days: Int = 3
)

fun Route.storageRoutes() {

    /** GET /api/storage/info - 获取存储占用信息 */
    get("/info") {
        val taskMgr = ServiceRegistry.taskManager
        val info = taskMgr.getStorageInfo()
        val response = buildJsonObject {
            put("success", true)
            putJsonObject("data") {
                put("basePath", info.basePath)
                putJsonObject("exports") {
                    put("size", info.exports.size)
                    put("sizeText", info.exports.sizeText)
                    put("fileCount", info.exports.fileCount)
                }
                putJsonObject("logs") {
                    put("size", info.logs.size)
                    put("sizeText", info.logs.sizeText)
                    put("fileCount", info.logs.fileCount)
                }
                putJsonObject("config") {
                    put("size", info.config.size)
                    put("sizeText", info.config.sizeText)
                    put("fileCount", info.config.fileCount)
                }
                putJsonObject("backups") {
                    put("size", info.backups.size)
                    put("sizeText", info.backups.sizeText)
                    put("fileCount", info.backups.fileCount)
                }
                put("totalSize", info.totalSize)
                put("totalSizeText", info.totalSizeText)
            }
        }
        call.respondText(response.toString(), ContentType.Application.Json)
    }

    /** POST /api/storage/cleanup - 执行存储清理 */
    post("/cleanup") {
        val req = call.receive<CleanupRequest>()

        if (req.target !in listOf("exports", "logs", "tasks", "backups")) {
            call.fail("INVALID_TARGET", "target 必须是 exports, logs, tasks 或 backups")
            return@post
        }
        if (req.mode !in listOf("older_than_days", "all")) {
            call.fail("INVALID_MODE", "mode 必须是 older_than_days 或 all")
            return@post
        }

        val taskMgr = ServiceRegistry.taskManager
        val result = taskMgr.cleanupStorage(req.target, req.mode, req.days)
        val response = buildJsonObject {
            put("success", true)
            putJsonObject("data") {
                put("deletedCount", result.deletedCount)
                put("freedSize", result.freedSize)
                put("freedSizeText", result.freedSizeText)
            }
        }
        call.respondText(response.toString(), ContentType.Application.Json)
    }
}
