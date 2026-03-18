package com.easydb.launcher

import com.easydb.api.ok
import com.easydb.api.fail
import com.easydb.common.*
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch
import java.util.UUID

// ─── 连接管理路由 ──────────────────────────────────────────
fun Route.connectionRoutes() {
    val store = ServiceRegistry.connectionStore
    val adapter = ServiceRegistry.mysqlAdapter
    val connMgr = ServiceRegistry.connectionManager

    // 获取连接列表
    get("/list") {
        call.ok(store.getAll())
    }

    // 新建连接
    post("/create") {
        val config = call.receive<ConnectionConfig>()
        val newConfig = config.copy(id = UUID.randomUUID().toString())
        store.save(newConfig)
        call.ok(newConfig)
    }

    // 编辑连接
    put("/{id}") {
        val id = call.parameters["id"] ?: return@put call.fail("INVALID_ID", "缺少连接 ID")
        val config = call.receive<ConnectionConfig>()
        if (!store.contains(id)) {
            call.fail("NOT_FOUND", "连接不存在")
            return@put
        }
        val updated = store.save(config.copy(id = id))
        call.ok(updated)
    }

    // 删除连接
    delete("/{id}") {
        val id = call.parameters["id"] ?: return@delete call.fail("INVALID_ID", "缺少连接 ID")
        connMgr.closeSession(id)
        store.delete(id)
        call.ok(true)
    }

    // 测试连接
    post("/test") {
        val config = call.receive<ConnectionConfig>()
        val result = adapter.connectionAdapter().testConnection(config)
        call.ok(result)
    }

    // 打开连接（建立会话并设置上下文）
    post("/{id}/open") {
        val id = call.parameters["id"] ?: return@post call.fail("INVALID_ID", "缺少连接 ID")
        val config = store.getById(id)
            ?: return@post call.fail("NOT_FOUND", "连接不存在")

        try {
            connMgr.openSession(adapter.connectionAdapter(), config)
            store.updateStatus(id, "connected")
            call.ok(store.getById(id)!!)
        } catch (e: Exception) {
            call.fail("CONNECT_FAILED", e.message ?: "打开连接失败")
        }
    }

    // 关闭连接
    post("/{id}/close") {
        val id = call.parameters["id"] ?: return@post call.fail("INVALID_ID", "缺少连接 ID")
        connMgr.closeSession(id)
        store.updateStatus(id, "disconnected")
        call.ok(true)
    }
}

// ─── 元数据路由 ────────────────────────────────────────────
fun Route.metadataRoutes() {
    val adapter = ServiceRegistry.mysqlAdapter
    val connMgr = ServiceRegistry.connectionManager

    get("/{connectionId}/databases") {
        val session = getSessionOrFail(call, connMgr) ?: return@get
        call.ok(adapter.metadataAdapter().listDatabases(session))
    }

    get("/{connectionId}/{database}/objects") {
        val session = getSessionOrFail(call, connMgr) ?: return@get
        val database = call.parameters["database"]!!
        val metaAdapter = adapter.metadataAdapter()
        val tables = metaAdapter.listTables(session, database)
        val triggers = metaAdapter.listTriggers(session, database).map { trigger ->
            TableInfo(
                name = trigger.name,
                schema = database,
                type = "trigger",
                comment = trigger.comment ?: "${trigger.timing ?: ""} ${trigger.event ?: ""} ON ${trigger.table ?: ""}".trim()
            )
        }
        call.ok(tables + triggers)
    }

    get("/{connectionId}/{database}/tables/{table}/definition") {
        val session = getSessionOrFail(call, connMgr) ?: return@get
        val database = call.parameters["database"]!!
        val table = call.parameters["table"]!!
        call.ok(adapter.metadataAdapter().getTableDefinition(session, database, table))
    }

    get("/{connectionId}/{database}/tables/{table}/indexes") {
        val session = getSessionOrFail(call, connMgr) ?: return@get
        val database = call.parameters["database"]!!
        val table = call.parameters["table"]!!
        call.ok(adapter.metadataAdapter().getIndexes(session, database, table))
    }

    get("/{connectionId}/{database}/tables/{table}/preview") {
        val session = getSessionOrFail(call, connMgr) ?: return@get
        val database = call.parameters["database"]!!
        val table = call.parameters["table"]!!
        val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 1000
        call.ok(adapter.metadataAdapter().previewRows(session, database, table, limit))
    }

    get("/{connectionId}/{database}/tables/{table}/ddl") {
        val session = getSessionOrFail(call, connMgr) ?: return@get
        val database = call.parameters["database"]!!
        val table = call.parameters["table"]!!
        call.ok(adapter.metadataAdapter().getDdl(session, database, table))
    }

    // 数据编辑
    post("/{connectionId}/{database}/tables/{table}/edit") {
        val session = getSessionOrFail(call, connMgr) ?: return@post
        val database = call.parameters["database"]!!
        val table = call.parameters["table"]!!
        val req = call.receive<DataEditRequest>()
        val editService = DataEditService()
        val dialect = adapter.dialectAdapter()
        val sqlStatements = editService.generateSql(dialect, table, req.changes)

        if (req.dryRun) {
            call.ok(DataEditResult(success = true, sqlStatements = sqlStatements))
        } else {
            try {
                // 通过反射获取底层 JDBC 连接（同 SqlExecutionService）
                val connField = session.javaClass.getDeclaredField("connection")
                connField.isAccessible = true
                val jdbcConn = connField.get(session) as java.sql.Connection

                var totalAffected = 0
                jdbcConn.createStatement().use { stmt ->
                    stmt.execute("USE ${dialect.quoteIdentifier(database)}")
                    for (sql in sqlStatements) {
                        totalAffected += stmt.executeUpdate(sql)
                    }
                }
                call.ok(DataEditResult(
                    success = true,
                    sqlStatements = sqlStatements,
                    affectedRows = totalAffected
                ))
            } catch (e: Exception) {
                call.ok(DataEditResult(
                    success = false,
                    sqlStatements = sqlStatements,
                    errors = listOf(e.message ?: "执行失败")
                ))
            }
        }
    }
}

