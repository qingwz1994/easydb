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
package com.easydb.common

import kotlinx.serialization.Serializable

/**
 * 数据库适配器接口 - 支持多数据库扩展的核心抽象
 * 首版仅实现 MySQL，架构上预留扩展基础
 */
interface DatabaseAdapter {
    fun dbType(): DbType
    fun capabilities(): DatabaseCapabilities
    fun connectionAdapter(): ConnectionAdapter
    fun metadataAdapter(): MetadataAdapter
    fun dialectAdapter(): DialectAdapter
    fun syncAdapter(): SyncAdapter
    fun migrationAdapter(): MigrationAdapter
    fun procedureAdapter(): ProcedureAdapter  // 存储过程/函数适配器

    /**
     * 慢查询分析适配器（可选）。
     * MySQL 返回 [MysqlSlowQueryAnalyzer] 实例，其他数据库先返回 null。
     * 调用方应先检查是否为 null 再决定是否展示功能入口。
     */
    fun slowQueryAnalyzer(): SlowQueryAnalyzer? = null
}

// ─── 连接适配器 ───────────────────────────────────────────
interface ConnectionAdapter {
    fun testConnection(config: ConnectionConfig): ConnectionTestResult
    fun open(config: ConnectionConfig): DatabaseSession
    fun close(session: DatabaseSession)
}

@Serializable
data class ConnectionTestResult(
    val success: Boolean,
    val message: String,
    val latencyMs: Long? = null
)

interface DatabaseSession {
    val connectionId: String
    val config: ConnectionConfig
    fun isValid(): Boolean
    fun close()

    /**
     * 获取底层 JDBC Connection。
     * 替代反射和强制转型，为上层提供统一的连接获取方式。
     */
    fun getJdbcConnection(): java.sql.Connection
}

// ─── 元数据适配器 ─────────────────────────────────────────
interface MetadataAdapter {
    fun listDatabases(session: DatabaseSession): List<DatabaseInfo>
    fun listTables(session: DatabaseSession, database: String): List<TableInfo>
    fun listTriggers(session: DatabaseSession, database: String): List<TriggerInfo> = emptyList()
    fun listRoutines(session: DatabaseSession, database: String): List<RoutineInfo> = emptyList()
    fun getTableDefinition(session: DatabaseSession, database: String, table: String): TableDefinition
    fun getIndexes(session: DatabaseSession, database: String, table: String): List<IndexInfo>
    fun previewRows(session: DatabaseSession, database: String, table: String, limit: Int = 100, where: String? = null, orderBy: String? = null, offset: Int = 0): List<Map<String, String?>>
    fun getDdl(session: DatabaseSession, database: String, table: String): String
    fun createDatabase(session: DatabaseSession, name: String, charset: String = "utf8mb4", collation: String = "utf8mb4_general_ci")
    fun listCharsets(session: DatabaseSession): List<CharsetInfo> = emptyList()
    fun dropDatabase(session: DatabaseSession, name: String)

 /**
  * 根据对象类型精确获取 DDL（供结构对比/迁移使用）
  * @param objectType: "table" | "view" | "procedure" | "function" | "trigger"
  */
 fun getObjectDdl(session: DatabaseSession, database: String, name: String, objectType: String): String {
  return getDdl(session, database, name)
 }
}

// ─── 方言适配器 ───────────────────────────────────────────
interface DialectAdapter {
    fun quoteIdentifier(name: String): String
    fun buildCreateTable(table: TableDefinition): String
    fun buildInsert(tableName: String, columns: List<String>): String

    /** 生成 UPDATE SQL */
    fun buildUpdateSql(tableName: String, setCols: List<String>, whereCols: List<String>): String {
        val setClause = setCols.joinToString(", ") { "${quoteIdentifier(it)} = ?" }
        val whereClause = whereCols.joinToString(" AND ") { "${quoteIdentifier(it)} = ?" }
        return "UPDATE ${quoteIdentifier(tableName)} SET $setClause WHERE $whereClause"
    }

    /** 生成 DELETE SQL */
    fun buildDeleteSql(tableName: String, whereCols: List<String>): String {
        val whereClause = whereCols.joinToString(" AND ") { "${quoteIdentifier(it)} = ?" }
        return "DELETE FROM ${quoteIdentifier(tableName)} WHERE $whereClause"
    }

