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
package com.easydb.common

import kotlinx.serialization.Serializable

// ─── 数据库类型枚举 ────────────────────────────────────────
enum class DbType(val displayName: String) {
    MYSQL("MySQL"),
    POSTGRESQL("PostgreSQL"),
    ORACLE("Oracle"),
    SQLSERVER("SQL Server"),
    SQLITE("SQLite");
}

// ─── 连接配置 ──────────────────────────────────────────────
@Serializable
data class ConnectionConfig(
    val id: String = "",
    val name: String,
    val dbType: String = "mysql",
    val host: String = "127.0.0.1",
    val port: Int = 3306,
    val username: String = "",
    val password: String = "",
    val database: String? = null,
    val status: String = "disconnected",
    val lastUsedAt: String? = null,
    val ssh: SshConfig? = null,
    val ssl: SslConfig? = null,
    val groupId: String? = null
)

// ─── 连接分组 ──────────────────────────────────────────────
@Serializable
data class ConnectionGroup(
    val id: String = "",
    val name: String,
    val sortOrder: Int = 0
)

// ─── SSH 隧道配置 ──────────────────────────────────────────
@Serializable
data class SshConfig(
    val enabled: Boolean = false,
    val host: String = "",
    val port: Int = 22,
    val username: String = "",
    val authType: String = "password", // password | privateKey
    val password: String? = null,
    val privateKeyPath: String? = null
)

// ─── SSL 配置 ──────────────────────────────────────────────
@Serializable
data class SslConfig(
    val enabled: Boolean = false,
    val caPath: String? = null,
    val certPath: String? = null,
    val keyPath: String? = null,
    val rejectUnauthorized: Boolean = true
)

// ─── 任务状态枚举 ──────────────────────────────────────────
enum class TaskStatus {
    PENDING,
    RUNNING,
    COMPLETED,
    FAILED,
    CANCELLED
}

// ─── 任务类型枚举 ──────────────────────────────────────────
enum class TaskType {
    MIGRATION,
    SYNC
}

// ─── 数据库能力声明 ────────────────────────────────────────
data class DatabaseCapabilities(
    val supportsTransactions: Boolean = true,
    val supportsSsh: Boolean = true,
    val supportsSsl: Boolean = true,
    val supportsViews: Boolean = true,
    val supportsStoredProcedures: Boolean = false,
    val supportsTriggers: Boolean = false
)

// ─── 安全辅助 ───────────────────────────────────

/**
 * 返回密码脱敏的副本（用于 API 响应）。
 * 内存中的原始对象保持明文不变。
 */
fun ConnectionConfig.masked(): ConnectionConfig = copy(
    password = if (password.isNotBlank()) "***" else "",
    ssh = ssh?.copy(
        password = if (!ssh.password.isNullOrBlank()) "***" else null
    )
)