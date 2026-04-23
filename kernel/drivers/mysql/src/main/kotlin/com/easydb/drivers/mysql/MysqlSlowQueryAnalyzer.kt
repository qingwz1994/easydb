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
package com.easydb.drivers.mysql

import com.easydb.common.*

/**
 * MySQL 慢查询分析器（基于 performance_schema）
 *
 * 数据源：
 * - events_statements_summary_by_digest  → Digest 聚合层
 * - events_statements_history_long       → Sample 样本层
 *
 * 设计原则（v1.1）：
 * - 一期聚焦同步查询，不引入异步任务
 * - 能力探测优先于功能调用
 * - 三层对象严格分离，不混用
 */
class MysqlSlowQueryAnalyzer : SlowQueryAnalyzer {

    // ─── 能力探测 ─────────────────────────────────────────

    override fun checkCapability(session: DatabaseSession): SlowQueryCapability {
        val conn = session.getJdbcConnection()
        val warnings = mutableListOf<String>()
        val features = mutableListOf<String>()

        // 1. 检测 performance_schema 是否开启
        val psEnabled = runCatching {
            conn.createStatement().use { stmt ->
                stmt.executeQuery("SELECT @@performance_schema").use { rs ->
                    rs.next() && rs.getInt(1) == 1
                }
            }
        }.getOrElse {
            warnings.add("无法读取 performance_schema 状态: ${it.message}")
            false
        }

        if (!psEnabled) {
            warnings.add("performance_schema 未开启，请在 MySQL 配置中设置 performance_schema=ON")
            return SlowQueryCapability(
                performanceSchemaEnabled = false,
                digestSummaryAvailable = false,
                historyAvailable = false,
                explainAvailable = false,
                explainJsonAvailable = false,
                supportedFeatures = emptyList(),
                warnings = warnings
            )
        }

        // 2. 检测 digest 聚合表是否可读
        val digestAvailable = runCatching {
            conn.createStatement().use { stmt ->
                stmt.executeQuery(
                    "SELECT COUNT(*) FROM performance_schema.events_statements_summary_by_digest LIMIT 1"
                ).use { rs -> rs.next() }
            }
            true
        }.getOrElse {
            warnings.add("digest 聚合表不可读: ${it.message}")
            false
        }

        if (digestAvailable) features.add("digest_summary")

        // 3. 检测 history_long consumer 是否开启（关键：表可读 ≠ 有数据）
        //    events_statements_history_long 表存在且可 SELECT，但如果 consumer=NO
        //    则永远为空，用户无法获取样本 SQL。
        val historyConsumerEnabled = runCatching {
            conn.createStatement().use { stmt ->
                stmt.executeQuery(
                    "SELECT ENABLED FROM performance_schema.setup_consumers " +
                    "WHERE NAME = 'events_statements_history_long'"
                ).use { rs ->
                    rs.next() && rs.getString("ENABLED").equals("YES", ignoreCase = true)
                }
            }
        }.getOrElse { false }

        val historyAvailable = historyConsumerEnabled

        if (!historyConsumerEnabled) {
            warnings.add(
                "events_statements_history_long consumer 未开启，无法获取样本 SQL。" +
                "请执行：UPDATE performance_schema.setup_consumers " +
                "SET ENABLED='YES' WHERE NAME='events_statements_history_long';"
            )
        }

        if (historyAvailable) features.add("sample_sql")

        // 4. 检测 EXPLAIN 是否可执行
        val explainAvailable = runCatching {
            conn.createStatement().use { stmt ->
                stmt.executeQuery("EXPLAIN SELECT 1").use { it.next() }
            }
            true
        }.getOrElse { false }

        if (explainAvailable) features.add("explain")

        // 5. 检测 EXPLAIN FORMAT=JSON 支持
        val explainJsonAvailable = if (explainAvailable) {
            runCatching {
                conn.createStatement().use { stmt ->
                    stmt.executeQuery("EXPLAIN FORMAT=JSON SELECT 1").use { it.next() }
                }
                true
            }.getOrElse {
                warnings.add("EXPLAIN FORMAT=JSON 不支持，将使用传统表格模式")
                false
            }
        } else false

        if (explainJsonAvailable) features.add("explain_json")

        return SlowQueryCapability(
            performanceSchemaEnabled = true,
            digestSummaryAvailable = digestAvailable,
            historyAvailable = historyAvailable,
            explainAvailable = explainAvailable,
            explainJsonAvailable = explainJsonAvailable,
            supportedFeatures = features,
            warnings = warnings
        )
    }

