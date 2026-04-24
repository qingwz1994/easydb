package com.easydb.launcher

import com.easydb.api.fail
import com.easydb.api.ok
import com.easydb.common.ProcedureExecuteRequest
import com.easydb.common.ProcedureExecuteResult
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.routing.*

/**
 * 存储过程 / 函数执行路由。
 *
 * - POST /api/procedure/inspect  → 查询参数元数据（名称、类型、方向）
 * - POST /api/procedure/execute  → 执行过程/函数，返回 OUT 参数 + 多结果集
 *
 * 路由通过 ServiceRegistry.mysqlAdapter.procedureAdapter() 获取适配器，
 * 不持有任何 MySQL 特定类的引用，支持 Phase 2 扩展 PG / 达梦。
 */
fun Route.procedureRoutes() {
    val connMgr        = ServiceRegistry.connectionManager
    val executeService = com.easydb.common.ProcedureExecuteService()

    /** 获取当前连接类型对应的适配器（Phase 2：根据 dbType 切换） */
    fun procedureAdapter() = ServiceRegistry.mysqlAdapter.procedureAdapter()

    // ─── POST /api/procedure/inspect ──────────────────────────────

    /**
     * 查询存储过程或函数的参数元数据。
     * 请求体：{ connectionId, database, name, type }
     * 响应：ProcedureInspectResult（参数列表 + ddl + definer + comment）
     */
    post("/inspect") {
        val body = call.receive<kotlinx.serialization.json.JsonObject>()

        fun kotlinx.serialization.json.JsonObject.str(key: String) =
            (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""

        val connectionId = body.str("connectionId")
        val database     = body.str("database")
        val name         = body.str("name")
        val type         = body.str("type").ifBlank { "PROCEDURE" }.uppercase()

        if (connectionId.isBlank() || database.isBlank() || name.isBlank()) {
            call.fail("INVALID_REQUEST", "缺少必要参数：connectionId / database / name")
            return@post
        }

        val session = connMgr.getPrimarySession(connectionId)
            ?: return@post call.fail("NOT_CONNECTED", "连接未激活，请先打开连接")

        try {
            val result = procedureAdapter().inspect(session, database, name, type)
            call.ok(result)
        } catch (e: Exception) {
            call.fail("INSPECT_FAILED", e.message ?: "获取参数元数据失败")
        }
    }

    // ─── POST /api/procedure/execute ──────────────────────────────

    /**
     * 执行存储过程或函数。
     * 请求体：ProcedureExecuteRequest
     * 响应：ProcedureExecuteResult（outParams + resultSets + duration）
     */
    post("/execute") {
        val request = call.receive<ProcedureExecuteRequest>()

        val session = connMgr.getPrimarySession(request.connectionId)
            ?: return@post call.ok(
                ProcedureExecuteResult(success = false, duration = 0, error = "连接未激活，请先打开连接")
            )

        // 执行引擎：纯 JDBC 标准逻辑，适配器负责数据库特定 SQL
        val result = executeService.execute(procedureAdapter(), session, request)
        call.ok(result)
    }
}
