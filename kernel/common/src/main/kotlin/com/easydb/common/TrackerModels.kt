/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
package com.easydb.common

import kotlinx.serialization.Serializable

// ─── 数据追踪模型（数据库无关设计） ──────────────────────────

/**
 * 变更事件 — 统一的行级变更记录
 * MySQL: 从 Binlog ROW 事件解析
 * PG: 未来从 Logical Decoding 解析
 */
@Serializable
data class ChangeEvent(
    val id: String,                                    // UUID
    val timestamp: Long,                               // 事件时间戳（毫秒）
    val database: String,                              // 数据库名
    val table: String,                                 // 表名（DDL 主对象名，无法解析时为空字符串）
    val eventType: String,                             // INSERT | UPDATE | DELETE | DDL_*
    val columns: List<String> = emptyList(),            // 列名列表
    val rowsBefore: List<Map<String, String?>>? = null, // UPDATE/DELETE 的旧值
    val rowsAfter: List<Map<String, String?>>? = null,  // INSERT/UPDATE 的新值
    val rowCount: Int = 0,                             // 影响行数
    val sourceInfo: ChangeEventSource? = null,          // 来源信息（binlog 位点等）
    val transactionId: String? = null,                 // 事务 ID（来自 XID 事件，用于事务分组）
    // DDL 专属字段（DML 事件中均为 null）
    val ddlSql: String? = null,                        // 原始 DDL 语句
    val ddlObjectType: String? = null,                 // TABLE（v1 仅支持表级）
    val ddlRisk: String? = null                        // low | medium | high | critical
)

@Serializable
data class ChangeEventSource(
    val type: String = "mysql_binlog",                 // mysql_binlog | pg_logical
    val file: String? = null,                          // binlog 文件名
    val position: Long? = null,                        // binlog position
    val serverId: Long? = null                         // server-id
)

/**
 * 追踪会话配置
 */
@Serializable
data class TrackerSessionConfig(
    val connectionId: String,                          // 连接 ID
    val database: String? = null,                      // 可选，只追踪指定库
    val mode: String = "realtime",                      // "realtime" 实时追踪 | "replay" 历史回放
    val startFile: String? = null,                     // 从指定 binlog 文件开始（为 null 则从当前位置）
    val startPosition: Long? = null,                   // 起始位置
    val endFile: String? = null,                       // replay 模式：截止 binlog 文件（null=到当前末尾）
    val endPosition: Long? = null,                     // replay 模式：截止位置
    val filterTables: List<String> = emptyList(),       // 空=全部表（后处理筛选，已解析后再过滤）
    val filterTypes: List<String> = emptyList(),        // 空=全部类型 (INSERT/UPDATE/DELETE)
    val targetTables: List<String> = emptyList()        // 内核级表白名单：在 TABLE_MAP 阶段即拦截，空=不限制
)

/**
 * 追踪会话状态
 */
@Serializable
data class TrackerSessionStatus(
    val sessionId: String,
    val connectionId: String,
    val status: String,                                // running | stopped | error | checking
    val currentFile: String? = null,
    val currentPosition: Long? = null,
    val eventCount: Long = 0,
    val startedAt: String? = null,
    val errorMessage: String? = null,
    val database: String? = null
)

/**
 * 回滚 SQL 请求
 */
@Serializable
data class RollbackSqlRequest(
    val connectionId: String,
    val database: String,
    val eventIds: List<String>                          // 选中的事件 ID
)

/**
 * 回滚 SQL 结果
 */
@Serializable
data class RollbackSqlResult(
    val sqlStatements: List<String>,
    val affectedTables: List<String>,
    val totalRows: Int,
    val warnings: List<String> = emptyList()
)

/**
 * 数据恢复请求
 */
@Serializable
data class DataRecoveryRequest(
    val connectionId: String,
    val database: String,
    val table: String,
    val startTime: String,                             // ISO 8601
    val endTime: String,
    val dryRun: Boolean = true                         // true=只预览，false=执行
)

/**
 * 数据恢复结果
 */
@Serializable
data class DataRecoveryResult(
    val success: Boolean,
    val recoveredRows: Int = 0,
    val sqlStatements: List<String> = emptyList(),
    val preview: List<Map<String, String?>> = emptyList(), // dryRun 时的预览数据
    val errorMessage: String? = null
)

/**
 * 服务端兼容性检查结果
 */
@Serializable
data class TrackerServerCheck(
    val compatible: Boolean,
    val binlogEnabled: Boolean = false,
    val binlogFormat: String? = null,                  // ROW | STATEMENT | MIXED
    val binlogRowImage: String? = null,                // FULL | MINIMAL | NOBLOB
    val hasReplicationPrivilege: Boolean = false,
    val currentFile: String? = null,
    val currentPosition: Long? = null,
    val issues: List<String> = emptyList()
)

/**
 * Binlog 文件信息
 */
@Serializable
data class BinlogFileInfo(
    val file: String,
    val size: Long,
    val encrypted: String? = null
)

/**
 * 分页历史响应 — 服务端分页，前端只拿一页
 */
@Serializable
data class PagedHistoryResponse(
    val items: List<ChangeEvent>,
    val total: Long,                                   // 满足筛选条件的总条数
    val page: Int,
    val pageSize: Int,
    val stats: HistoryStats
)

/**
 * 事件统计汇总（随分页响应一起返回）
 */
@Serializable
data class HistoryStats(
    val insertCount: Long = 0,
    val updateCount: Long = 0,
    val deleteCount: Long = 0,
    val ddlCount: Long = 0,                              // DDL 事件计数
    val tables: List<String> = emptyList(),             // 所有涉及的表名（去重）
    val timeRange: List<Long> = emptyList()             // [minTimestamp, maxTimestamp]
)

/**
 * SSE 轻量通知 — 每秒推一次，仅包含计数信息
 */
@Serializable
data class SseTick(
    val type: String = "tick",                          // "tick" | "completed" | "error"
    val totalCount: Long = 0,                           // 已接收的事件总数
    val rate: Long = 0,                                 // 当前每秒接收速率
    val latestId: String? = null,                       // 最新事件 ID
    val message: String? = null                         // completed/error 时的附加消息
)