    // ─── Digest 聚合查询 ──────────────────────────────────

    override fun queryDigests(
        session: DatabaseSession,
        request: SlowQueryQueryRequest
    ): SlowQueryDigestPage {
        val conn = session.getJdbcConnection()

        // 构建 WHERE 子句
        val conditions = mutableListOf<String>()
        val params = mutableListOf<Any?>()

        // 过滤掉系统内部 NULL digest（performance_schema 自身产生）
        conditions.add("DIGEST IS NOT NULL")

        request.databaseName?.takeIf { it.isNotBlank() }?.let {
            conditions.add("SCHEMA_NAME = ?")
            params.add(it)
        }

        request.minLatencyMs?.let {
            // performance_schema 使用皮秒(TIMER_WAIT)，1ms = 1,000,000,000 ps
            conditions.add("AVG_TIMER_WAIT >= ?")
            params.add((it * 1_000_000_000L).toLong())
        }

        request.hasNoIndex?.let { noIndex ->
            if (noIndex) conditions.add("SUM_NO_INDEX_USED > 0")
        }

        request.searchKeyword?.takeIf { it.isNotBlank() }?.let {
            conditions.add("DIGEST_TEXT LIKE ?")
            params.add("%$it%")
        }

        val whereClause = if (conditions.isEmpty()) "" else "WHERE ${conditions.joinToString(" AND ")}"

        // 排序列映射
        val orderColumn = when (request.sortBy) {
            SlowQuerySortField.AVG_LATENCY   -> "AVG_TIMER_WAIT"
            SlowQuerySortField.MAX_LATENCY   -> "MAX_TIMER_WAIT"
            SlowQuerySortField.TOTAL_LATENCY -> "SUM_TIMER_WAIT"
            SlowQuerySortField.EXEC_COUNT    -> "COUNT_STAR"
        }
        val direction = if (request.sortOrder == SortOrder.DESC) "DESC" else "ASC"

        // 查询总数
        val countSql = """
            SELECT COUNT(*)
            FROM performance_schema.events_statements_summary_by_digest
            $whereClause
        """.trimIndent()

        val total = conn.prepareStatement(countSql).use { ps ->
            params.forEachIndexed { i, p -> ps.setObject(i + 1, p) }
            ps.executeQuery().use { rs -> if (rs.next()) rs.getInt(1) else 0 }
        }

        // 查询汇总统计（不分页）
        val statsSql = """
            SELECT
                AVG(AVG_TIMER_WAIT)    AS avg_latency,
                MAX(MAX_TIMER_WAIT)    AS max_latency,
                SUM(COUNT_STAR)        AS total_exec,
                SUM(SUM_NO_INDEX_USED) AS no_index_total
            FROM performance_schema.events_statements_summary_by_digest
            $whereClause
        """.trimIndent()

        val statistics = conn.prepareStatement(statsSql).use { ps ->
            params.forEachIndexed { i, p -> ps.setObject(i + 1, p) }
            ps.executeQuery().use { rs ->
                if (rs.next()) {
                    val totalExec = rs.getLong("total_exec")
                    val noIndexTotal = rs.getLong("no_index_total")
                    SlowQueryStatistics(
                        avgLatencyMs = psToMs(rs.getLong("avg_latency")),
                        maxLatencyMs = psToMs(rs.getLong("max_latency")),
                        totalExecCount = totalExec,
                        noIndexRatio = if (totalExec > 0) noIndexTotal.toDouble() / totalExec else 0.0
                    )
                } else SlowQueryStatistics(0.0, 0.0, 0, 0.0)
            }
        }

        // 分页查询
        val offset = (request.page - 1) * request.pageSize
        val dataSql = """
            SELECT
                DIGEST,
                DIGEST_TEXT,
                SCHEMA_NAME,
                COUNT_STAR,
                AVG_TIMER_WAIT,
                MAX_TIMER_WAIT,
                SUM_TIMER_WAIT,
                SUM_ROWS_EXAMINED,
                SUM_ROWS_SENT,
                SUM_NO_INDEX_USED,
                SUM_NO_GOOD_INDEX_USED
            FROM performance_schema.events_statements_summary_by_digest
            $whereClause
            ORDER BY $orderColumn $direction
            LIMIT ? OFFSET ?
        """.trimIndent()

        val items = conn.prepareStatement(dataSql).use { ps ->
            params.forEachIndexed { i, p -> ps.setObject(i + 1, p) }
            ps.setInt(params.size + 1, request.pageSize)
            ps.setInt(params.size + 2, offset)
            ps.executeQuery().use { rs ->
                val list = mutableListOf<SlowQueryDigestItem>()
                while (rs.next()) {
                    list.add(
                        SlowQueryDigestItem(
                            digest          = rs.getString("DIGEST") ?: "",
                            sqlFingerprint  = rs.getString("DIGEST_TEXT") ?: "",
                            databaseName    = rs.getString("SCHEMA_NAME"),
                            execCount       = rs.getLong("COUNT_STAR"),
                            avgLatencyMs    = psToMs(rs.getLong("AVG_TIMER_WAIT")),
                            maxLatencyMs    = psToMs(rs.getLong("MAX_TIMER_WAIT")),
                            totalLatencyMs  = psToMs(rs.getLong("SUM_TIMER_WAIT")),
                            rowsExamined    = rs.getLong("SUM_ROWS_EXAMINED"),
                            rowsSent        = rs.getLong("SUM_ROWS_SENT"),
                            noIndexCount    = rs.getLong("SUM_NO_INDEX_USED"),
                            noGoodIndexCount = rs.getLong("SUM_NO_GOOD_INDEX_USED")
                        )
                    )
                }
                list
            }
        }

        return SlowQueryDigestPage(items = items, total = total, statistics = statistics)
    }

