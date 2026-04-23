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
import java.sql.Connection
import java.sql.DriverManager
import java.util.Properties

/**
 * MySQL 连接适配器
 * 负责创建、测试、关闭 MySQL JDBC 连接
 */
class MysqlConnectionAdapter : ConnectionAdapter {

    override fun testConnection(config: ConnectionConfig): ConnectionTestResult {
        val start = System.currentTimeMillis()
        return try {
            createJdbcConnection(config).use { conn ->
                val valid = conn.isValid(5)
                val latency = System.currentTimeMillis() - start
                if (valid) {
                    ConnectionTestResult(success = true, message = "连接成功", latencyMs = latency)
                } else {
                    ConnectionTestResult(success = false, message = "连接验证失败")
                }
            }
        } catch (e: Exception) {
            ConnectionTestResult(success = false, message = translateJdbcException(e))
        }
    }

    override fun open(config: ConnectionConfig): DatabaseSession {
        return try {
            val conn = createJdbcConnection(config)
            MysqlDatabaseSession(
                connectionId = config.id,
                config = config,
                connection = conn
            )
        } catch (e: Exception) {
            throw RuntimeException(translateJdbcException(e), e)
        }
    }

    override fun close(session: DatabaseSession) {
        session.close()
    }

    companion object {
        /**
         * 创建 JDBC 连接。
         * 自动读取 config.ssl 配置，映射到 MySQL JDBC SSL 参数。
         */
        fun createJdbcConnection(config: ConnectionConfig): Connection {
            Class.forName("com.mysql.cj.jdbc.Driver")

            val props = Properties().apply {
                setProperty("user", config.username)
                setProperty("password", config.password)
                setProperty("connectTimeout", "5000")
                setProperty("socketTimeout", "300000") // 5 分钟，防止防火墙丢包时线程永久挂起
                setProperty("allowPublicKeyRetrieval", "true")
                setProperty("allowMultiQueries", "true")        // 支持多语句执行
                setProperty("serverTimezone", "UTC")
                setProperty("characterEncoding", "UTF-8")
                setProperty("rewriteBatchedStatements", "true") // 批量写入：合并为多值 INSERT
                setProperty("cachePrepStmts", "true")

                // SSL 配置（P0 功能）——读取 config.ssl，替换原硬编码 useSSL=false
                buildSslProps(config.ssl).forEach { k, v ->
                    setProperty(k as String, v as String)
                }
            }

            val db = config.database?.let { "/$it" } ?: ""
            val url = "jdbc:mysql://${config.host}:${config.port}$db"
            return DriverManager.getConnection(url, props)
        }

        /**
         * 构建 SSL Properties。
         *
         * 映射关系：
         *   ssl.enabled=false          → useSSL=false
         *   ssl.enabled=true,
         *     rejectUnauthorized=false → useSSL=true, verifyServerCertificate=false（仅加密）
         *     rejectUnauthorized=true,
         *       caPath                 → useSSL=true, serverSslCert=<caPath>（验证 CA）
         *         certPath+keyPath     → 额外客户端双向认证（clientCertificateKeyStoreUrl）
         */
        fun buildSslProps(ssl: SslConfig?): Properties {
            val p = Properties()
            if (ssl == null || !ssl.enabled) {
                p.setProperty("useSSL", "false")
                return p
            }

            p.setProperty("useSSL", "true")
            p.setProperty("requireSSL", "true")

            if (!ssl.rejectUnauthorized) {
                // 仅加密通道，不验证服务端证书（适合自签名场景）
                p.setProperty("verifyServerCertificate", "false")
            } else {
                // 验证服务端 CA 证书
                p.setProperty("verifyServerCertificate", "true")
                ssl.caPath?.let { ca ->
                    // MySQL JDBC 8.x 支持直接使用 PEM 文件，无需 JKS 转换
                    p.setProperty("serverSslCert", ca)
                }

                // 客户端双向认证（可选：certPath + keyPath 同时存在）
                if (!ssl.certPath.isNullOrBlank() && !ssl.keyPath.isNullOrBlank()) {
                    p.setProperty("clientCertificateKeyStoreUrl", "file:${ssl.certPath}")
                    p.setProperty("clientCertificateKeyStoreType", "PKCS12")
                }
            }
            return p
        }
    }
}