// ─── SQL 执行路由 ──────────────────────────────────────────
fun Route.sqlRoutes() {
    val connMgr = ServiceRegistry.connectionManager
    val sqlService = ServiceRegistry.sqlService
    val historyStore = ServiceRegistry.sqlHistoryStore

    post("/execute") {
        val req = call.receive<SqlExecuteRequest>()
        val session = connMgr.getSession(req.connectionId)
        if (session == null) {
            val errorResult = SqlResult(
                type = "error", duration = 0, sql = req.sql,
                executedAt = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")),
                error = "连接未打开，请先打开连接"
            )
            historyStore.add(req.connectionId, req.database, req.sql, errorResult)
            call.ok(listOf(errorResult))
            return@post
        }
        val results = sqlService.execute(session, req.database, req.sql)
        historyStore.add(req.connectionId, req.database, req.sql, results.first())
        call.ok(results)
    }

    get("/history") {
        val connectionId = call.request.queryParameters["connectionId"]
        val keyword = call.request.queryParameters["keyword"]
        val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 100
        call.ok(historyStore.list(connectionId, keyword, limit))
    }

    delete("/history") {
        ServiceRegistry.sqlHistoryStore.clear()
        call.ok(true)
    }
}

// ─── 数据迁移路由 ──────────────────────────────────────────
fun Route.migrationRoutes() {
    val adapter = ServiceRegistry.mysqlAdapter
    val connMgr = ServiceRegistry.connectionManager
    val taskMgr = ServiceRegistry.taskManager

    post("/preview") {
        val config = call.receive<MigrationConfig>()
        val sourceSession = connMgr.getSession(config.sourceConnectionId)
        val targetSession = connMgr.getSession(config.targetConnectionId)
        if (sourceSession == null || targetSession == null) {
            call.fail("NOT_CONNECTED", "源或目标连接未打开")
            return@post
        }
        val preview = adapter.migrationAdapter().preview(
            config, SessionPair(sourceSession, targetSession)
        )
        call.ok(preview)
    }

    post("/start") {
        val config = call.receive<MigrationConfig>()
        val sourceSession = connMgr.getSession(config.sourceConnectionId)
        val targetSession = connMgr.getSession(config.targetConnectionId)
        if (sourceSession == null || targetSession == null) {
            call.fail("NOT_CONNECTED", "源或目标连接未打开")
            return@post
        }

        val task = taskMgr.createTask(
            name = "迁移 ${config.sourceDatabase} → ${config.targetDatabase}",
            type = "migration"
        )
        val reporter = taskMgr.createReporter(task.id)

        // 异步执行迁移
        kotlinx.coroutines.GlobalScope.launch {
            reporter.onProgress(0, "准备中...")
            val startTime = System.currentTimeMillis()
            try {
                val result = adapter.migrationAdapter().execute(
                    config, SessionPair(sourceSession, targetSession), reporter
                )
                val duration = System.currentTimeMillis() - startTime
                when {
                    reporter.isCancelled() -> taskMgr.markCancelled(task.id, duration)
                    result.success -> taskMgr.markCompleted(task.id, duration)
                    else -> taskMgr.markFailed(task.id, result.errorMessage ?: "迁移失败")
                }
            } catch (e: Exception) {
                val duration = System.currentTimeMillis() - startTime
                if (reporter.isCancelled()) {
                    taskMgr.markCancelled(task.id, duration)
                } else {
                    taskMgr.markFailed(task.id, e.message ?: "迁移异常")
                }
            }
        }

        call.ok(TaskStartResult(taskId = task.id))
    }
}

