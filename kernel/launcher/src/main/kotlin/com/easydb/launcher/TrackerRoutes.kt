/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
package com.easydb.launcher

import com.easydb.api.ok
import com.easydb.api.fail
import com.easydb.common.*
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private val json = Json { prettyPrint = false; encodeDefaults = true }

/**
 * 数据追踪路由
 */
fun Route.trackerRoutes() {
    val tracker = ServiceRegistry.changeTracker
    val connMgr = ServiceRegistry.connectionManager
    val store = ServiceRegistry.connectionStore
    val adapter = ServiceRegistry.mysqlAdapter

    // 检查服务端兼容性
    get("/server-check") {
        val connectionId = call.request.queryParameters["connectionId"]
            ?: return@get call.fail("PARAM_ERROR", "connectionId is required")

        val config = store.getById(connectionId)
            ?: return@get call.fail("NOT_FOUND", "Connection not found")

        val session = connMgr.getSession(connectionId)
            ?: connMgr.openSession(adapter.connectionAdapter(), config)

        val result = tracker.checkServerCompatibility(session)
        call.ok(result)
    }

    // 列出可用的 binlog 文件
    get("/binlog-files") {
        val connectionId = call.request.queryParameters["connectionId"]
            ?: return@get call.fail("PARAM_ERROR", "connectionId is required")

        val config = store.getById(connectionId)
            ?: return@get call.fail("NOT_FOUND", "Connection not found")

        val session = connMgr.getSession(connectionId)
            ?: connMgr.openSession(adapter.connectionAdapter(), config)

        val files = tracker.listBinlogFiles(session)
        call.ok(files)
    }

    // 启动追踪
    post("/start") {
        val config = call.receive<TrackerSessionConfig>()

        val connConfig = store.getById(config.connectionId)
            ?: return@post call.fail("NOT_FOUND", "Connection not found")

        // 为 binlog 创建独立连接（不能复用查询连接）
        val session = connMgr.openSession(adapter.connectionAdapter(), connConfig)

        val sessionId = tracker.start(session, config)
        call.ok(mapOf("sessionId" to sessionId))
    }

    // 停止追踪
    post("/stop") {
        val body = call.receive<Map<String, String>>()
        val sessionId = body["sessionId"]
            ?: return@post call.fail("PARAM_ERROR", "sessionId is required")

        tracker.stop(sessionId)
        call.ok(mapOf("success" to true))
    }

    // 获取追踪状态
    get("/status") {
        val sessionId = call.request.queryParameters["sessionId"]

        if (sessionId != null) {
            val status = tracker.status(sessionId)
                ?: return@get call.fail("NOT_FOUND", "Session not found")
            call.ok(status)
        } else {
            // 返回所有活跃会话
            call.ok(tracker.getActiveSessions())
        }
    }

    // 获取历史事件（服务端分页 + 筛选）
    get("/history") {
        val sessionId = call.request.queryParameters["sessionId"]
            ?: return@get call.fail("PARAM_ERROR", "sessionId is required")
        val page = call.request.queryParameters["page"]?.toIntOrNull() ?: 0
        val pageSize = call.request.queryParameters["pageSize"]?.toIntOrNull() ?: 50
        val filterTable = call.request.queryParameters["table"]
        val filterType = call.request.queryParameters["type"]
        val keyword = call.request.queryParameters["keyword"]
        val startTime = call.request.queryParameters["startTime"]?.toLongOrNull()
        val endTime = call.request.queryParameters["endTime"]?.toLongOrNull()

        val result = tracker.getHistory(sessionId, page, pageSize, filterTable, filterType, keyword, startTime, endTime)
        call.ok(result)
    }

    // SSE 轻量通知（每秒推送计数更新，不推完整事件）
    get("/events") {
        val sessionId = call.request.queryParameters["sessionId"]
            ?: return@get call.fail("PARAM_ERROR", "sessionId is required")

        call.response.header(HttpHeaders.ContentType, "text/event-stream")
        call.response.header(HttpHeaders.CacheControl, "no-cache")
        call.response.header(HttpHeaders.Connection, "keep-alive")
        call.response.header("X-Accel-Buffering", "no")

        call.respondTextWriter(contentType = ContentType.Text.EventStream) {
            try {
                tracker.subscribe(sessionId).collect { tick ->
                    write("data: ${json.encodeToString(tick)}\n\n")
                    flush()
                    // 如果 completed 或 error，发送后停止收集
                    if (tick.type == "completed" || tick.type == "error") {
                        throw kotlinx.coroutines.CancellationException("SSE stream ended: ${tick.type}")
                    }
                }
            } catch (_: kotlinx.coroutines.CancellationException) {
                // 正常结束
            } catch (e: Exception) {
                write("event: error\ndata: ${e.message}\n\n")
                flush()
            }
        }
    }

    // 生成回滚 SQL
    post("/rollback-sql") {
        val request = call.receive<RollbackSqlRequest>()

        val connConfig = store.getById(request.connectionId)
            ?: return@post call.fail("NOT_FOUND", "Connection not found")

        val session = connMgr.getSession(request.connectionId)
            ?: connMgr.openSession(adapter.connectionAdapter(), connConfig)

        // 找到活跃的追踪会话
        val activeSessions = tracker.getActiveSessions()
        val trackerSessionId = activeSessions.find { it.connectionId == request.connectionId }?.sessionId
            ?: return@post call.fail("NOT_FOUND", "No active tracker session for this connection")

        val result = tracker.generateRollbackSql(trackerSessionId, request.eventIds, session, request.database)
        call.ok(result)
    }

    // 生成正向重放 SQL
    post("/forward-sql") {
        val request = call.receive<RollbackSqlRequest>()

        val connConfig = store.getById(request.connectionId)
            ?: return@post call.fail("NOT_FOUND", "Connection not found")

        val session = connMgr.getSession(request.connectionId)
            ?: connMgr.openSession(adapter.connectionAdapter(), connConfig)

        val activeSessions = tracker.getActiveSessions()
        val trackerSessionId = activeSessions.find { it.connectionId == request.connectionId }?.sessionId
            ?: return@post call.fail("NOT_FOUND", "No active tracker session for this connection")

        val result = tracker.generateForwardSql(trackerSessionId, request.eventIds, session, request.database)
        call.ok(result)
    }
}
