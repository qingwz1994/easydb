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
 * MySQL 元数据适配器
 * 通过 INFORMATION_SCHEMA 和 SHOW 命令采集数据库元数据
 */
class MysqlMetadataAdapter : MetadataAdapter {

    override fun listDatabases(session: DatabaseSession): List<DatabaseInfo> {
        val conn = (session as MysqlDatabaseSession).connection
        val result = mutableListOf<DatabaseInfo>()
        conn.createStatement().use { stmt ->
            stmt.executeQuery("""
                SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
                FROM INFORMATION_SCHEMA.SCHEMATA
                ORDER BY SCHEMA_NAME
            """.trimIndent()).use { rs ->
                while (rs.next()) {
                    result.add(DatabaseInfo(
                        name = rs.getString("SCHEMA_NAME"),
                        charset = rs.getString("DEFAULT_CHARACTER_SET_NAME"),
                        collation = rs.getString("DEFAULT_COLLATION_NAME")
                    ))
                }
            }
        }
        return result
    }

    override fun listTables(session: DatabaseSession, database: String): List<TableInfo> {
        val conn = (session as MysqlDatabaseSession).connection
        val result = mutableListOf<TableInfo>()
        conn.prepareStatement("""
            SELECT TABLE_NAME, TABLE_SCHEMA, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT,
                   DATA_LENGTH, INDEX_LENGTH, UPDATE_TIME, ENGINE
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME
        """.trimIndent()).use { stmt ->
            stmt.setString(1, database)
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    val tableType = rs.getString("TABLE_TYPE")
                    result.add(TableInfo(
                        name = rs.getString("TABLE_NAME"),
                        schema = rs.getString("TABLE_SCHEMA"),
                        type = if (tableType == "VIEW") "view" else "table",
                        rowCount = rs.getLong("TABLE_ROWS"),
                        comment = rs.getString("TABLE_COMMENT"),
                        dataLength = rs.getLong("DATA_LENGTH"),
                        indexLength = rs.getLong("INDEX_LENGTH"),
                        updateTime = rs.getString("UPDATE_TIME"),
                        engine = rs.getString("ENGINE")
                    ))
                }
            }
        }
        return result
    }

    override fun listTriggers(session: DatabaseSession, database: String): List<TriggerInfo> {
        val conn = (session as MysqlDatabaseSession).connection
        val result = mutableListOf<TriggerInfo>()
        conn.prepareStatement("""
            SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION,
                   ACTION_TIMING, ACTION_STATEMENT
            FROM INFORMATION_SCHEMA.TRIGGERS
            WHERE TRIGGER_SCHEMA = ?
            ORDER BY TRIGGER_NAME
        """.trimIndent()).use { stmt ->
            stmt.setString(1, database)
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    result.add(TriggerInfo(
                        name = rs.getString("TRIGGER_NAME"),
                        table = rs.getString("EVENT_OBJECT_TABLE"),
                        event = rs.getString("EVENT_MANIPULATION"),
                        timing = rs.getString("ACTION_TIMING"),
                        statement = rs.getString("ACTION_STATEMENT")
                    ))
                }
            }
        }
        return result
    }

    override fun listRoutines(session: DatabaseSession, database: String): List<RoutineInfo> {
        val conn = (session as MysqlDatabaseSession).connection
        val result = mutableListOf<RoutineInfo>()
        conn.prepareStatement("""
            SELECT ROUTINE_NAME, ROUTINE_TYPE, DEFINER, CREATED, LAST_ALTERED, ROUTINE_COMMENT
            FROM INFORMATION_SCHEMA.ROUTINES
            WHERE ROUTINE_SCHEMA = ?
            ORDER BY ROUTINE_TYPE, ROUTINE_NAME
        """.trimIndent()).use { stmt ->
            stmt.setString(1, database)
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    result.add(RoutineInfo(
                        name = rs.getString("ROUTINE_NAME"),
                        type = rs.getString("ROUTINE_TYPE"),
                        definer = rs.getString("DEFINER"),
                        created = rs.getString("CREATED"),
                        modified = rs.getString("LAST_ALTERED"),
                        comment = rs.getString("ROUTINE_COMMENT")
                    ))
                }
            }
        }
        return result
    }

    override fun getTableDefinition(session: DatabaseSession, database: String, table: String): TableDefinition {
        val columns = try { getColumns(session, database, table) } catch (_: Exception) { emptyList() }
        val indexes = try { getIndexes(session, database, table) } catch (_: Exception) { emptyList() }
        val ddl = getDdl(session, database, table)
        val tableInfo = TableInfo(name = table, schema = database)
        return TableDefinition(table = tableInfo, columns = columns, indexes = indexes, ddl = ddl)
    }

    private fun getColumns(session: DatabaseSession, database: String, table: String): List<ColumnInfo> {
        val conn = (session as MysqlDatabaseSession).connection
        val result = mutableListOf<ColumnInfo>()
        conn.prepareStatement("""
            SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
                   COLUMN_KEY, EXTRA, COLUMN_COMMENT
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
        """.trimIndent()).use { stmt ->
            stmt.setString(1, database)
            stmt.setString(2, table)
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    result.add(ColumnInfo(
                        name = rs.getString("COLUMN_NAME"),
                        type = rs.getString("COLUMN_TYPE"),
                        nullable = rs.getString("IS_NULLABLE") == "YES",
                        defaultValue = rs.getString("COLUMN_DEFAULT"),
                        isPrimaryKey = rs.getString("COLUMN_KEY") == "PRI",
                        isAutoIncrement = rs.getString("EXTRA")?.contains("auto_increment", ignoreCase = true) ?: false,
                        comment = rs.getString("COLUMN_COMMENT")
                    ))
                }
            }
        }
        return result
    }

    override fun getIndexes(session: DatabaseSession, database: String, table: String): List<IndexInfo> {
        val conn = (session as MysqlDatabaseSession).connection
        val indexMap = mutableMapOf<String, MutableList<String>>()
        val indexMeta = mutableMapOf<String, Pair<Boolean, Boolean>>() // unique, primary

        conn.prepareStatement("""
            SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE
            FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY INDEX_NAME, SEQ_IN_INDEX
        """.trimIndent()).use { stmt ->
            stmt.setString(1, database)
            stmt.setString(2, table)
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    val indexName = rs.getString("INDEX_NAME")
                    val columnName = rs.getString("COLUMN_NAME")
                    val nonUnique = rs.getInt("NON_UNIQUE")

                    indexMap.getOrPut(indexName) { mutableListOf() }.add(columnName)
                    if (indexName !in indexMeta) {
                        indexMeta[indexName] = Pair(nonUnique == 0, indexName == "PRIMARY")
                    }
                }
            }
        }

        return indexMap.map { (name, columns) ->
            val (isUnique, isPrimary) = indexMeta[name] ?: Pair(false, false)
            IndexInfo(name = name, columns = columns, isUnique = isUnique, isPrimary = isPrimary)
        }
    }

    override fun previewRows(session: DatabaseSession, database: String, table: String, limit: Int, where: String?, orderBy: String?, offset: Int): List<Map<String, String?>> {
        val conn = (session as MysqlDatabaseSession).connection
        val result = mutableListOf<Map<String, String?>>()

        // 构建 SQL
        val sql = buildString {
            append("SELECT * FROM `$database`.`$table`")
            if (!where.isNullOrBlank()) {
                // 基本 SQL 注入防护：禁止危险关键字
                val sanitized = where.trim().replace(Regex(";.*$"), "") // 去掉分号后的内容
                val forbidden = listOf("DROP ", "DELETE ", "ALTER ", "TRUNCATE ", "INSERT ", "UPDATE ", "CREATE ", "GRANT ", "REVOKE ")
                val upper = sanitized.uppercase()
                if (forbidden.none { upper.contains(it) }) {
                    append(" WHERE $sanitized")
                }
            }
            if (!orderBy.isNullOrBlank()) {
                // orderBy 格式：columnName ASC 或 columnName DESC
                val sanitized = orderBy.trim().replace(Regex("[;'\"]"), "")
                append(" ORDER BY $sanitized")
            }
            append(" LIMIT $limit")
            if (offset > 0) {
                append(" OFFSET $offset")
            }
        }

        conn.createStatement().use { stmt ->
            stmt.executeQuery(sql).use { rs ->
                val meta = rs.metaData
                val columnCount = meta.columnCount
                while (rs.next()) {
                    val row = mutableMapOf<String, String?>()
                    for (i in 1..columnCount) {
                        val colType = meta.getColumnType(i)
                        // BLOB/BINARY 列用友好占位符替代，避免乱码
                        if (colType in setOf(
                                java.sql.Types.BLOB,
                                java.sql.Types.BINARY,
                                java.sql.Types.VARBINARY,
                                java.sql.Types.LONGVARBINARY
                            )) {
                            val bytes = rs.getBytes(i)
                            row[meta.getColumnName(i)] = if (bytes == null) {
                                null
                            } else {
                                val sizeLabel = when {
                                    bytes.size < 1024 -> "${bytes.size} B"
                                    bytes.size < 1024 * 1024 -> "${bytes.size / 1024} KB"
                                    else -> "${bytes.size / (1024 * 1024)} MB"
                                }
                                "[BLOB $sizeLabel]"
                            }
                        } else {
                            row[meta.getColumnName(i)] = rs.getString(i)
                        }
                    }
                    result.add(row)
                }
            }
        }
        return result
    }

    override fun getDdl(session: DatabaseSession, database: String, table: String): String {
        val conn = (session as MysqlDatabaseSession).connection
        // 依次尝试不同对象类型的 DDL 查询
        val commands = listOf(
            "SHOW CREATE TABLE `$database`.`$table`",
            "SHOW CREATE VIEW `$database`.`$table`",
            "SHOW CREATE PROCEDURE `$database`.`$table`",
            "SHOW CREATE FUNCTION `$database`.`$table`"
        )
        for (cmd in commands) {
            try {
                conn.createStatement().use { stmt ->
                    stmt.executeQuery(cmd).use { rs ->
                        if (rs.next()) {
                            return rs.getString(2)
                        }
                    }
                }
            } catch (_: Exception) {
                // 当前类型不匹配，尝试下一个
            }
        }
        return ""
    }

    /**
     * 根据已知对象类型精确获取 DDL（供迁移/同步使用）
     * @param objectType: table, view, procedure, function, trigger
     * 注意：SHOW CREATE TRIGGER 返回列为 (Trigger, sql_mode, SQL Original Statement, ...)
     */
    fun getObjectDdl(session: DatabaseSession, database: String, name: String, objectType: String): String {
        val conn = (session as MysqlDatabaseSession).connection
        val cmd = when (objectType) {
            "view" -> "SHOW CREATE VIEW `$database`.`$name`"
            "procedure" -> "SHOW CREATE PROCEDURE `$database`.`$name`"
            "function" -> "SHOW CREATE FUNCTION `$database`.`$name`"
            "trigger" -> "SHOW CREATE TRIGGER `$database`.`$name`"
            else -> "SHOW CREATE TABLE `$database`.`$name`"
        }
        // TABLE/VIEW: DDL 在第 2 列
        // PROCEDURE/FUNCTION/TRIGGER: DDL 在第 3 列（第 2 列是 sql_mode）
        val ddlColumnIndex = when (objectType) {
            "procedure", "function", "trigger" -> 3
            else -> 2
        }
        return try {
            conn.createStatement().use { stmt ->
                stmt.executeQuery(cmd).use { rs ->
                    if (rs.next()) rs.getString(ddlColumnIndex) else ""
                }
            }
        } catch (_: Exception) {
            ""
        }
    }

    override fun createDatabase(session: DatabaseSession, name: String, charset: String, collation: String) {
        val conn = (session as MysqlDatabaseSession).connection
        conn.createStatement().use { stmt ->
            stmt.execute("CREATE DATABASE `$name` CHARACTER SET $charset COLLATE $collation")
        }
    }

    override fun dropDatabase(session: DatabaseSession, name: String) {
        val conn = (session as MysqlDatabaseSession).connection
        conn.createStatement().use { stmt ->
            stmt.execute("DROP DATABASE `$name`")
        }
    }

    override fun listCharsets(session: DatabaseSession): List<CharsetInfo> {
        val conn = (session as MysqlDatabaseSession).connection
        val charsetMap = mutableMapOf<String, MutableList<String>>()
        val defaultCollations = mutableMapOf<String, String>()

        // 获取所有 collation 及其对应的 charset
        conn.createStatement().use { stmt ->
            stmt.executeQuery("""
                SELECT CHARACTER_SET_NAME, COLLATION_NAME, IS_DEFAULT
                FROM INFORMATION_SCHEMA.COLLATIONS
                ORDER BY CHARACTER_SET_NAME, COLLATION_NAME
            """.trimIndent()).use { rs ->
                while (rs.next()) {
                    val cs = rs.getString("CHARACTER_SET_NAME")
                    val coll = rs.getString("COLLATION_NAME")
                    val isDefault = rs.getString("IS_DEFAULT") == "Yes"
                    charsetMap.getOrPut(cs) { mutableListOf() }.add(coll)
                    if (isDefault) defaultCollations[cs] = coll
                }
            }
        }

        return charsetMap.map { (cs, colls) ->
            CharsetInfo(
                charset = cs,
                defaultCollation = defaultCollations[cs] ?: colls.first(),
                collations = colls
            )
        }.sortedBy { it.charset }
    }
}
