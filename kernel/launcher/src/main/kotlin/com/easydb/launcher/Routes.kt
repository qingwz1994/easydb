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
package com.easydb.launcher

import io.ktor.server.application.*
import io.ktor.server.routing.*

/**
 * 配置所有 API 路由
 * 将 Handlers.kt 中定义的各路由组注册到 Ktor 路由树
 */
fun Application.configureRoutes() {
    routing {
        route("/api") {
            // 连接管理
            route("/connection") {
                connectionRoutes()
            }

            // 元数据浏览
            route("/metadata") {
                metadataRoutes()
            }

            // SQL 执行
            route("/sql") {
                sqlRoutes()
            }

            // 数据迁移
            route("/migration") {
                migrationRoutes()
            }

            // 数据同步
            route("/sync") {
                syncRoutes()
            }

            // 任务中心
            route("/task") {
                taskRoutes()
            }

            // 结构对比
            route("/compare") {
                compareRoutes()
            }
        }
    }
}