package com.easydb.common

import java.sql.Connection
import java.sql.ResultSet
import java.sql.Statement

/**
 * B2: JDBC 大结果集读取策略统一封装
 *
 * 将 MySQL JDBC 的两种流式读取机制抽象为枚举策略，
 * 替代各处散落的 fetchSize 魔法值。每个入口根据场景选择最合适的策略。
 *
 * ## 两种底层机制对比
 * - **STREAMING**: fetchSize = Integer.MIN_VALUE，MySQL Connector/J 专有的单向流式读取。
 *   优点：无需服务端游标，兼容性高。缺点：占用独占连接，期间不能发其他查询。
 * - **CURSOR_FETCH**: fetchSize = N (如 1000)，配合连接参数 useCursorFetch=true。
 *   优点：支持多语句交错。缺点：需要服务端创建临时表，有额外开销。
 *
 * ## 使用方式
 * ```kotlin
 * val stmt = JdbcFetchStrategy.EXPORT_LARGE_TABLE.createStatement(conn)
 * stmt.executeQuery("SELECT * FROM big_table").use { rs -> ... }
 * ```
 */
enum class JdbcFetchStrategy(
    /** 每次从服务器拉取的行数。MIN_VALUE 表示流式。 */
    val fetchSize: Int,
    /** 查询超时（秒）。0 = 无限制。 */
    val queryTimeoutSeconds: Int,
    /** 策略说明 */
    val description: String
) {
    /**
     * SQL 编辑器查询首屏：快速返回少量行
     * 使用游标模式 + 较短超时，确保响应快速且不占用连接
     */
    QUERY_FIRST_PAGE(
        fetchSize = 200,
        queryTimeoutSeconds = 30,
        description = "查询首屏：200 行预览，30s 超时"
    ),

    /**
     * 数据导出（整表扫描）：需要稳定读取大量数据
     * 使用游标模式 + 4小时超时（4h 足以覆盖绝大多数大表）
     */
    EXPORT_LARGE_TABLE(
        fetchSize = 1000,
        queryTimeoutSeconds = 14400,
        description = "导出整表：1000 行游标，4h 超时"
    ),

    /**
     * 数据迁移/同步：大表搬运
     * 使用流式模式以获得最大吞吐量（MIN_VALUE 触发 MySQL Streaming）
     * 需要独占连接，适用于迁移场景的专用连接
     */
    MIGRATION_STREAMING(
        fetchSize = Int.MIN_VALUE,
        queryTimeoutSeconds = 0,
        description = "迁移流式：MIN_VALUE 纯流式，无超时"
    ),

    /**
     * 数据迁移/同步：保守模式（游标拉取）
     * 不独占连接，适用于连接池有限或需要交错查询的场景
     */
    MIGRATION_CURSOR(
        fetchSize = 1000,
        queryTimeoutSeconds = 14400,
        description = "迁移游标：1000 行游标，4h 超时"
    );

    /**
     * 创建配置好读取策略的 Statement
     */
    fun createStatement(conn: Connection): Statement {
        val stmt = conn.createStatement(
            ResultSet.TYPE_FORWARD_ONLY,
            ResultSet.CONCUR_READ_ONLY
        )
        stmt.fetchSize = fetchSize
        if (queryTimeoutSeconds > 0) {
            stmt.queryTimeout = queryTimeoutSeconds
        }
        return stmt
    }
}
