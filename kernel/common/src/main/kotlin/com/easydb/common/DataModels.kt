package com.easydb.common

import kotlinx.serialization.Serializable

// ─── 数据库对象模型 ───────────────────────────────────────
@Serializable
data class DatabaseInfo(
    val name: String,
    val charset: String? = null,
    val collation: String? = null
)

@Serializable
data class CharsetInfo(
    val charset: String,
    val defaultCollation: String,
    val collations: List<String> = emptyList()
)

@Serializable
data class TableInfo(
    val name: String,
    val schema: String? = null,
    val type: String = "table", // table | view | trigger
    val rowCount: Long? = null,
    val comment: String? = null,
    val dataLength: Long? = null,
    val indexLength: Long? = null,
    val updateTime: String? = null,
    val engine: String? = null
)

@Serializable
data class TriggerInfo(
    val name: String,
    val table: String? = null,
    val event: String? = null,     // INSERT | UPDATE | DELETE
    val timing: String? = null,    // BEFORE | AFTER
    val statement: String? = null,
    val comment: String? = null
)

@Serializable
data class RoutineInfo(
    val name: String,
    val type: String,              // PROCEDURE | FUNCTION
    val definer: String? = null,
    val created: String? = null,
    val modified: String? = null,
    val comment: String? = null
)

@Serializable
data class ColumnInfo(
    val name: String,
    val type: String,
    val nullable: Boolean = true,
    val defaultValue: String? = null,
    val isPrimaryKey: Boolean = false,
    val isAutoIncrement: Boolean = false,
    val comment: String? = null
)

@Serializable
data class IndexInfo(
    val name: String,
    val columns: List<String>,
    val isUnique: Boolean = false,
    val isPrimary: Boolean = false,
    val type: String = "BTREE"
)

@Serializable
data class TableDefinition(
    val table: TableInfo,
    val columns: List<ColumnInfo>,
    val indexes: List<IndexInfo>,
    val ddl: String? = null
)

// ─── SQL 执行模型 ────────────────────────────────────────
@Serializable
data class SqlExecuteRequest(
    val connectionId: String,
    val database: String,
    val sql: String
)

@Serializable
data class SqlQueryPreviewRequest(
    val connectionId: String,
    val database: String,
    val sql: String,
    val offset: Int = 0,
    val pageSize: Int = 200,
    val maxCellChars: Int = 4096
)

@Serializable
data class SqlQuerySessionStartRequest(
    val connectionId: String,
    val database: String,
    val sql: String,
    val pageSize: Int = 200,
    val maxCellChars: Int = 4096
)

@Serializable
data class SqlQuerySessionFetchRequest(
    val querySessionId: String,
    val pageSize: Int = 200,
    val maxCellChars: Int = 4096
)

@Serializable
data class SqlQuerySessionCloseRequest(
    val querySessionId: String
)

@Serializable
data class SqlQuerySessionStatusRequest(
    val querySessionId: String
)

@Serializable
data class SqlQuerySessionStatus(
    val querySessionId: String,
    val totalRows: Long? = null,
    val counting: Boolean = false,
    val exists: Boolean = true
)

@Serializable
data class SqlImportFileRequest(
    val connectionId: String,
    val database: String,
    val filePath: String,
    val fileName: String? = null
)

@Serializable
data class SqlResult(
    val type: String, // query | update | error
    val columns: List<String>? = null,
    val rows: List<Map<String, String?>>? = null,
    val affectedRows: Int? = null,
    val preview: Boolean = false,
    val hasMore: Boolean? = null,
    val querySessionId: String? = null,
    val totalRows: Long? = null,
    val offset: Int? = null,
    val pageSize: Int? = null,
    val loadedRows: Int? = null,
    val truncatedCellCount: Int? = null,
    val duration: Long,
    val sql: String,
    val executedAt: String,
    val error: String? = null
)

// ─── 迁移模型 ─────────────────────────────────────────────
@Serializable
data class MigrationConfig(
    val sourceConnectionId: String,
    val targetConnectionId: String,
    val sourceDatabase: String,
    val targetDatabase: String,
    val tables: List<String>,
    val mode: String = "structure_and_data" // structure_only | data_only | structure_and_data
)

@Serializable
data class MigrationPreview(
    val totalTables: Int,
    val totalRows: Long? = null,
    val tables: List<MigrationTablePreview>,
    val warnings: List<String> = emptyList()
)

@Serializable
data class MigrationTablePreview(
    val tableName: String,
    val rowCount: Long? = null,
    val hasStructure: Boolean = true,
    val hasData: Boolean = true,
    val risk: String? = null
)

// ─── 同步模型 ─────────────────────────────────────────────
@Serializable
data class SyncConfig(
    val sourceConnectionId: String,
    val targetConnectionId: String,
    val sourceDatabase: String,
    val targetDatabase: String,
    val tables: List<String> = emptyList()
)

@Serializable
data class SyncPreview(
    val totalTables: Int,
    val tables: List<SyncTablePreview>,
    val warnings: List<String> = emptyList()
)

