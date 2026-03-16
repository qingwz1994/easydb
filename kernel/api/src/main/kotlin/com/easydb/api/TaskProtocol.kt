package com.easydb.api

import kotlinx.serialization.Serializable

// ─── 任务中心协议 DTO ──────────────────────────────────────

/**
 * 任务信息响应
 */
@Serializable
data class TaskInfoResponse(
    val id: String,
    val name: String,
    val type: String,           // migration | sync
    val status: String,         // pending | running | completed | failed | cancelled
    val progress: Int = 0,      // 0-100
    val startedAt: String? = null,
    val completedAt: String? = null,
    val duration: Long? = null,
    val successCount: Int = 0,
    val failureCount: Int = 0,
    val skippedCount: Int = 0,
    val errorMessage: String? = null
)

/**
 * 任务步骤响应
 */
@Serializable
data class TaskStepResponse(
    val id: String,
    val taskId: String,
    val name: String,
    val status: String,         // pending | running | completed | failed
    val startedAt: String? = null,
    val completedAt: String? = null,
    val message: String? = null
)

/**
 * 任务日志响应
 */
@Serializable
data class TaskLogResponse(
    val id: String,
    val taskId: String,
    val level: String,          // info | warn | error
    val message: String,
    val timestamp: String
)

/**
 * 任务进度事件（用于 WebSocket / SSE 推送，首版预留）
 */
@Serializable
data class TaskProgressEvent(
    val taskId: String,
    val progress: Int,
    val status: String,
    val message: String? = null,
    val timestamp: String
)

/**
 * 任务状态变更事件（用于 WebSocket / SSE 推送，首版预留）
 */
@Serializable
data class TaskStatusEvent(
    val taskId: String,
    val previousStatus: String,
    val currentStatus: String,
    val timestamp: String
)

/**
 * 创建任务响应
 */
@Serializable
data class CreateTaskResponse(
    val taskId: String
)
