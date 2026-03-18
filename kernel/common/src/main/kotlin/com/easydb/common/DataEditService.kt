package com.easydb.common

/**
 * 数据编辑 SQL 生成引擎
 * 将前端提交的行变更（insert/update/delete）转换为可执行的 SQL 语句
 */
class DataEditService {

    /**
     * 根据变更请求生成 SQL 语句列表
     * @param dialect 方言适配器，用于正确引用标识符和转义值
     * @param tableName 目标表名
     * @param changes 变更列表
     * @return 生成的 SQL 语句列表
     */
    fun generateSql(dialect: DialectAdapter, tableName: String, changes: List<RowChange>): List<String> {
        return changes.mapNotNull { change ->
            when (change.type) {
                "insert" -> generateInsertSql(dialect, tableName, change)
                "update" -> generateUpdateSql(dialect, tableName, change)
                "delete" -> generateDeleteSql(dialect, tableName, change)
                else -> null
            }
        }
    }

    /**
     * 生成 INSERT 语句
     */
    private fun generateInsertSql(dialect: DialectAdapter, tableName: String, change: RowChange): String {
        val columns = change.values.keys.toList()
        val values = columns.map { dialect.escapeValue(change.values[it]) }
        val colNames = columns.joinToString(", ") { dialect.quoteIdentifier(it) }
        return "INSERT INTO ${dialect.quoteIdentifier(tableName)} ($colNames) VALUES (${values.joinToString(", ")})"
    }

    /**
     * 生成 UPDATE 语句
     * 使用主键作为 WHERE 条件，只更新有变化的列
     */
    private fun generateUpdateSql(dialect: DialectAdapter, tableName: String, change: RowChange): String? {
        if (change.primaryKeys.isEmpty()) return null

        // 只更新有变化的列（对比 values 和 oldValues）
        val changedCols = change.values.filter { (k, v) ->
            change.oldValues[k] != v
        }
        if (changedCols.isEmpty()) return null

        val setClause = changedCols.entries.joinToString(", ") { (col, value) ->
            "${dialect.quoteIdentifier(col)} = ${dialect.escapeValue(value)}"
        }
        val whereClause = change.primaryKeys.entries.joinToString(" AND ") { (col, value) ->
            "${dialect.quoteIdentifier(col)} = ${dialect.escapeValue(value)}"
        }
        return "UPDATE ${dialect.quoteIdentifier(tableName)} SET $setClause WHERE $whereClause"
    }

    /**
     * 生成 DELETE 语句
     */
    private fun generateDeleteSql(dialect: DialectAdapter, tableName: String, change: RowChange): String? {
        if (change.primaryKeys.isEmpty()) return null

        val whereClause = change.primaryKeys.entries.joinToString(" AND ") { (col, value) ->
            "${dialect.quoteIdentifier(col)} = ${dialect.escapeValue(value)}"
        }
        return "DELETE FROM ${dialect.quoteIdentifier(tableName)} WHERE $whereClause"
    }
}