@Serializable
data class SyncTablePreview(
    val tableName: String,
    val insertCount: Int = 0,
    val updateCount: Int = 0,
    val skipCount: Int = 0,
    val canSync: Boolean = true,
    val reason: String? = null
)

// ─── 结构对比模型 ──────────────────────────────────────────
@Serializable
data class CompareConfig(
    val sourceConnectionId: String,
    val targetConnectionId: String,
    val sourceDatabase: String,
    val targetDatabase: String,
    val tables: List<String> = emptyList(),
    val options: CompareOptions = CompareOptions()
)

@Serializable
data class CompareOptions(
    val ignoreComment: Boolean = true,
    val ignoreAutoIncrement: Boolean = true,
    val ignoreCharset: Boolean = false,
    val ignoreCollation: Boolean = false,
    val includeDropStatements: Boolean = false
)

@Serializable
data class CompareResult(
    val sourceDatabase: String,
    val targetDatabase: String,
    val totalTables: Int,
    val diffCount: Int,
    val tables: List<TableCompareResult>
)

@Serializable
data class TableCompareResult(
    val tableName: String,
    val status: String,        // only_in_source | only_in_target | different | identical
    val risk: String = "low",  // low | medium | high
    val columnDiffs: List<ColumnDiff> = emptyList(),
    val indexDiffs: List<IndexDiff> = emptyList(),
    val sql: String = "",
    val summary: String = ""
)

@Serializable
data class ColumnDiff(
    val columnName: String,
    val status: String,        // added | removed | modified | identical
    val sourceType: String? = null,
    val targetType: String? = null,
    val sourceNullable: Boolean? = null,
    val targetNullable: Boolean? = null,
    val sourceDefault: String? = null,
    val targetDefault: String? = null,
    val sourceComment: String? = null,
    val targetComment: String? = null,
    val details: String = ""
)

@Serializable
data class IndexDiff(
    val indexName: String,
    val status: String,        // added | removed | modified | identical
    val sourceColumns: List<String>? = null,
    val targetColumns: List<String>? = null,
    val sourceUnique: Boolean? = null,
    val targetUnique: Boolean? = null,
    val details: String = ""
)

// ─── 数据编辑模型 ──────────────────────────────────────────
@Serializable
data class DataEditRequest(
    val connectionId: String,
    val database: String,
    val table: String,
    val changes: List<RowChange>,
    val dryRun: Boolean = false   // true 只生成 SQL 不执行
)

@Serializable
data class RowChange(
    val type: String,          // insert | update | delete
    val primaryKeys: Map<String, String?> = emptyMap(),  // 主键值（update/delete 用）
    val values: Map<String, String?> = emptyMap(),        // 新值（insert/update 用）
    val oldValues: Map<String, String?> = emptyMap()      // 旧值（update 用于冲突检测）
)

@Serializable
data class DataEditResult(
    val success: Boolean,
    val sqlStatements: List<String>,
    val affectedRows: Int = 0,
    val errors: List<String> = emptyList()
)

// ─── 存储过程 / 函数执行模型 ────────────────────────────────

/** 单个参数元数据（来自 INFORMATION_SCHEMA.PARAMETERS 或数据库本地等价物）*/
@Serializable
data class ProcedureParam(
    val name: String,
    val ordinalPosition: Int,
    val mode: String,                       // "IN" | "OUT" | "INOUT" | "RETURNS"
    val dataType: String,                   // "INT" | "VARCHAR" | "DECIMAL" | "DATE" | ...
    val characterMaxLength: Long? = null,
    val numericPrecision: Int? = null,
    val numericScale: Int? = null,
    val dtdIdentifier: String? = null       // 完整类型描述，如 "varchar(255)"
)

/** inspect 接口响应：参数列表 + DDL + comment */
@Serializable
data class ProcedureInspectResult(
    val name: String,
    val type: String,                       // "PROCEDURE" | "FUNCTION"
    val database: String,
    val definer: String? = null,
    val comment: String? = null,
    val params: List<ProcedureParam>,
    val ddl: String? = null
)

/** execute 接口中单个参数的传值 */
@Serializable
data class ProcedureParamValue(
    val name: String,
    val value: String?,                     // null 表示传 NULL
    val mode: String = "IN"                 // "IN" | "INOUT" | "OUT"
)

/** execute 接口请求体 */
@Serializable
data class ProcedureExecuteRequest(
    val connectionId: String,
    val database: String,
    val name: String,
    val type: String = "PROCEDURE",         // "PROCEDURE" | "FUNCTION"
    val params: List<ProcedureParamValue> = emptyList()
)

/** 单个结果集（一次 CALL 可能返回多个） */
@Serializable
data class ProcedureResultSet(
    val index: Int,                         // 第几个结果集，从 0 开始
    val columns: List<String>,
    val rows: List<Map<String, String?>>,
    val rowCount: Int
)

/** execute 接口响应 */
@Serializable
data class ProcedureExecuteResult(
    val success: Boolean,
    val duration: Long,
    val outParams: Map<String, String?> = emptyMap(),   // OUT / INOUT 参数回显
    val resultSets: List<ProcedureResultSet> = emptyList(),
    val warningCount: Int = 0,
    val error: String? = null
)
