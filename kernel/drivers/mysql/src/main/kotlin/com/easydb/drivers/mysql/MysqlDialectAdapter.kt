package com.easydb.drivers.mysql

import com.easydb.common.*

/**
 * MySQL 方言适配器
 * 处理 MySQL 特定的 SQL 生成和标识符引用
 */
class MysqlDialectAdapter : DialectAdapter {

    override fun quoteIdentifier(name: String): String {
        return "`${name.replace("`", "``")}`"
    }

    override fun buildCreateTable(table: TableDefinition): String {
        val sb = StringBuilder()
        sb.appendLine("CREATE TABLE ${quoteIdentifier(table.table.name)} (")

        val lines = mutableListOf<String>()

        // 字段定义
        for (col in table.columns) {
            val line = buildString {
                append("  ${quoteIdentifier(col.name)} ${col.type}")
                if (!col.nullable) append(" NOT NULL")
                if (col.defaultValue != null) append(" DEFAULT '${col.defaultValue}'")
                if (col.isAutoIncrement) append(" AUTO_INCREMENT")
                if (!col.comment.isNullOrBlank()) append(" COMMENT '${col.comment}'")
            }
            lines.add(line)
        }

        // 主键
        val pkColumns = table.columns.filter { it.isPrimaryKey }
        if (pkColumns.isNotEmpty()) {
            val pkCols = pkColumns.joinToString(", ") { quoteIdentifier(it.name) }
            lines.add("  PRIMARY KEY ($pkCols)")
        }

        // 索引
        for (idx in table.indexes) {
            if (idx.isPrimary) continue
            val idxCols = idx.columns.joinToString(", ") { quoteIdentifier(it) }
            val prefix = if (idx.isUnique) "UNIQUE KEY" else "KEY"
            lines.add("  $prefix ${quoteIdentifier(idx.name)} ($idxCols)")
        }

        sb.append(lines.joinToString(",\n"))
        sb.appendLine()
        sb.append(") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")

        return sb.toString()
    }

    override fun buildInsert(tableName: String, columns: List<String>): String {
        val cols = columns.joinToString(", ") { quoteIdentifier(it) }
        val placeholders = columns.joinToString(", ") { "?" }
        return "INSERT INTO ${quoteIdentifier(tableName)} ($cols) VALUES ($placeholders)"
    }
}