    // ─── Sample 样本查询 ──────────────────────────────────

    override fun getSamples(
        session: DatabaseSession,
        digest: String,
        limit: Int
    ): List<SlowQuerySample> {
        val conn = session.getJdbcConnection()
        val sql = """
            SELECT
                DIGEST,
                SQL_TEXT,
                TIMER_WAIT,
                ROWS_EXAMINED,
                ROWS_SENT,
                TIMER_START
            FROM performance_schema.events_statements_history_long
            WHERE DIGEST = ?
            ORDER BY TIMER_START DESC
            LIMIT ?
        """.trimIndent()

        return conn.prepareStatement(sql).use { ps ->
            ps.setString(1, digest)
            ps.setInt(2, limit)
            ps.executeQuery().use { rs ->
                val list = mutableListOf<SlowQuerySample>()
                while (rs.next()) {
                    val sqlText = rs.getString("SQL_TEXT")
                    // performance_schema 的 SQL_TEXT 最大 1024 字节，超限会截断
                    val mayTruncate = sqlText != null && sqlText.length >= 1000
                    list.add(
                        SlowQuerySample(
                            digest       = rs.getString("DIGEST") ?: digest,
                            sqlText      = sqlText,
                            latencyMs    = psToMs(rs.getLong("TIMER_WAIT")),
                            rowsExamined = rs.getLong("ROWS_EXAMINED").takeUnless { rs.wasNull() },
                            rowsSent     = rs.getLong("ROWS_SENT").takeUnless { rs.wasNull() },
                            eventTime    = rs.getLong("TIMER_START").takeUnless { rs.wasNull() },
                            mayBeTruncated = mayTruncate
                        )
                    )
                }
                list
            }
        }
    }

    // ─── EXPLAIN 分析 ─────────────────────────────────────

    override fun explain(
        session: DatabaseSession,
        database: String,
        sql: String,
        format: ExplainFormat
    ): ExplainResult {
        // 安全约束：净化 SQL
        val cleanedSql = sanitizeSqlForExplain(sql)
            ?: return ExplainResult(
                format = format,
                rawOutput = "",
                success = false,
                errorMessage = "SQL 包含多条语句或为空，EXPLAIN 拒绝执行"
            )

        val conn = session.getJdbcConnection()

        // 切换目标数据库（仅当 database 非空）
        if (database.isNotBlank()) {
            runCatching {
                conn.createStatement().use { it.execute("USE `$database`") }
            }.onFailure {
                return ExplainResult(
                    format = format,
                    rawOutput = "",
                    success = false,
                    errorMessage = "切换数据库失败: ${it.message}"
                )
            }
        }

        return when (format) {
            ExplainFormat.JSON -> tryExplainJson(conn, cleanedSql)
                ?: tryExplainText(conn, cleanedSql)  // JSON 失败时降级到 TEXT
            ExplainFormat.TEXT -> tryExplainText(conn, cleanedSql)
        }
    }

