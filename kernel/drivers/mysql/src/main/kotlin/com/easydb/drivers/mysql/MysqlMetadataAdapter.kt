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
            SELECT TABLE_NAME, TABLE_SCHEMA, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT
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
                        comment = rs.getString("TABLE_COMMENT")
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

    override fun getTableDefinition(session: DatabaseSession, database: String, table: String): TableDefinition {
        val columns = getColumns(session, database, table)
        val indexes = getIndexes(session, database, table)
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
                        isAutoIncrement = rs.getString("EXTRA").contains("auto_increment", ignoreCase = true),
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

    override fun previewRows(session: DatabaseSession, database: String, table: String, limit: Int): List<Map<String, String?>> {
        val conn = (session as MysqlDatabaseSession).connection
        val result = mutableListOf<Map<String, String?>>()
        conn.createStatement().use { stmt ->
            stmt.executeQuery("SELECT * FROM `$database`.`$table` LIMIT $limit").use { rs ->
                val meta = rs.metaData
                val columnCount = meta.columnCount
                while (rs.next()) {
                    val row = mutableMapOf<String, String?>()
                    for (i in 1..columnCount) {
                        row[meta.getColumnName(i)] = rs.getString(i)
                    }
                    result.add(row)
                }
            }
        }
        return result
    }

    override fun getDdl(session: DatabaseSession, database: String, table: String): String {
        val conn = (session as MysqlDatabaseSession).connection
        conn.createStatement().use { stmt ->
            stmt.executeQuery("SHOW CREATE TABLE `$database`.`$table`").use { rs ->
                if (rs.next()) {
                    return rs.getString(2)
                }
            }
        }
        return ""
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
