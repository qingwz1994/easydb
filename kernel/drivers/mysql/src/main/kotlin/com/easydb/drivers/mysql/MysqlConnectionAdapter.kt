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
            ConnectionTestResult(success = false, message = e.message ?: "连接失败")
        }
    }

    override fun open(config: ConnectionConfig): DatabaseSession {
        val conn = createJdbcConnection(config)
        return MysqlDatabaseSession(
            connectionId = config.id,
            config = config,
            connection = conn
        )
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