    private fun tryExplainJson(conn: java.sql.Connection, sql: String): ExplainResult? {
        return runCatching {
            conn.createStatement().use { stmt ->
                stmt.executeQuery("EXPLAIN FORMAT=JSON $sql").use { rs ->
                    if (rs.next()) {
                        val raw = rs.getString(1) ?: ""
                        ExplainResult(
                            format = ExplainFormat.JSON,
                            rawOutput = raw,
                            parsedPlan = emptyList(), // JSON 格式由前端直接渲染 rawOutput
                            success = true
                        )
                    } else null
                }
            }
        }.getOrNull()
    }

    private fun tryExplainText(conn: java.sql.Connection, sql: String): ExplainResult {
        return runCatching {
            conn.createStatement().use { stmt ->
                stmt.executeQuery("EXPLAIN $sql").use { rs ->
                    val nodes = mutableListOf<ExplainPlanNode>()
                    while (rs.next()) {
                        nodes.add(
                            ExplainPlanNode(
                                id           = rs.getObject("id") as? Int,
                                selectType   = safeStr(rs, "select_type"),
                                table        = safeStr(rs, "table"),
                                partitions   = safeStr(rs, "partitions"),
                                type         = safeStr(rs, "type"),
                                possibleKeys = safeStr(rs, "possible_keys"),
                                key          = safeStr(rs, "key"),
                                keyLen       = safeStr(rs, "key_len"),
                                ref          = safeStr(rs, "ref"),
                                rows         = runCatching { rs.getLong("rows") }.getOrNull(),
                                filtered     = runCatching { rs.getDouble("filtered") }.getOrNull(),
                                extra        = safeStr(rs, "Extra")
                            )
                        )
                    }
                    // 将结果也序列化为简单文本便于调试
                    val rawLines = nodes.joinToString("\n") { node ->
                        "id=${node.id} type=${node.type} table=${node.table} key=${node.key} rows=${node.rows} extra=${node.extra}"
                    }
                    ExplainResult(
                        format = ExplainFormat.TEXT,
                        rawOutput = rawLines,
                        parsedPlan = nodes,
                        success = true
                    )
                }
            }
        }.getOrElse { e ->
            ExplainResult(
                format = ExplainFormat.TEXT,
                rawOutput = "",
                success = false,
                errorMessage = e.message ?: "EXPLAIN 执行失败"
            )
        }
    }

    // ─── 规则诊断引擎 ─────────────────────────────────────

