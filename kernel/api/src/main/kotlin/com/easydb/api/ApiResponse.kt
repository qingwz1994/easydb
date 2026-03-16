package com.easydb.api

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

/**
 * 统一 API 响应工具
 * 直接序列化为 JSON 字符串，避免 Ktor 泛型序列化器问题
 */
@PublishedApi
internal val json = Json {
    prettyPrint = false
    isLenient = true
    ignoreUnknownKeys = true
    encodeDefaults = true
}

/** 成功响应 */
suspend inline fun <reified T> ApplicationCall.ok(data: T) {
    val dataElement = json.encodeToJsonElement(data)
    val response = buildJsonObject {
        put("success", true)
        put("data", dataElement)
    }
    respondText(response.toString(), ContentType.Application.Json)
}

/** 失败响应 */
suspend fun ApplicationCall.fail(code: String, message: String) {
    val response = buildJsonObject {
        put("success", false)
        putJsonObject("error") {
            put("code", code)
            put("message", message)
        }
    }
    respondText(response.toString(), ContentType.Application.Json)
}