    /** 生成 INSERT SQL（带值占位符） */
    fun buildInsertSql(tableName: String, columns: List<String>): String {
        val cols = columns.joinToString(", ") { quoteIdentifier(it) }
        val placeholders = columns.joinToString(", ") { "?" }
        return "INSERT INTO ${quoteIdentifier(tableName)} ($cols) VALUES ($placeholders)"
    }

    /** 转义字符串值 */
    fun escapeValue(value: String?): String {
        if (value == null) return "NULL"
        return "'${value.replace("'", "''")}'"
    }
}

// ─── 同步适配器 ───────────────────────────────────────────
interface SyncAdapter {
    fun preview(config: SyncConfig, sessions: SessionPair): SyncPreview
    fun execute(config: SyncConfig, sessions: SessionPair, reporter: TaskReporter): TaskResult
}

// ─── 迁移适配器 ───────────────────────────────────────────
interface MigrationAdapter {
    fun preview(config: MigrationConfig, sessions: SessionPair): MigrationPreview
    fun execute(config: MigrationConfig, sessions: SessionPair, reporter: TaskReporter): TaskResult
}

// ─── 辅助类型 ─────────────────────────────────────────────
data class SessionPair(
    val source: DatabaseSession,
    val target: DatabaseSession
)

interface TaskReporter {
    fun onProgress(progress: Int, message: String? = null)
    fun onStep(stepName: String, status: TaskStatus, message: String? = null)
    fun onLog(level: String, message: String)
    fun isCancelled(): Boolean
}

@Serializable
data class TaskResult(
    val success: Boolean,
    val successCount: Int = 0,
    val failureCount: Int = 0,
    val skippedCount: Int = 0,
    val errorMessage: String? = null,
    val verification: List<TableVerifyResult>? = null,
    val payload: Map<String, String>? = null
)

@Serializable
data class TableVerifyResult(
    val tableName: String,
    val sourceRows: Long,        // 源库行数（information_schema 估算）
    val targetRows: Long,        // 目标库行数（同步过程实际写入数）
    val status: String,          // match | mismatch | failed
    val errorMessage: String? = null
)

@Serializable
data class TaskStartResult(
    val taskId: String
)

// ─── 存储过程 / 函数适配器接口 ──────────────────────────────

/**
 * 存储过程/函数适配器。
 * 每个数据库实现这 4 个方法，执行引擎（ProcedureExecuteService）只做纯 JDBC 标准操作。
 * 扩展方式：新增 PgProcedureAdapter / DmProcedureAdapter 实现此接口即可。
 */
interface ProcedureAdapter {

    /**
     * 查询存储过程或函数的参数元数据。
     * 各数据库系统表不同，必须由各自实现：
     *   MySQL → INFORMATION_SCHEMA.PARAMETERS
     *   PG    → pg_catalog.pg_proc + pg_type
     *   DM    → ALL_ARGUMENTS（兼容 Oracle）
     */
    fun inspect(
        session: DatabaseSession,
        database: String,
        name: String,
        type: String    // "PROCEDURE" | "FUNCTION"
    ): ProcedureInspectResult

    /**
     * 生成 CALL 语句（含 ? 占位符，用于 CallableStatement / PreparedStatement）。
     *   MySQL → CALL `db`.`proc`(?, ?, ?)
     *   PG    → CALL "schema"."proc"($1, $2, $3)
     *   DM    → CALL db.proc(?, ?, ?)
     */
    fun buildCallSql(database: String, name: String, paramCount: Int): String

    /**
     * 生成函数调用 SQL（作为 SELECT 表达式）。
     *   MySQL → SELECT `db`.`func`(?, ?) AS `result`
     *   PG    → SELECT "schema"."func"($1, $2) AS result
     *   DM    → SELECT db.func(?, ?) AS result FROM dual
     */
    fun buildFunctionCallSql(database: String, name: String, paramCount: Int): String

    /**
     * 生成切换目标数据库的 SQL。
     *   MySQL → USE `db`
     *   PG    → SET search_path TO "schema"
     *   DM    → 返回空字符串（连接串中指定）
     */
    fun buildSwitchDatabaseSql(database: String): String
}