/**
 * 将 JDBC 底层异常翻译为用户友好的中文错误消息。
 *
 * 原始的 JDBC 异常消息（如 "Communications link failure..."）对用户毫无诊断价值，
 * 且通常夹带大量英文堆栈信息。此函数对常见场景进行分类翻译。
 *
 * 规则（按优先级匹配 message，不依赖具体 Exception 类型，避免跨模块类路径依赖）：
 */
fun translateJdbcException(e: Exception): String {
    val msg = e.message ?: e.javaClass.simpleName
    val cause = e.cause?.message ?: ""

    return when {
        // ─── 连接级错误（最常见：MySQL 进程未启动或网络不通）───────
        msg.contains("Communications link failure", ignoreCase = true) ||
        msg.contains("Connection refused", ignoreCase = true) ||
        cause.contains("Connection refused", ignoreCase = true) ->
            buildString {
                append("无法连接到 MySQL 服务器，请检查：\n")
                append("① MySQL 服务是否正在运行\n")
                append("② 主机地址和端口是否正确\n")
                append("③ 防火墙或安全组是否放行该端口")
            }

        // ─── 超时（connectTimeout 触发）─────────────────────────
        msg.contains("Connection timed out", ignoreCase = true) ||
        msg.contains("connect timed out", ignoreCase = true) ->
            "连接超时（5s），请检查网络可达性和 MySQL 端口是否开放"

        // ─── 认证失败 ─────────────────────────────────────────
        msg.contains("Access denied", ignoreCase = true) ->
            "认证失败：用户名或密码错误，或该用户没有从当前主机连接的权限"

        // ─── 未知数据库 ───────────────────────────────────────
        msg.contains("Unknown database", ignoreCase = true) -> {
            val dbMatch = Regex("""Unknown database '(.+?)'""", RegexOption.IGNORE_CASE)
                .find(msg)?.groupValues?.getOrNull(1)
            if (dbMatch != null) "数据库 '$dbMatch' 不存在" else "指定的数据库不存在，请检查数据库名称"
        }

        // ─── SSL / TLS 错误 ───────────────────────────────────
        msg.contains("SSL", ignoreCase = true) || msg.contains("TLS", ignoreCase = true) ||
        cause.contains("SSL", ignoreCase = true) ->
            "SSL/TLS 握手失败，请检查 SSL 配置：证书路径是否正确、服务端是否支持 SSL"

        // ─── 公钥检索被拒绝（RSA 认证）────────────────────────
        msg.contains("Public Key Retrieval", ignoreCase = true) ->
            "服务器拒绝公钥检索，请在连接配置中开启 allowPublicKeyRetrieval，或改用密码认证插件"

        // ─── 驱动类未找到 ─────────────────────────────────────
        msg.contains("ClassNotFoundException", ignoreCase = true) ||
        e is ClassNotFoundException ->
            "MySQL JDBC 驱动未找到，请检查应用打包配置"

        // ─── 连接已关闭（会话失效，需重连）────────────────────
        msg.contains("No operations allowed after connection closed", ignoreCase = true) ||
        msg.contains("connection is closed", ignoreCase = true) ->
            "数据库连接已断开（可能因为服务器 wait_timeout 超时），请重新打开连接"

        // ─── 服务器主动断开 ───────────────────────────────────
        msg.contains("has gone away", ignoreCase = true) ->
            "MySQL 服务器主动断开了连接（server has gone away），请重新打开连接"

        // ─── 兜底：保留原始消息，但去掉 JDBC 内部堆栈噪音 ─────
        else -> {
            // 截取第一行（去掉多行堆栈）
            val firstLine = msg.lines().firstOrNull()?.trim() ?: msg
            // 去掉 "com.mysql.cj.exceptions." 等包名前缀
            firstLine.replace(Regex("""^com\.mysql\.cj\.\w+\.?\w+:\s*"""), "")
                .ifBlank { "数据库连接失败，请检查连接配置" }
        }
    }
}
