package com.easydb.drivers.mysql

import com.easydb.common.*

/**
 * MySQL 专属存储过程/函数适配器。
 * 所有 MySQL 特定的 SQL（INFORMATION_SCHEMA.PARAMETERS、反引号标识符、USE db）
 * 全部集中在这里，执行引擎（ProcedureExecuteService）不感知任何 MySQL 细节。
 *
 * 扩展方式：
 *   PG  → 新建 PgProcedureAdapter，查询 pg_catalog.pg_proc，标识符用双引号
 *   DM  → 新建 DmProcedureAdapter，查询 ALL_ARGUMENTS，语法参考 Oracle
 */
class MysqlProcedureAdapter : ProcedureAdapter {

    // ─── inspect：读取参数元数据 ─────────────────────────────────

    override fun inspect(
        session: DatabaseSession,
        database: String,
        name: String,
        type: String    // "PROCEDURE" | "FUNCTION"
    ): ProcedureInspectResult {
        val conn = session.getJdbcConnection()

        // 1. 参数列表：MySQL 标准系统表 INFORMATION_SCHEMA.PARAMETERS
        //    PG 没有这张表（参数在 pg_proc.proargnames 数组中）
        //    DM 用 ALL_ARGUMENTS（Oracle 兼容）
        val params = mutableListOf<ProcedureParam>()
        conn.prepareStatement("""
            SELECT ORDINAL_POSITION, PARAMETER_NAME, PARAMETER_MODE,
                   DATA_TYPE, CHARACTER_MAXIMUM_LENGTH,
                   NUMERIC_PRECISION, NUMERIC_SCALE, DTD_IDENTIFIER
            FROM INFORMATION_SCHEMA.PARAMETERS
            WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_TYPE = ?
            ORDER BY ORDINAL_POSITION
        """.trimIndent()).use { stmt ->
            stmt.setString(1, database)
            stmt.setString(2, name)
            stmt.setString(3, type)
            stmt.executeQuery().use { rs ->
                while (rs.next()) {
                    params.add(
                        ProcedureParam(
                            ordinalPosition = rs.getInt("ORDINAL_POSITION"),
                            // 函数返回值 PARAMETER_NAME 为 null，显示为 "(return)"
                            name = rs.getString("PARAMETER_NAME") ?: "(return)",
                            // 函数返回值 PARAMETER_MODE 为 null，归一为 RETURNS
                            mode = rs.getString("PARAMETER_MODE") ?: "RETURNS",
                            dataType = rs.getString("DATA_TYPE"),
                            characterMaxLength = rs.getLong("CHARACTER_MAXIMUM_LENGTH").takeIf { !rs.wasNull() },
                            numericPrecision  = rs.getInt("NUMERIC_PRECISION").takeIf { !rs.wasNull() },
                            numericScale      = rs.getInt("NUMERIC_SCALE").takeIf { !rs.wasNull() },
                            dtdIdentifier     = rs.getString("DTD_IDENTIFIER")
                        )
                    )
                }
            }
        }

        // 2. DDL：MySQL 专属 SHOW CREATE 语法
        val ddl = try {
            val cmd = if (type == "PROCEDURE")
                "SHOW CREATE PROCEDURE `$database`.`$name`"
            else
                "SHOW CREATE FUNCTION `$database`.`$name`"
            conn.createStatement().use { stmt ->
                stmt.executeQuery(cmd).use { rs ->
                    // SHOW CREATE PROCEDURE/FUNCTION：列 3 为 DDL 本体（列 2 为 sql_mode）
                    if (rs.next()) rs.getString(3) else null
                }
            }
        } catch (_: Exception) { null }

        // 3. definer / comment
        var definer: String? = null
        var comment: String? = null
        conn.prepareStatement("""
            SELECT DEFINER, ROUTINE_COMMENT
            FROM INFORMATION_SCHEMA.ROUTINES
            WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?
        """.trimIndent()).use { stmt ->
            stmt.setString(1, database)
            stmt.setString(2, name)
            stmt.setString(3, type)
            stmt.executeQuery().use { rs ->
                if (rs.next()) {
                    definer = rs.getString("DEFINER")
                    comment = rs.getString("ROUTINE_COMMENT")?.takeIf { it.isNotBlank() }
                }
            }
        }

        return ProcedureInspectResult(
            name     = name,
            type     = type,
            database = database,
            definer  = definer,
            comment  = comment,
            params   = params,
            ddl      = ddl
        )
    }

    // ─── MySQL 方言 SQL 生成 ──────────────────────────────────────

    /**
     * MySQL CALL 语句：反引号包裹库名和过程名，? 占位符绑定参数。
     * PG 使用双引号；DM 通常不需要引用符。
     */
    override fun buildCallSql(database: String, name: String, paramCount: Int): String {
        val placeholders = (1..paramCount).joinToString(", ") { "?" }
        return "CALL `$database`.`$name`($placeholders)"
    }

    /**
     * MySQL 函数调用：SELECT `db`.`func`(?, ?) AS `result`
     * PG：SELECT "schema"."func"($1, $2) AS result
     * DM：SELECT db.func(?, ?) AS result FROM dual
     */
    override fun buildFunctionCallSql(database: String, name: String, paramCount: Int): String {
        val placeholders = (1..paramCount).joinToString(", ") { "?" }
        return "SELECT `$database`.`$name`($placeholders) AS `result`"
    }

    /**
     * MySQL 切换数据库：USE `db`
     * PG：SET search_path TO "schema"
     * DM：通常无需切换，在连接 URL 中指定；返回空字符串由调用方跳过
     */
    override fun buildSwitchDatabaseSql(database: String): String = "USE `$database`"
}