    override fun advise(
        session: DatabaseSession,
        sql: String,
        explainResult: ExplainResult?
    ): List<Advice> {
        val advices = mutableListOf<Advice>()
        val normalizedSql = sql.trim().uppercase()

        // 规则 5：SELECT * 检测（基于 SQL 文本，无需 EXPLAIN）
        if (normalizedSql.startsWith("SELECT *") || normalizedSql.contains("SELECT *\n")) {
            advices.add(
                Advice(
                    level = AdviceLevel.WARN,
                    category = "query_design",
                    title = "避免使用 SELECT *",
                    trigger = "SQL 语句以 SELECT * 开头",
                    suggestion = "明确列出需要查询的字段，减少不必要的数据传输和索引覆盖失效"
                )
            )
        }

        // 统一处理：TEXT 格式直接用 parsedPlan，JSON 格式从 rawOutput 解析节点
        val nodes: List<ExplainPlanNode> = when {
            explainResult == null -> emptyList()
            explainResult.format == ExplainFormat.TEXT -> explainResult.parsedPlan
            else -> parseJsonExplainToNodes(explainResult.rawOutput) // JSON 格式
        }

        // 规则 7：关联子查询检测（JSON 专用，TEXT 无法检测）
        if (explainResult?.format == ExplainFormat.JSON && explainResult.success) {
            val raw = explainResult.rawOutput
            // 检测 "dependent": true 且 "cacheable": false 的子查询
            val dependentCount = Regex("\"dependent\"\\s*:\\s*true").findAll(raw).count()
            val notCacheableCount = Regex("\"cacheable\"\\s*:\\s*false").findAll(raw).count()
            if (dependentCount > 0 && notCacheableCount > 0) {
                advices.add(
                    Advice(
                        level = AdviceLevel.ERROR,
                        category = "subquery",
                        title = "关联子查询（N+1 问题）",
                        trigger = "EXPLAIN JSON 中检测到 \"dependent\": true 且 \"cacheable\": false 的子查询（共 $dependentCount 处）",
                        suggestion = "关联子查询每次外层扫描都触发一次内层全表扫描，建议改写为 LEFT JOIN + GROUP BY，或在子查询的 WHERE 列（如 user_id）上添加索引"
                    )
                )
            }
        }

        for (node in nodes) {
            val type = node.type?.uppercase()
            val extra = node.extra?.uppercase() ?: ""
            val rows = node.rows ?: 0

            // 规则 1：全表扫描
            if (type == "ALL" && rows > 1000) {
                advices.add(
                    Advice(
                        level = AdviceLevel.ERROR,
                        category = "index_usage",
                        title = "全表扫描（${node.table}）",
                        trigger = "EXPLAIN type=ALL，预计扫描行数 $rows",
                        suggestion = "考虑在 WHERE/JOIN 条件列上添加索引，或检查现有索引是否被正确使用"
                    )
                )
            }

            // 规则 2：有候选索引但未命中
            if (!node.possibleKeys.isNullOrBlank() && node.key.isNullOrBlank()) {
                advices.add(
                    Advice(
                        level = AdviceLevel.WARN,
                        category = "index_usage",
                        title = "候选索引存在但未被使用（${node.table}）",
                        trigger = "possible_keys=${node.possibleKeys}，key=NULL",
                        suggestion = "MySQL 优化器认为全表扫描代价更低，可考虑强制使用索引（FORCE INDEX）或优化查询条件"
                    )
                )
            }

            // 规则 3：Using temporary
            if (extra.contains("USING TEMPORARY")) {
                advices.add(
                    Advice(
                        level = AdviceLevel.WARN,
                        category = "memory_usage",
                        title = "使用临时表（${node.table}）",
                        trigger = "EXPLAIN Extra 包含 Using temporary",
                        suggestion = "GROUP BY 或 DISTINCT 操作产生了临时表，考虑在分组/排序列上添加索引"
                    )
                )
            }

            // 规则 4：Using filesort
            if (extra.contains("USING FILESORT")) {
                advices.add(
                    Advice(
                        level = AdviceLevel.WARN,
                        category = "sort_performance",
                        title = "文件排序（${node.table}）",
                        trigger = "EXPLAIN Extra 包含 Using filesort",
                        suggestion = "ORDER BY 操作无法利用索引顺序，考虑在排序列上添加合适的索引"
                    )
                )
            }

            // 规则 6：索引选择性差（大 rows + 低 filtered）
            val filtered = node.filtered ?: 100.0
            if (rows > 5000 && filtered < 10.0) {
                advices.add(
                    Advice(
                        level = AdviceLevel.WARN,
                        category = "index_selectivity",
                        title = "索引选择性差（${node.table}）",
                        trigger = "预计扫描行数 $rows，过滤比例 ${filtered}%",
                        suggestion = "当前索引过滤效果较弱，考虑优化 WHERE 条件或选用选择性更高的列建立联合索引"
                    )
                )
            }
        }

        // 如果既无 EXPLAIN 结果也无节点，仅给文本级建议
        if (nodes.isEmpty() && explainResult == null) {
            if (normalizedSql.contains("WHERE") && !normalizedSql.contains("LIMIT")) {
                advices.add(
                    Advice(
                        level = AdviceLevel.INFO,
                        category = "query_design",
                        title = "建议添加 LIMIT 限制",
                        trigger = "SQL 包含 WHERE 条件但未包含 LIMIT",
                        suggestion = "生产环境查询建议加上 LIMIT，避免返回大量数据"
                    )
                )
            }
        }

        return advices
    }

