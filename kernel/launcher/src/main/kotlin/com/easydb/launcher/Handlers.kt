/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
package com.easydb.launcher

import com.easydb.api.ok
import com.easydb.api.fail
import com.easydb.common.*
import com.easydb.drivers.mysql.MysqlConnectionAdapter
import com.easydb.drivers.mysql.MysqlDatabaseSession
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.io.File
import java.util.UUID

/** 专用任务协程域：替代 GlobalScope，支持统一生命周期治理 */
private val taskScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

// ─── 连接管理路由 ──────────────────────────────────────────
fun Route.connectionRoutes() {
    val store = ServiceRegistry.connectionStore
    val adapter = ServiceRegistry.mysqlAdapter
    val connMgr = ServiceRegistry.connectionManager
    val querySessionMgr = ServiceRegistry.sqlQuerySessionManager

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
        querySessionMgr.closeByConnectionId(id)
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
            querySessionMgr.closeByConnectionId(id)
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
        querySessionMgr.closeByConnectionId(id)
        connMgr.closeSession(id)
        store.updateStatus(id, "disconnected")
        call.ok(true)
    }
}

// ─── 连接分组路由 ──────────────────────────────────────────
fun Route.groupRoutes() {
    val store = ServiceRegistry.groupStore

    // 获取分组列表
    get("/list") {
        call.ok(store.getAll())
    }

    // 新建分组
    post("/create") {
        val group = call.receive<ConnectionGroup>()
        val newGroup = group.copy(id = UUID.randomUUID().toString())
        store.save(newGroup)
        call.ok(newGroup)
    }

    // 更新分组
    put("/{id}") {
        val id = call.parameters["id"] ?: return@put call.fail("INVALID_ID", "缺少分组 ID")
        val group = call.receive<ConnectionGroup>()
        if (store.getById(id) == null) {
            call.fail("NOT_FOUND", "分组不存在")
            return@put
        }
        val updated = store.save(group.copy(id = id))
        call.ok(updated)
    }

    // 删除分组
    delete("/{id}") {
        val id = call.parameters["id"] ?: return@delete call.fail("INVALID_ID", "缺少分组 ID")
        store.delete(id)
        call.ok(true)
    }
}

