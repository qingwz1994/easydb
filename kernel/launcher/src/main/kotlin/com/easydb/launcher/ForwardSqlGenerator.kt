/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
package com.easydb.launcher

import com.easydb.common.ChangeEvent
import com.easydb.common.RollbackSqlResult

/**
 * 正向重放 SQL 生成器
 *
 * 根据变更事件正向生成 SQL（与回滚生成器相反）：
 *   INSERT → INSERT（重新插入数据）
 *   DELETE → DELETE（重新删除数据）
 *   UPDATE → UPDATE（应用新值）
 *
 * 多条事件的正向 SQL 按时间正序排列（原始顺序重放）
 */
object ForwardSqlGenerator {

    fun generate(events: List<ChangeEvent>, database: String): RollbackSqlResult {
        val sqlStatements = mutableListOf<String>()
        val affectedTables = mutableSetOf<String>()
        val warnings = mutableListOf<String>()
        var totalRows = 0

        // 按时间正序处理（还原原始操作顺序）
        val sorted = events.sortedBy { it.timestamp }

        for (event in sorted) {
            affectedTables.add(event.table)

            when (event.eventType) {
                "INSERT" -> {
                    // INSERT → INSERT：重新插入原始数据
                    val rows = event.rowsAfter ?: continue
                    for (row in rows) {
                        val columns = row.keys.joinToString(", ") { "`$it`" }
                        val values = row.values.joinToString(", ") { v -> escapeValue(v) }
                        sqlStatements.add(
                            "INSERT INTO `$database`.`${event.table}` ($columns) VALUES ($values);"
                        )
                        totalRows++
                    }
                }

                "DELETE" -> {
                    // DELETE → DELETE：重新删除原始数据
                    val rows = event.rowsBefore ?: continue
                    for (row in rows) {
                        val whereClause = buildWhereClause(row)
                        if (whereClause.isNullOrBlank()) {
                            warnings.add("无法为 DELETE 事件 ${event.id} 生成正向 SQL（无有效列值）")
                            continue
                        }
                        sqlStatements.add(
                            "DELETE FROM `$database`.`${event.table}` WHERE $whereClause LIMIT 1;"
                        )
                        totalRows++
                    }
                }

                "UPDATE" -> {
                    // UPDATE → UPDATE：将旧值更新为新值（正向）
                    val beforeRows = event.rowsBefore ?: continue
                    val afterRows = event.rowsAfter ?: continue
                    for (i in afterRows.indices) {
                        if (i >= beforeRows.size) break
                        val before = beforeRows[i]
                        val after = afterRows[i]

                        // SET 子句：应用新值（只更新变化的列）
                        val changedCols = after.filter { (k, v) -> before[k] != v }
                        if (changedCols.isEmpty()) continue

                        val setClause = changedCols.entries.joinToString(", ") { (k, v) ->
                            "`$k` = ${escapeValue(v)}"
                        }

                        // WHERE 子句：使用旧值（before）定位行
                        val whereClause = buildWhereClause(before)
                        if (whereClause.isNullOrBlank()) {
                            warnings.add("无法为 UPDATE 事件 ${event.id} 生成正向 SQL（无有效条件列）")
                            continue
                        }

                        sqlStatements.add(
                            "UPDATE `$database`.`${event.table}` SET $setClause WHERE $whereClause LIMIT 1;"
                        )
                        totalRows++
                    }
                }
            }
        }

        return RollbackSqlResult(
            sqlStatements = sqlStatements,
            affectedTables = affectedTables.toList(),
            totalRows = totalRows,
            warnings = warnings
        )
    }

    /**
     * 构建 WHERE 子句
     */
    private fun buildWhereClause(row: Map<String, String?>): String? {
        val conditions = mutableListOf<String>()
        for ((col, value) in row) {
            if (value == null) {
                conditions.add("`$col` IS NULL")
            } else {
                conditions.add("`$col` = ${escapeValue(value)}")
            }
        }
        return if (conditions.isEmpty()) null else conditions.joinToString(" AND ")
    }

    /**
     * 转义 SQL 值
     */
    private fun escapeValue(value: String?): String {
        if (value == null) return "NULL"
        if (value.startsWith("0x")) return value
        if (value.toDoubleOrNull() != null) return value
        val escaped = value
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        return "'$escaped'"
    }
}
