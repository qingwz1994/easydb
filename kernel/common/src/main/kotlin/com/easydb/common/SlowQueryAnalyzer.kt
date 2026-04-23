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

/**
 * 慢查询分析器接口（数据库适配器可选扩展）。
 *
 * 设计原则（v1.1）：
 * 1. 一期聚焦同步查询，不引入任务中心异步化
 * 2. 三层严格分离：Digest / Sample / Explain+Advice
 * 3. 能力探测优先于功能函数调用
 * 4. 不同数据库返回 null 表示暂不支持，避免强制全库实现
 */
interface SlowQueryAnalyzer {

    /**
     * 探测当前数据库实例的慢查询分析能力。
     * 必须首先调用，前端根据结果决定哪些功能可用。
     */
    fun checkCapability(session: DatabaseSession): SlowQueryCapability

    /**
     * 查询 SQL 指纹（Digest）聚合列表，支持排序与筛选分页。
     * 数据来源：performance_schema.events_statements_summary_by_digest
     */
    fun queryDigests(
        session: DatabaseSession,
        request: SlowQueryQueryRequest
    ): SlowQueryDigestPage

    /**
     * 获取某个 Digest 最近执行的样本 SQL。
     * 数据来源：performance_schema.events_statements_history_long
     *
     * 重要：返回的 [SlowQuerySample.sqlText] 可能为 null 或被截断，
     * 调用方不得将 digest_text 当作完整 SQL 直接传入 explain。
     */
    fun getSamples(
        session: DatabaseSession,
        digest: String,
        limit: Int = 20
    ): List<SlowQuerySample>

    /**
     * 对单条完整 SQL 执行 EXPLAIN 分析。
     *
     * 安全约束（实现方必须遵守）：
     * - 拒绝多语句 SQL（含分号拆分后多条）
     * - 去掉末尾分号后执行
     * - DDL/DML 语句允许降级执行 EXPLAIN，但不执行原始语句
     * - 明确报错而不是静默失败
     */
    fun explain(
        session: DatabaseSession,
        database: String,
        sql: String,
        format: ExplainFormat = ExplainFormat.JSON
    ): ExplainResult

    /**
     * 基于 SQL 文本及可选的 EXPLAIN 结果生成规则诊断建议。
     *
     * 建议原则：
     * - 每条建议必须包含触发依据，避免黑盒结论
     * - 一期不生成强结论式索引 DDL
     */
    fun advise(
        session: DatabaseSession,
        sql: String,
        explainResult: ExplainResult?
    ): List<Advice>
}
