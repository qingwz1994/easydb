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
        }
    }
}