// ─── 数据同步路由 ──────────────────────────────────────────
fun Route.syncRoutes() {
    val adapter = ServiceRegistry.mysqlAdapter
    val connMgr = ServiceRegistry.connectionManager
    val taskMgr = ServiceRegistry.taskManager

    post("/preview") {
        val config = call.receive<SyncConfig>()
        val sourceSession = connMgr.getSession(config.sourceConnectionId)
        val targetSession = connMgr.getSession(config.targetConnectionId)
        if (sourceSession == null || targetSession == null) {
            call.fail("NOT_CONNECTED", "源或目标连接未打开")
            return@post
        }
        val preview = adapter.syncAdapter().preview(
            config, SessionPair(sourceSession, targetSession)
        )
        call.ok(preview)
    }

    post("/start") {
        val config = call.receive<SyncConfig>()
        val sourceSession = connMgr.getSession(config.sourceConnectionId)
        val targetSession = connMgr.getSession(config.targetConnectionId)
        if (sourceSession == null || targetSession == null) {
            call.fail("NOT_CONNECTED", "源或目标连接未打开")
            return@post
        }

        val task = taskMgr.createTask(
            name = "同步 ${config.sourceDatabase} → ${config.targetDatabase}",
            type = "sync"
        )
        val reporter = taskMgr.createReporter(task.id)

        kotlinx.coroutines.GlobalScope.launch {
            reporter.onProgress(0, "准备中...")
            val startTime = System.currentTimeMillis()
            try {
                val result = adapter.syncAdapter().execute(
                    config, SessionPair(sourceSession, targetSession), reporter
                )
                val duration = System.currentTimeMillis() - startTime
                when {
                    reporter.isCancelled() -> taskMgr.markCancelled(task.id, duration)
                    result.success -> taskMgr.markCompleted(task.id, duration)
                    else -> taskMgr.markFailed(task.id, result.errorMessage ?: "同步失败")
                }
            } catch (e: Exception) {
                val duration = System.currentTimeMillis() - startTime
                if (reporter.isCancelled()) {
                    taskMgr.markCancelled(task.id, duration)
                } else {
                    taskMgr.markFailed(task.id, e.message ?: "同步异常")
                }
            }
        }

        call.ok(TaskStartResult(taskId = task.id))
    }
}

// ─── 任务中心路由 ──────────────────────────────────────────
fun Route.taskRoutes() {
    val taskMgr = ServiceRegistry.taskManager

    get("/list") {
        val status = call.request.queryParameters["status"]
        call.ok(taskMgr.list(status))
    }
    get("/{taskId}") {
        val taskId = call.parameters["taskId"]!!
        val task = taskMgr.get(taskId)
        if (task != null) call.ok(task) else call.fail("NOT_FOUND", "任务不存在")
    }
    get("/{taskId}/logs") {
        val taskId = call.parameters["taskId"]!!
        call.ok(taskMgr.getLogs(taskId))
    }
    get("/{taskId}/steps") {
        call.ok(emptyList<String>())
    }
    post("/{taskId}/cancel") {
        val taskId = call.parameters["taskId"]!!
        taskMgr.cancel(taskId)
        call.ok(true)
    }
}

// ─── 结构对比路由 ──────────────────────────────────────────
fun Route.compareRoutes() {
    val connMgr = ServiceRegistry.connectionManager
    val adapter = ServiceRegistry.mysqlAdapter
    val compareService = StructureCompareService()

    post("/execute") {
        try {
            val config = call.receive<CompareConfig>()

            val sourceSession = connMgr.getSession(config.sourceConnectionId)
            if (sourceSession == null) {
                call.fail("NOT_CONNECTED", "源连接未打开，请先打开连接")
                return@post
            }
            val targetSession = connMgr.getSession(config.targetConnectionId)
            if (targetSession == null) {
                call.fail("NOT_CONNECTED", "目标连接未打开，请先打开连接")
                return@post
            }

            val result = compareService.compare(
                sourceMetadata = adapter.metadataAdapter(),
                targetMetadata = adapter.metadataAdapter(),
                sourceDialect = adapter.dialectAdapter(),
                sourceSession = sourceSession,
                targetSession = targetSession,
                config = config
            )
            call.ok(result)
        } catch (e: Exception) {
            call.fail("COMPARE_ERROR", "结构对比失败: ${e.message}")
        }
    }
}

// ─── 辅助函数 ──────────────────────────────────────────────

private suspend fun getSessionOrFail(
    call: ApplicationCall,
    connMgr: ConnectionManager
): DatabaseSession? {
    val connectionId = call.parameters["connectionId"]
        ?: run {
            call.fail("INVALID_ID", "缺少连接 ID")
            return null
        }
    return connMgr.getSession(connectionId)
        ?: run {
            call.fail("NOT_CONNECTED", "连接未打开，请先打开连接")
            return null
        }
}

