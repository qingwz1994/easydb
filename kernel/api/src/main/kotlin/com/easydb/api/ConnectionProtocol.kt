package com.easydb.api

import kotlinx.serialization.Serializable

// ─── 连接管理协议 DTO ──────────────────────────────────────

/**
 * 创建连接请求
 */
@Serializable
data class CreateConnectionRequest(
    val name: String,
    val dbType: String = "mysql",
    val host: String = "127.0.0.1",
    val port: Int = 3306,
    val username: String = "",
    val password: String = "",
    val database: String? = null,
    val ssh: SshConfigDto? = null,
    val ssl: SslConfigDto? = null
)

/**
 * 更新连接请求
 */
@Serializable
data class UpdateConnectionRequest(
    val name: String,
    val dbType: String = "mysql",
    val host: String = "127.0.0.1",
    val port: Int = 3306,
    val username: String = "",
    val password: String = "",
    val database: String? = null,
    val ssh: SshConfigDto? = null,
    val ssl: SslConfigDto? = null
)

/**
 * 测试连接请求
 */
@Serializable
data class TestConnectionRequest(
    val dbType: String = "mysql",
    val host: String,
    val port: Int,
    val username: String,
    val password: String,
    val database: String? = null,
    val ssh: SshConfigDto? = null,
    val ssl: SslConfigDto? = null
)

/**
 * 测试连接响应
 */
@Serializable
data class TestConnectionResponse(
    val connected: Boolean,
    val message: String,
    val latencyMs: Long? = null
)

/**
 * 连接信息响应
 */
@Serializable
data class ConnectionInfoResponse(
    val id: String,
    val name: String,
    val dbType: String,
    val host: String,
    val port: Int,
    val username: String,
    val database: String? = null,
    val status: String = "disconnected",
    val lastUsedAt: String? = null
)

// ─── SSH / SSL DTO ─────────────────────────────────────────

@Serializable
data class SshConfigDto(
    val enabled: Boolean = false,
    val host: String = "",
    val port: Int = 22,
    val username: String = "",
    val authType: String = "password",
    val password: String? = null,
    val privateKeyPath: String? = null
)

@Serializable
data class SslConfigDto(
    val enabled: Boolean = false,
    val caPath: String? = null,
    val certPath: String? = null,
    val keyPath: String? = null,
    val rejectUnauthorized: Boolean = true
)