    /**
     * 将 EXPLAIN FORMAT=JSON 的 rawOutput 解析为 ExplainPlanNode 列表
     *
     * 使用正则递归提取 "table": {...} 节点中的关键字段，
     * 不依赖外部 JSON 库（避免引入新依赖），仅对已知字段做安全提取。
     */
    private fun parseJsonExplainToNodes(rawJson: String): List<ExplainPlanNode> {
        val result = mutableListOf<ExplainPlanNode>()

        // 提取所有 "table": { ... } 块
        // 使用简单的深度追踪找到每个 table 对象
        val tableStartPattern = Regex("\"table\"\\s*:\\s*\\{")
        var searchFrom = 0
        while (searchFrom < rawJson.length) {
            val match = tableStartPattern.find(rawJson, searchFrom) ?: break
            val blockStart = match.range.last  // 指向 '{'
            // 找到匹配的 '}'
            var depth = 0
            var blockEnd = blockStart
            for (i in blockStart until rawJson.length) {
                when (rawJson[i]) {
                    '{' -> depth++
                    '}' -> { depth--; if (depth == 0) { blockEnd = i; break } }
                }
            }
            val block = rawJson.substring(blockStart, blockEnd + 1)

            // 从 block 中提取字段
            fun extractStrField(key: String): String? =
                Regex("\"${key}\"\\s*:\\s*\"([^\"]*)\"").find(block)?.groupValues?.get(1)?.takeIf { it.isNotBlank() }

            fun extractNumField(key: String): Long? =
                Regex("\"${key}\"\\s*:\\s*([0-9]+)").find(block)?.groupValues?.get(1)?.toLongOrNull()

            fun extractDoubleField(key: String): Double? =
                Regex("\"${key}\"\\s*:\\s*\"?([0-9.]+)\"?").find(block)?.groupValues?.get(1)?.toDoubleOrNull()

            fun extractArrayField(key: String): String? {
                val arrayMatch = Regex("\"${key}\"\\s*:\\s*\\[([^\\]]*)]").find(block)
                return arrayMatch?.groupValues?.get(1)
                    ?.split(",")
                    ?.map { it.trim().trim('"') }
                    ?.filter { it.isNotBlank() }
                    ?.joinToString(",")
                    ?.takeIf { it.isNotBlank() }
            }

            val tableName    = extractStrField("table_name")
            val accessType   = extractStrField("access_type")
            val rowsExamined = extractNumField("rows_examined_per_scan")
                ?: extractNumField("rows")
            val filtered     = extractDoubleField("filtered")
            val possibleKeys = extractArrayField("possible_keys")
            val keyUsed      = extractStrField("key")

            result.add(
                ExplainPlanNode(
                    id           = null,
                    selectType   = null,
                    table        = tableName,
                    partitions   = null,
                    type         = accessType,
                    possibleKeys = possibleKeys,
                    key          = keyUsed,
                    keyLen       = null,
                    ref          = null,
                    rows         = rowsExamined,
                    filtered     = filtered,
                    extra        = null  // JSON 格式 extra 在 attached_condition 等字段，规则 3/4 通过 SQL 文本补充
                )
            )

            searchFrom = blockEnd + 1
        }

        return result
    }

    // ─── 工具函数 ─────────────────────────────────────────

    /**
     * 皮秒（performance_schema TIMER_WAIT）转毫秒
     * 1 ms = 1,000,000,000 ps（1纳秒=1000皮秒，1毫秒=1000000纳秒=10^12皮秒？不对）
     * 实际：1 ms = 10^9 ns? No: 1ms = 1000us = 1000000ns = 1000000000ps
     * performance_schema 单位是 picoseconds：1 ps = 10^-12 s
     * 1 ms = 10^-3 s = 10^9 ps
     */
    private fun psToMs(ps: Long): Double = ps.toDouble() / 1_000_000_000.0

    /**
     * 净化 SQL 用于 EXPLAIN 执行：
     * - 去除末尾分号
     * - 拒绝多语句（简单分号检测）
     * - 返回 null 表示拒绝执行
     */
    private fun sanitizeSqlForExplain(sql: String): String? {
        val trimmed = sql.trim().trimEnd(';').trim()
        if (trimmed.isBlank()) return null
        // 简单的多语句检测：去掉末尾分号后仍含有 ';'
        if (trimmed.contains(';')) return null
        return trimmed
    }

    private fun safeStr(rs: java.sql.ResultSet, column: String): String? {
        return runCatching { rs.getString(column) }.getOrNull()
    }
}
