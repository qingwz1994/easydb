package com.easydb.api

import kotlinx.serialization.Serializable

// ─── 元数据查询协议 DTO ────────────────────────────────────

/**
 * 数据库列表响应
 */
@Serializable
data class DatabaseListResponse(
    val databases: List<DatabaseInfoDto>
)

@Serializable
data class DatabaseInfoDto(
    val name: String,
    val charset: String? = null,
    val collation: String? = null
)

/**
 * 对象列表响应（表 + 视图）
 */
@Serializable
data class ObjectListResponse(
    val tables: List<TableInfoDto> = emptyList(),
    val views: List<TableInfoDto> = emptyList()
)

@Serializable
data class TableInfoDto(
    val name: String,
    val schema: String? = null,
    val type: String = "table",
    val rowCount: Long? = null,
    val comment: String? = null,
    val dataLength: Long? = null,
    val indexLength: Long? = null,
    val updateTime: String? = null,
    val engine: String? = null
)

/**
 * 表结构定义响应
 */
@Serializable
data class TableDefinitionResponse(
    val table: TableInfoDto,
    val columns: List<ColumnInfoDto>,
    val indexes: List<IndexInfoDto>,
    val ddl: String? = null
)

@Serializable
data class ColumnInfoDto(
    val name: String,
    val type: String,
    val nullable: Boolean = true,
    val defaultValue: String? = null,
    val isPrimaryKey: Boolean = false,
    val isAutoIncrement: Boolean = false,
    val comment: String? = null
)

@Serializable
data class IndexInfoDto(
    val name: String,
    val columns: List<String>,
    val isUnique: Boolean = false,
    val isPrimary: Boolean = false,
    val type: String = "BTREE"
)

/**
 * 数据预览响应
 */
@Serializable
data class PreviewRowsResponse(
    val columns: List<String>,
    val rows: List<Map<String, String?>>,
    val totalCount: Long? = null
)

/**
 * DDL 响应
 */
@Serializable
data class DdlResponse(
    val ddl: String
)
