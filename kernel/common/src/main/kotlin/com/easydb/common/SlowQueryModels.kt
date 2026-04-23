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

// ─── 能力探测模型 ─────────────────────────────────────────

/**
 * 慢查询分析能力描述。
 * 精细化建模以支持前端按能力降级展示，而非单一 enabled 开关。
 */
@Serializable
data class SlowQueryCapability(
    /** performance_schema 是否开启 */
    val performanceSchemaEnabled: Boolean,
    /** digest 聚合表是否可读 */
    val digestSummaryAvailable: Boolean,
    /** statements_history_long 是否可用 */
    val historyAvailable: Boolean,
    /** EXPLAIN 是否可执行（SELECT 场景） */
    val explainAvailable: Boolean,
    /** EXPLAIN FORMAT=JSON 是否支持 */
    val explainJsonAvailable: Boolean,
    /** 当前已启用的功能列表（供前端展示） */
    val supportedFeatures: List<String>,
    /** 降级或配置提示 */
    val warnings: List<String>
)

// ─── Digest 聚合层 ────────────────────────────────────────

/**
 * 单条 SQL 指纹（Digest）的聚合统计。
 * 来源：performance_schema.events_statements_summary_by_digest
 */
@Serializable
data class SlowQueryDigestItem(
    val digest: String,
    val sqlFingerprint: String,
    val databaseName: String?,
    val execCount: Long,
    val avgLatencyMs: Double,
    val maxLatencyMs: Double,
    val totalLatencyMs: Double,
    val rowsExamined: Long,
    val rowsSent: Long,
    /** SUM_NO_INDEX_USED */
    val noIndexCount: Long,
    /** SUM_NO_GOOD_INDEX_USED */
    val noGoodIndexCount: Long
)

/** Digest 列表分页结果（含汇总统计） */
@Serializable
data class SlowQueryDigestPage(
    val items: List<SlowQueryDigestItem>,
    val total: Int,
    val statistics: SlowQueryStatistics
)

/** 当前统计窗口汇总指标（用于顶部看板卡片） */
@Serializable
data class SlowQueryStatistics(
    val avgLatencyMs: Double,
    val maxLatencyMs: Double,
    val totalExecCount: Long,
    /** 无索引执行占比 [0.0, 1.0] */
    val noIndexRatio: Double
)

// ─── 查询请求模型 ─────────────────────────────────────────

@Serializable
data class SlowQueryQueryRequest(
    val connectionId: String,
    val databaseName: String? = null,
    /** 最小平均耗时（ms），null 表示不限制 */
    val minLatencyMs: Double? = null,
    /** 是否只显示无索引执行的 digest */
    val hasNoIndex: Boolean? = null,
    val searchKeyword: String? = null,
    val sortBy: SlowQuerySortField = SlowQuerySortField.AVG_LATENCY,
    val sortOrder: SortOrder = SortOrder.DESC,
    val page: Int = 1,
    val pageSize: Int = 20
)

@Serializable
enum class SlowQuerySortField {
    AVG_LATENCY,
    MAX_LATENCY,
    TOTAL_LATENCY,
    EXEC_COUNT
}

@Serializable
enum class SortOrder { ASC, DESC }

// ─── Sample 样本层 ────────────────────────────────────────

/**
 * 某 digest 的最近执行样本。
 * 来源：performance_schema.events_statements_history_long
 *
 * 注意：sqlText 可能为 null（权限不足或 P_S 未记录）或被截断。
 */
@Serializable
data class SlowQuerySample(
    val digest: String,
    /** 原始 SQL 文本，可能为 null 或截断 */
    val sqlText: String?,
    val latencyMs: Double,
    val rowsExamined: Long?,
    val rowsSent: Long?,
    /** 事件发生时间（Unix 纳秒，可为 null） */
    val eventTime: Long?,
    /** sqlText 是否存在截断风险 */
    val mayBeTruncated: Boolean = false
)

// ─── Explain / Advice 层 ──────────────────────────────────

@Serializable
enum class ExplainFormat { TEXT, JSON }

@Serializable
data class ExplainRequest(
    val connectionId: String,
    val database: String,
    val sql: String,
    val format: ExplainFormat = ExplainFormat.JSON
)

/**
 * EXPLAIN 执行结果。
 * rawOutput 保留原始输出便于调试；parsedPlan 为结构化解析节点。
 */
@Serializable
data class ExplainResult(
    val format: ExplainFormat,
    /** EXPLAIN 原始输出（文本 / JSON 字符串） */
    val rawOutput: String,
    /** 结构化解析的执行计划节点（JSON 格式可用时填充） */
    val parsedPlan: List<ExplainPlanNode> = emptyList(),
    /** 是否执行成功 */
    val success: Boolean = true,
    val errorMessage: String? = null
)

/** 执行计划节点（对应 EXPLAIN 传统表格中的一行） */
@Serializable
data class ExplainPlanNode(
    val id: Int?,
    val selectType: String?,
    val table: String?,
    val partitions: String?,
    val type: String?,
    val possibleKeys: String?,
    val key: String?,
    val keyLen: String?,
    val ref: String?,
    val rows: Long?,
    val filtered: Double?,
    val extra: String?
)

@Serializable
data class AdviseRequest(
    val connectionId: String,
    val database: String,
    val sql: String,
    val explainResult: ExplainResult? = null
)

/** 规则诊断建议 */
@Serializable
data class Advice(
    /** 严重级别：ERROR / WARN / INFO */
    val level: AdviceLevel,
    /** 规则类别 */
    val category: String,
    /** 建议标题 */
    val title: String,
    /** 触发依据（可回溯，避免黑盒结论） */
    val trigger: String,
    /** 建议方向（不生成强结论式 DDL） */
    val suggestion: String
)

@Serializable
enum class AdviceLevel { ERROR, WARN, INFO }
