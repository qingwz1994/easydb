/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
package com.easydb.common

import kotlinx.coroutines.flow.Flow

/**
 * 数据变更追踪器 — 数据库无关的抽象接口
 *
 * MySQL: 通过 Binlog 实现
 * PostgreSQL: 未来通过 Logical Decoding 实现
 */
interface ChangeTracker {

    /**
     * 启动变更追踪会话
     * @return 会话 ID
     */
    fun start(session: DatabaseSession, config: TrackerSessionConfig): String

    /**
     * 停止追踪会话
     */
    fun stop(sessionId: String)

    /**
     * 获取会话状态
     */
    fun status(sessionId: String): TrackerSessionStatus?

    /**
     * 获取历史事件（服务端分页 + 筛选）
     */
    fun getHistory(
        sessionId: String,
        page: Int = 0,
        pageSize: Int = 50,
        filterTable: String? = null,
        filterType: String? = null,
        keyword: String? = null,
        startTime: Long? = null,
        endTime: Long? = null
    ): PagedHistoryResponse

    /**
     * 订阅轻量通知流（用于 SSE 推送计数更新）
     */
    fun subscribe(sessionId: String): Flow<SseTick>

    /**
     * 根据事件 ID 列表生成回滚 SQL
     */
    fun generateRollbackSql(
        sessionId: String,
        eventIds: List<String>,
        session: DatabaseSession,
        database: String
    ): RollbackSqlResult

    /**
     * 根据事件 ID 列表生成正向重放 SQL（还原原始操作）
     */
    fun generateForwardSql(
        sessionId: String,
        eventIds: List<String>,
        session: DatabaseSession,
        database: String
    ): RollbackSqlResult

    /**
     * 检查服务端兼容性（binlog 是否开启、权限等）
     */
    fun checkServerCompatibility(session: DatabaseSession): TrackerServerCheck

    /**
     * 获取所有活跃的追踪会话
     */
    fun getActiveSessions(): List<TrackerSessionStatus>

    /**
     * 列出服务器上可用的 binlog 文件（SHOW BINARY LOGS）
     */
    fun listBinlogFiles(session: DatabaseSession): List<BinlogFileInfo>
}
