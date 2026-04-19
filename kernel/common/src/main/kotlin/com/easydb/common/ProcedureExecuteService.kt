package com.easydb.common

import java.sql.Types

/**
 * 存储过程/函数通用执行引擎。
 *
 * 本类只包含纯 JDBC 标准代码，不含任何数据库特定 SQL。
 * 数据库相关逻辑（CALL 语句生成、库切换命令、函数调用 SQL）全部委托给 ProcedureAdapter。
 *
 * 因此本类对 MySQL / PostgreSQL / 达梦等所有 ProcedureAdapter 实现均通用，无需修改。
 */
class ProcedureExecuteService {

    fun execute(
        adapter: ProcedureAdapter,
        session: DatabaseSession,
        request: ProcedureExecuteRequest
    ): ProcedureExecuteResult {
        val conn = session.getJdbcConnection()
        val startAt = System.currentTimeMillis()

        return try {
            // 切换数据库（各数据库语法不同，由适配器生成；空字符串跳过）
            val switchSql = adapter.buildSwitchDatabaseSql(request.database)
            if (switchSql.isNotBlank()) {
                conn.createStatement().use { it.execute(switchSql) }
            }

            when (request.type.uppercase()) {
                "FUNCTION" -> executeFunction(adapter, conn, request, startAt)
                else       -> executeProcedure(adapter, conn, request, startAt)
            }
        } catch (e: Exception) {
            ProcedureExecuteResult(
                success  = false,
                duration = System.currentTimeMillis() - startAt,
                error    = e.message ?: "执行失败"
            )
        }
    }

    // ─── 存储过程 ──────────────────────────────────────────────────

    private fun executeProcedure(
        adapter: ProcedureAdapter,
        conn: java.sql.Connection,
        request: ProcedureExecuteRequest,
        startAt: Long
    ): ProcedureExecuteResult {
        val hasOut = request.params.any { it.mode in listOf("OUT", "INOUT") }
        // CALL 语句由适配器生成（MySQL 反引号 / PG 双引号 / DM 无引号）
        val callSql = adapter.buildCallSql(request.database, request.name, request.params.size)

        return if (hasOut) {
            // 有 OUT/INOUT 参数：必须用 CallableStatement（JDBC 规范要求）
            conn.prepareCall(callSql).use { cs ->
                cs.queryTimeout = 60
                for ((idx, param) in request.params.withIndex()) {
                    val pos = idx + 1
                    if (param.mode in listOf("OUT", "INOUT"))
                        cs.registerOutParameter(pos, Types.VARCHAR)
                    if (param.mode in listOf("IN", "INOUT")) {
                        if (param.value == null) cs.setNull(pos, Types.NULL)
                        else cs.setString(pos, param.value)
                    }
                }

                val hasResult = cs.execute()
                val resultSets = collectResultSets(cs, hasResult)

                // 收集 OUT/INOUT 参数值
                val outValues = mutableMapOf<String, String?>()
                for ((idx, param) in request.params.withIndex()) {
                    if (param.mode in listOf("OUT", "INOUT")) {
                        outValues[param.name] = cs.getString(idx + 1)
                    }
                }

                ProcedureExecuteResult(
                    success      = true,
                    duration     = System.currentTimeMillis() - startAt,
                    outParams    = outValues,
                    resultSets   = resultSets,
                    warningCount = cs.warnings?.let { countWarnings(it) } ?: 0
                )
            }
        } else {
            // 纯 IN 参数：PreparedStatement 即可（JDBC 标准，更安全）
            conn.prepareStatement(callSql).use { ps ->
                ps.queryTimeout = 60
                request.params.forEachIndexed { idx, param ->
                    if (param.value == null) ps.setNull(idx + 1, Types.NULL)
                    else ps.setString(idx + 1, param.value)
                }

                val hasResult = ps.execute()
                val resultSets = collectResultSets(ps, hasResult)

                ProcedureExecuteResult(
                    success      = true,
                    duration     = System.currentTimeMillis() - startAt,
                    resultSets   = resultSets,
                    warningCount = ps.warnings?.let { countWarnings(it) } ?: 0
                )
            }
        }
    }

    // ─── 函数 ──────────────────────────────────────────────────────

    private fun executeFunction(
        adapter: ProcedureAdapter,
        conn: java.sql.Connection,
        request: ProcedureExecuteRequest,
        startAt: Long
    ): ProcedureExecuteResult {
        val inParams = request.params.filter { it.mode == "IN" }
        // 函数调用 SQL 由适配器生成（MySQL vs PG vs DM FROM dual 等差异）
        val sql = adapter.buildFunctionCallSql(request.database, request.name, inParams.size)

        conn.prepareStatement(sql).use { ps ->
            ps.queryTimeout = 60
            inParams.forEachIndexed { idx, param ->
                if (param.value == null) ps.setNull(idx + 1, Types.NULL)
                else ps.setString(idx + 1, param.value)
            }

            val hasResult = ps.execute()
            if (!hasResult) {
                return ProcedureExecuteResult(
                    success  = true,
                    duration = System.currentTimeMillis() - startAt
                )
            }
            val resultSet = readResultSet(ps.resultSet, 0)
            return ProcedureExecuteResult(
                success    = true,
                duration   = System.currentTimeMillis() - startAt,
                resultSets = listOf(resultSet)
            )
        }
    }

    // ─── 多结果集收集（纯 JDBC 标准，与数据库无关）─────────────────

    private fun collectResultSets(stmt: java.sql.Statement, firstHasResult: Boolean): List<ProcedureResultSet> {
        val result = mutableListOf<ProcedureResultSet>()
        var hasResult = firstHasResult
        var idx = 0

        while (true) {
            if (hasResult) {
                stmt.resultSet?.use { rs -> result.add(readResultSet(rs, idx++)) }
            }
            // JDBC 多结果集遍历标准终止条件
            if (!stmt.moreResults && stmt.updateCount == -1) break
            hasResult = stmt.moreResults
        }

        return result
    }

    private fun readResultSet(rs: java.sql.ResultSet, index: Int): ProcedureResultSet {
        val meta = rs.metaData
        val columns = (1..meta.columnCount).map { meta.getColumnLabel(it) }
        val rows = mutableListOf<Map<String, String?>>()

        while (rs.next()) {
            rows.add(columns.mapIndexed { i, col -> col to rs.getString(i + 1) }.toMap())
            if (rows.size >= 10_000) break   // 防止超大结果集撑爆内存
        }

        return ProcedureResultSet(index = index, columns = columns, rows = rows, rowCount = rows.size)
    }

    // ─── 工具 ──────────────────────────────────────────────────────

    private fun countWarnings(w: java.sql.SQLWarning): Int {
        var count = 0
        var next: java.sql.SQLWarning? = w
        while (next != null) { count++; next = next.nextWarning }
        return count
    }
}
