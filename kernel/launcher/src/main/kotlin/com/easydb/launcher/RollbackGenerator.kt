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
 * 回滚 SQL 生成器
 *
 * 根据变更事件反向生成 SQL：
 *   INSERT → DELETE（按主键或全列条件）
 *   DELETE → INSERT（恢复数据）
 *   UPDATE → UPDATE（恢复旧值）
 *
 * 多条事件的回滚 SQL 按时间倒序排列
 */
object RollbackGenerator {

    fun generate(events: List<ChangeEvent>, database: String): RollbackSqlResult {
        val sqlStatements = mutableListOf<String>()
        val affectedTables = mutableSetOf<String>()
        val warnings = mutableListOf<String>()
        var totalRows = 0

        // 按时间倒序处理（最新的先回滚）
        val sorted = events.sortedByDescending { it.timestamp }

        for (event in sorted) {
            affectedTables.add(event.table)

            when (event.eventType) {
                "INSERT" -> {
                    // INSERT → DELETE：根据插入的数据生成 DELETE
                    val rows = event.rowsAfter ?: continue
                    for (row in rows) {
                        val whereClause = buildWhereClause(row)
                        if (whereClause.isNullOrBlank()) {
                            warnings.add("无法为 INSERT 事件 ${event.id} 生成 DELETE（无有效列值）")
                            continue
                        }
                        sqlStatements.add(
                            "DELETE FROM `$database`.`${event.table}` WHERE $whereClause LIMIT 1;"
                        )
                        totalRows++
                    }
                }

                "DELETE" -> {
                    // DELETE → INSERT：将删除的数据重新插入
                    val rows = event.rowsBefore ?: continue
                    for (row in rows) {
                        val columns = row.keys.joinToString(", ") { "`$it`" }
                        val values = row.values.joinToString(", ") { v -> escapeValue(v) }
                        sqlStatements.add(
                            "INSERT INTO `$database`.`${event.table}` ($columns) VALUES ($values);"
                        )
                        totalRows++
                    }
                }

                "UPDATE" -> {
                    // UPDATE → UPDATE：将新值恢复为旧值
                    val beforeRows = event.rowsBefore ?: continue
                    val afterRows = event.rowsAfter ?: continue
                    for (i in beforeRows.indices) {
                        if (i >= afterRows.size) break
                        val before = beforeRows[i]
                        val after = afterRows[i]

                        // SET 子句：恢复为旧值（只修改变化的列）
                        val changedCols = before.filter { (k, v) -> after[k] != v }
                        if (changedCols.isEmpty()) continue

                        val setClause = changedCols.entries.joinToString(", ") { (k, v) ->
                            "`$k` = ${escapeValue(v)}"
                        }

                        // WHERE 子句：使用当前值（after）定位行
                        val whereClause = buildWhereClause(after)
                        if (whereClause.isNullOrBlank()) {
                            warnings.add("无法为 UPDATE 事件 ${event.id} 生成回滚（无有效条件列）")
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
     * 优先使用非 NULL 列，所有列参与定位
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
        // 十六进制数据直接使用
        if (value.startsWith("0x")) return value
        // 数字类型不加引号
        if (value.toDoubleOrNull() != null) return value
        // 字符串转义
        val escaped = value
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        return "'$escaped'"
    }
}