/** 从 JSON body 解析 TableDefinition */
private fun parseTableDefinition(body: kotlinx.serialization.json.JsonObject): TableDefinition {
    fun kotlinx.serialization.json.JsonElement?.str(): String =
        (this as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""
    fun kotlinx.serialization.json.JsonElement?.bool(): Boolean =
        (this as? kotlinx.serialization.json.JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false

    val tableName = body["tableName"].str()
    val comment = body["comment"].str()

    val columnsArr = body["columns"] as? kotlinx.serialization.json.JsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())
    val columns = columnsArr.map { elem ->
        val obj = elem as kotlinx.serialization.json.JsonObject
        val lengthStr = (obj["length"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""
        ColumnInfo(
            name = obj["name"].str(),
            type = obj["type"].str() + if (lengthStr.isNotBlank()) "($lengthStr)" else "",
            nullable = obj["nullable"].bool(),
            defaultValue = (obj["defaultValue"] as? kotlinx.serialization.json.JsonPrimitive)?.content,
            isPrimaryKey = obj["isPrimaryKey"].bool(),
            isAutoIncrement = obj["isAutoIncrement"].bool(),
            comment = (obj["comment"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        )
    }

    val indexesArr = body["indexes"] as? kotlinx.serialization.json.JsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())
    val indexes = indexesArr.map { elem ->
        val obj = elem as kotlinx.serialization.json.JsonObject
        val idxCols = (obj["columns"] as? kotlinx.serialization.json.JsonArray)?.map {
            (it as kotlinx.serialization.json.JsonPrimitive).content
        } ?: emptyList()
        IndexInfo(
            name = obj["name"].str(),
            columns = idxCols,
            isUnique = obj["isUnique"].bool(),
            isPrimary = obj["isPrimary"].bool()
        )
    }

    return TableDefinition(
        table = TableInfo(name = tableName, comment = comment),
        columns = columns,
        indexes = indexes
    )
}

// ─── 元数据路由 ────────────────────────────────────────────
fun Route.metadataRoutes() {
    val adapter = ServiceRegistry.mysqlAdapter
    val connMgr = ServiceRegistry.connectionManager

    get("/{connectionId}/databases") {
        val session = getSessionOrFail(call, connMgr) ?: return@get
        call.ok(adapter.metadataAdapter().listDatabases(session))
    }

    // 获取字符集列表（必须在 /{connectionId}/{database} 参数路由之前注册）
    get("/{connectionId}/charsets") {
        val session = getSessionOrFail(call, connMgr) ?: return@get
        call.ok(adapter.metadataAdapter().listCharsets(session))
    }

    // 新建数据库
    post("/{connectionId}/create-database") {
        val session = getSessionOrFail(call, connMgr) ?: return@post
        try {
            val body = call.receive<kotlinx.serialization.json.JsonObject>()
            val name = body["name"]?.let { (it as kotlinx.serialization.json.JsonPrimitive).content }
                ?: return@post call.fail("INVALID_REQUEST", "缺少 name 参数")
            val charset = body["charset"]?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: "utf8mb4"
            val collation = body["collation"]?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: "utf8mb4_general_ci"
            adapter.metadataAdapter().createDatabase(session, name, charset, collation)
            call.ok(true)
        } catch (e: Exception) {
            call.fail("CREATE_DB_FAILED", e.message ?: "创建数据库失败")
        }
    }

    // 删除数据库
    delete("/{connectionId}/drop-database/{database}") {
        val session = getSessionOrFail(call, connMgr) ?: return@delete
        val database = call.parameters["database"]!!
        try {
            adapter.metadataAdapter().dropDatabase(session, database)
            call.ok(true)
        } catch (e: Exception) {
            call.fail("DROP_DB_FAILED", e.message ?: "删除数据库失败")
        }
    }

    // 编辑数据库（修改字符集/排序规则）
    post("/{connectionId}/alter-database") {
        val session = getSessionOrFail(call, connMgr) ?: return@post
        try {
            val body = call.receive<kotlinx.serialization.json.JsonObject>()
            val name = (body["name"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                ?: return@post call.fail("INVALID_REQUEST", "缺少 name 参数")
            val charset = (body["charset"] as? kotlinx.serialization.json.JsonPrimitive)?.content
            val collation = (body["collation"] as? kotlinx.serialization.json.JsonPrimitive)?.content
            val dialect = adapter.dialectAdapter()
            val sql = buildString {
                append("ALTER DATABASE ${dialect.quoteIdentifier(name)}")
                if (!charset.isNullOrBlank()) append(" CHARACTER SET $charset")
                if (!collation.isNullOrBlank()) append(" COLLATE $collation")
            }
            val connField = session.javaClass.getDeclaredField("connection")
            connField.isAccessible = true
            val jdbcConn = connField.get(session) as java.sql.Connection
            jdbcConn.createStatement().use { it.execute(sql) }
            call.ok(true)
        } catch (e: Exception) {
            call.fail("ALTER_DB_FAILED", e.message ?: "修改数据库失败")
        }
    }

    // 重命名表
    post("/{connectionId}/{database}/rename-table") {
        val session = getSessionOrFail(call, connMgr) ?: return@post
        val database = call.parameters["database"]!!
        try {
            val body = call.receive<kotlinx.serialization.json.JsonObject>()
            val oldName = (body["oldName"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                ?: return@post call.fail("INVALID_REQUEST", "缺少 oldName 参数")
            val newName = (body["newName"] as? kotlinx.serialization.json.JsonPrimitive)?.content
                ?: return@post call.fail("INVALID_REQUEST", "缺少 newName 参数")
            val dialect = adapter.dialectAdapter()
            val sql = "RENAME TABLE ${dialect.quoteIdentifier(database)}.${dialect.quoteIdentifier(oldName)} TO ${dialect.quoteIdentifier(database)}.${dialect.quoteIdentifier(newName)}"
            val connField = session.javaClass.getDeclaredField("connection")
            connField.isAccessible = true
            val jdbcConn = connField.get(session) as java.sql.Connection
            jdbcConn.createStatement().use { it.execute(sql) }
            call.ok(true)
        } catch (e: Exception) {
            call.fail("RENAME_TABLE_FAILED", e.message ?: "重命名表失败")
        }
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

    post("/{connectionId}/{database}/tables/{table}/preview") {
        val session = getSessionOrFail(call, connMgr) ?: return@post
        val database = call.parameters["database"]!!
        val table = call.parameters["table"]!!
        val body = try { call.receiveText().let { if (it.isBlank()) emptyMap() else kotlinx.serialization.json.Json.decodeFromString<Map<String, kotlinx.serialization.json.JsonElement>>(it) } } catch (_: Exception) { emptyMap<String, kotlinx.serialization.json.JsonElement>() }
        val limit = (body["limit"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: 1000
        val where = (body["where"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        val orderBy = (body["orderBy"] as? kotlinx.serialization.json.JsonPrimitive)?.content
        val offset = (body["offset"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: 0
        call.ok(adapter.metadataAdapter().previewRows(session, database, table, limit, where, orderBy, offset))
    }

    get("/{connectionId}/{database}/tables/{table}/ddl") {
        val session = getSessionOrFail(call, connMgr) ?: return@get
        val database = call.parameters["database"]!!
        val table = call.parameters["table"]!!
        call.ok(adapter.metadataAdapter().getDdl(session, database, table))
    }

    // 预览建表 DDL（不执行）
    post("/{connectionId}/{database}/preview-create-table") {
        val session = getSessionOrFail(call, connMgr) ?: return@post
        try {
            val body = call.receive<kotlinx.serialization.json.JsonObject>()
            val tableDef = parseTableDefinition(body)
            val ddl = adapter.dialectAdapter().buildCreateTable(tableDef)
            val escaped = ddl.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
            call.respondText("""{"success":true,"data":{"ddl":"$escaped"}}""", io.ktor.http.ContentType.Application.Json)
        } catch (e: Exception) {
            call.fail("PREVIEW_FAILED", e.message ?: "生成 DDL 预览失败")
        }
    }

    // 新建表（执行 DDL）
    post("/{connectionId}/{database}/create-table") {
        val session = getSessionOrFail(call, connMgr) ?: return@post
        val database = call.parameters["database"]!!
        try {
            val body = call.receive<kotlinx.serialization.json.JsonObject>()
            val tableDef = parseTableDefinition(body)
            val ddl = adapter.dialectAdapter().buildCreateTable(tableDef)

            val connField = session.javaClass.getDeclaredField("connection")
            connField.isAccessible = true
            val jdbcConn = connField.get(session) as java.sql.Connection
            jdbcConn.createStatement().use { stmt ->
                stmt.execute("USE ${adapter.dialectAdapter().quoteIdentifier(database)}")
                stmt.execute(ddl)
            }
            val escaped = ddl.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")
            call.respondText("""{"success":true,"data":{"success":true,"ddl":"$escaped"}}""", io.ktor.http.ContentType.Application.Json)
        } catch (e: Exception) {
            call.fail("CREATE_TABLE_FAILED", e.message ?: "创建表失败")
        }
    }

    // 删除表
    delete("/{connectionId}/{database}/tables/{table}") {
        val session = getSessionOrFail(call, connMgr) ?: return@delete
        val database = call.parameters["database"]!!
        val table = call.parameters["table"]!!
        try {
            val connField = session.javaClass.getDeclaredField("connection")
            connField.isAccessible = true
            val jdbcConn = connField.get(session) as java.sql.Connection
            val dialect = adapter.dialectAdapter()
            jdbcConn.createStatement().use { stmt ->
                stmt.execute("USE ${dialect.quoteIdentifier(database)}")
                stmt.execute("DROP TABLE ${dialect.quoteIdentifier(table)}")
            }
            call.ok(true)
        } catch (e: Exception) {
            call.fail("DROP_TABLE_FAILED", e.message ?: "删除表失败")
        }
    }

    // 清空表
    post("/{connectionId}/{database}/tables/{table}/truncate") {
        val session = getSessionOrFail(call, connMgr) ?: return@post
        val database = call.parameters["database"]!!
        val table = call.parameters["table"]!!
        try {
            val connField = session.javaClass.getDeclaredField("connection")
            connField.isAccessible = true
            val jdbcConn = connField.get(session) as java.sql.Connection
            val dialect = adapter.dialectAdapter()
            jdbcConn.createStatement().use { stmt ->
                stmt.execute("USE ${dialect.quoteIdentifier(database)}")
                stmt.execute("TRUNCATE TABLE ${dialect.quoteIdentifier(table)}")
            }
            call.ok(true)
        } catch (e: Exception) {
            call.fail("TRUNCATE_TABLE_FAILED", e.message ?: "清空表失败")
        }
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
    val querySessionMgr = ServiceRegistry.sqlQuerySessionManager
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

    post("/query-preview") {
        val req = call.receive<SqlQueryPreviewRequest>()
        val session = connMgr.getSession(req.connectionId)
        if (session == null) {
            val errorResult = SqlResult(
                type = "error",
                duration = 0,
                sql = req.sql,
                executedAt = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")),
                error = "连接未打开，请先打开连接"
            )
            call.ok(errorResult)
            return@post
        }

        val result = sqlService.previewQuery(
            session = session,
            database = req.database,
            sql = req.sql,
            offset = req.offset,
            pageSize = req.pageSize,
            maxCellChars = req.maxCellChars
        )
        if (req.offset == 0) {
            historyStore.add(req.connectionId, req.database, req.sql, result)
        }
        call.ok(result)
    }

    post("/query-session/start") {
        val req = call.receive<SqlQuerySessionStartRequest>()
        val session = connMgr.getSession(req.connectionId)
        if (session == null) {
            val errorResult = SqlResult(
                type = "error",
                duration = 0,
                sql = req.sql,
                executedAt = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")),
                error = "连接未打开，请先打开连接"
            )
            call.ok(errorResult)
            return@post
        }

        val result = querySessionMgr.start(
            session = session,
            database = req.database,
            sql = req.sql,
            pageSize = req.pageSize,
            maxCellChars = req.maxCellChars
        )
        historyStore.add(req.connectionId, req.database, req.sql, result)
        call.ok(result)
    }

    post("/query-session/fetch") {
        val req = call.receive<SqlQuerySessionFetchRequest>()
        call.ok(querySessionMgr.fetch(req.querySessionId, req.pageSize, req.maxCellChars))
    }

    post("/query-session/status") {
        val req = call.receive<SqlQuerySessionStatusRequest>()
        call.ok(querySessionMgr.getStatus(req.querySessionId))
    }

    post("/query-session/close") {
        val req = call.receive<SqlQuerySessionCloseRequest>()
        querySessionMgr.close(req.querySessionId)
        call.ok(true)
    }

    post("/import-file/start") {
        val req = call.receive<SqlImportFileRequest>()
        val session = connMgr.getSession(req.connectionId)
        if (session == null) {
            call.fail("NOT_CONNECTED", "连接未打开，请先打开连接")
            return@post
        }

        val file = File(req.filePath)
        if (!file.exists() || !file.isFile) {
            call.fail("FILE_NOT_FOUND", "SQL 文件不存在或无法访问")
            return@post
        }

        // C1: 同库并发导入限制 —— 同一连接+数据库下只允许一个导入任务运行
        val taskMgr = ServiceRegistry.taskManager
        val runningImport = taskMgr.list().find { t ->
            t.type == "import"
            && t.status in listOf("pending", "running")
            && t.name.contains(req.database)
            && t.name.contains("导入")
        }
        if (runningImport != null) {
            call.fail("DUPLICATE_IMPORT", "数据库 ${req.database} 已有导入任务正在执行（任务 ID: ${runningImport.id}），请等待完成后再试")
            return@post
        }

        val config = session.config
        val task = taskMgr.createTask(
            name = "导入 ${req.database} ← ${(req.fileName ?: file.name)}",
            type = "import"
        )
        val reporter = taskMgr.createReporter(task.id)

        taskScope.launch {
            reporter.onProgress(1, "初始化导入环境...")
            val startTime = System.currentTimeMillis()
            var dedicatedConn: java.sql.Connection? = null

            try {
                val importConfig = config.copy(database = req.database)
                reporter.onLog("INFO", "正在验证并建立专用导入连接 [${req.database}]...")
                dedicatedConn = withTimeout(15000L) {
                    MysqlConnectionAdapter.createJdbcConnection(importConfig)
                }
                reporter.onLog("INFO", "专用导入连接已就绪")
                reporter.onLog("INFO", "准备导入文件: ${file.absolutePath}")

                val taskSession = MysqlDatabaseSession(config.id, config, dedicatedConn)
                val result = sqlService.importSqlFile(taskSession, req.database, file, reporter)
                val duration = System.currentTimeMillis() - startTime

                when {
                    reporter.isCancelled() -> taskMgr.markCancelled(task.id, duration, result)
                    result.success -> taskMgr.markCompleted(task.id, duration, result)
                    else -> taskMgr.markFailed(task.id, result.errorMessage ?: "SQL 文件导入失败", result)
                }
            } catch (e: Exception) {
                val duration = System.currentTimeMillis() - startTime
                if (reporter.isCancelled()) {
                    taskMgr.markCancelled(task.id, duration)
                } else {
                    taskMgr.markFailed(task.id, e.message ?: "SQL 文件导入异常")
                }
            } finally {
                try { dedicatedConn?.close() } catch (_: Exception) {}
            }
        }

        call.ok(TaskStartResult(taskId = task.id))
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

        // 异步执行迁移（为每个任务创建独立 JDBC 连接，避免并发任务共享连接导致 autoCommit 冲突）
        taskScope.launch {
            reporter.onProgress(0, "准备中...")
            val startTime = System.currentTimeMillis()
            // 创建任务专用的独立 JDBC 连接
            var dedicatedSourceConn: java.sql.Connection? = null
            var dedicatedTargetConn: java.sql.Connection? = null
            try {
                val sourceConfig = (sourceSession as MysqlDatabaseSession).config
                val targetConfig = (targetSession as MysqlDatabaseSession).config
                dedicatedSourceConn = MysqlConnectionAdapter.createJdbcConnection(sourceConfig)
                dedicatedTargetConn = MysqlConnectionAdapter.createJdbcConnection(targetConfig)
                val taskSourceSession = MysqlDatabaseSession(sourceConfig.id, sourceConfig, dedicatedSourceConn)
                val taskTargetSession = MysqlDatabaseSession(targetConfig.id, targetConfig, dedicatedTargetConn)
                reporter.onLog("INFO", "已创建任务专用连接")

                val result = adapter.migrationAdapter().execute(
                    config, SessionPair(taskSourceSession, taskTargetSession), reporter
                )
                val duration = System.currentTimeMillis() - startTime
                when {
                    reporter.isCancelled() -> taskMgr.markCancelled(task.id, duration)
                    result.success -> taskMgr.markCompleted(task.id, duration, result)
                    else -> taskMgr.markFailed(task.id, result.errorMessage ?: "迁移失败", result)
                }
            } catch (e: Exception) {
                val duration = System.currentTimeMillis() - startTime
                if (reporter.isCancelled()) {
                    taskMgr.markCancelled(task.id, duration)
                } else {
                    taskMgr.markFailed(task.id, e.message ?: "迁移异常")
                }
            } finally {
                // 关闭任务专用连接
                try { dedicatedSourceConn?.close() } catch (_: Exception) {}
                try { dedicatedTargetConn?.close() } catch (_: Exception) {}
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

        // 异步执行同步（为每个任务创建独立 JDBC 连接，避免并发任务共享连接导致 autoCommit 冲突）
        taskScope.launch {
            reporter.onProgress(0, "准备中...")
            val startTime = System.currentTimeMillis()
            // 创建任务专用的独立 JDBC 连接
            var dedicatedSourceConn: java.sql.Connection? = null
            var dedicatedTargetConn: java.sql.Connection? = null
            try {
                val sourceConfig = (sourceSession as MysqlDatabaseSession).config
                val targetConfig = (targetSession as MysqlDatabaseSession).config
                dedicatedSourceConn = MysqlConnectionAdapter.createJdbcConnection(sourceConfig)
                dedicatedTargetConn = MysqlConnectionAdapter.createJdbcConnection(targetConfig)
                val taskSourceSession = MysqlDatabaseSession(sourceConfig.id, sourceConfig, dedicatedSourceConn)
                val taskTargetSession = MysqlDatabaseSession(targetConfig.id, targetConfig, dedicatedTargetConn)
                reporter.onLog("INFO", "已创建任务专用连接")

                val result = adapter.syncAdapter().execute(
                    config, SessionPair(taskSourceSession, taskTargetSession), reporter
                )
                val duration = System.currentTimeMillis() - startTime
                when {
                    reporter.isCancelled() -> taskMgr.markCancelled(task.id, duration)
                    result.success -> taskMgr.markCompleted(task.id, duration, result)
                    else -> taskMgr.markFailed(task.id, result.errorMessage ?: "同步失败", result)
                }
            } catch (e: Exception) {
                val duration = System.currentTimeMillis() - startTime
                if (reporter.isCancelled()) {
                    taskMgr.markCancelled(task.id, duration)
                } else {
                    taskMgr.markFailed(task.id, e.message ?: "同步异常")
                }
            } finally {
                // 关闭任务专用连接
                try { dedicatedSourceConn?.close() } catch (_: Exception) {}
                try { dedicatedTargetConn?.close() } catch (_: Exception) {}
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
    get("/{taskId}/download-log") {
        val taskId = call.parameters["taskId"]!!
        val logFile = java.io.File(System.getProperty("user.home"), ".easydb/logs/$taskId.log")
        call.response.header("Content-Disposition", "attachment; filename=\"easydb-task-$taskId.log\"")
        if (logFile.exists() && logFile.isFile) {
            call.respondFile(logFile)
        } else {
            // fallback if physical log doesn't exist
            val inMemoryLogs = taskMgr.getLogs(taskId)
            val content = inMemoryLogs.joinToString("\n") { "[${it.timestamp}] [${it.level}] ${it.message}" }
            call.respondText(content, io.ktor.http.ContentType.Text.Plain)
        }
    }
    get("/{taskId}/steps") {
        call.ok(emptyList<String>())
    }
    post("/{taskId}/cancel") {
        val taskId = call.parameters["taskId"]!!
        taskMgr.cancel(taskId)
        call.ok(true)
    }
    delete("/{taskId}") {
        val taskId = call.parameters["taskId"]!!
        val deleted = taskMgr.delete(taskId)
        if (deleted) call.ok(true) else call.fail("DELETE_FAILED", "任务正在运行或不存在，无法删除")
    }
    post("/clear-completed") {
        val count = taskMgr.clearCompleted()
        call.ok(mapOf("cleared" to count))
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

// ─── 系统路由 ──────────────────────────────────────────────
fun Route.systemRoutes() {
    get("/check-update") {
        try {
            val currentVersion = System.getProperty("app.version") ?: "1.2.0"
            // 通过 git ls-remote 获取远程 tags
            val process = ProcessBuilder("git", "ls-remote", "--tags", "origin")
                .redirectErrorStream(true)
                .start()
            val output = process.inputStream.bufferedReader().readText()
            process.waitFor()

            // 解析 tag 名称，找最大版本号
            val tagRegex = Regex("""refs/tags/(v?\d+\.\d+\.\d+)$""", RegexOption.MULTILINE)
            val versions = tagRegex.findAll(output).map { it.groupValues[1].removePrefix("v") }.toList()

            val latestVersion = versions
                .sortedWith(compareBy(
                    { it.split(".").getOrElse(0) { "0" }.toIntOrNull() ?: 0 },
                    { it.split(".").getOrElse(1) { "0" }.toIntOrNull() ?: 0 },
                    { it.split(".").getOrElse(2) { "0" }.toIntOrNull() ?: 0 }
                ))
                .lastOrNull() ?: currentVersion

            val currentParts = currentVersion.removePrefix("v").split(".").map { it.toIntOrNull() ?: 0 }
            val latestParts = latestVersion.split(".").map { it.toIntOrNull() ?: 0 }
            val hasUpdate = (0 until maxOf(currentParts.size, latestParts.size)).any { i ->
                val c = currentParts.getOrElse(i) { 0 }
                val l = latestParts.getOrElse(i) { 0 }
                if (l != c) l > c else false
            }

            call.ok(mapOf(
                "hasUpdate" to hasUpdate,
                "latestVersion" to latestVersion,
                "currentVersion" to currentVersion,
                "downloadUrl" to "https://github.com/qingwz1994/easydb/releases"
            ))
        } catch (e: Exception) {
            call.ok(mapOf(
                "hasUpdate" to false,
                "error" to (e.message ?: "检查更新失败")
            ))
        }
    }
}

fun Route.scriptRoutes() {
    get("/list") {
        val scriptManager = ServiceRegistry.scriptManager
        call.ok(scriptManager.list())
    }

    post("/save") {
        val req = call.receive<Map<String, String>>()
        val id = req["id"]
        val name = req["name"] ?: return@post call.respond(mapOf("code" to 1, "message" to "Name is required"))
        val content = req["content"] ?: return@post call.respond(mapOf("code" to 1, "message" to "Content is required"))
        val database = req["database"]

        val scriptManager = ServiceRegistry.scriptManager
        val saved = scriptManager.save(name, content, database, id)
        call.ok(saved)
    }

    delete("/{id}") {
        val id = call.parameters["id"] ?: return@delete call.respond(mapOf("code" to 1, "message" to "ID is required"))
        val scriptManager = ServiceRegistry.scriptManager
        if (scriptManager.delete(id)) call.ok(mapOf("success" to true)) else call.respond(mapOf("code" to 1, "message" to "Script not found"))
    }
}
