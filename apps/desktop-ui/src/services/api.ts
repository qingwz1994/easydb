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
/**
 * IPC 服务层 - 封装与 Kotlin 内核的通信
 * 首版使用 HTTP 通信（内核提供本地 HTTP 服务），后续可替换为 Tauri IPC
 */

const KERNEL_BASE_URL = 'http://localhost:18080'

/** 内核启动中最大重试次数 */
const MAX_RETRIES = 10
const RETRY_DELAY_MS = 2000

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${KERNEL_BASE_URL}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      })

      if (!res.ok) {
        let errorMsg = `HTTP ${res.status}: ${res.statusText}`
        try {
          const json = await res.json()
          if (json.error?.message) {
            errorMsg = json.error.message
          }
        } catch {
          // 无法解析 JSON，使用默认错误消息
        }
        throw new Error(errorMsg)
      }

      const json = await res.json()
      if (!json.success) {
        throw new Error(json.error?.message ?? 'Unknown error')
      }
      return json.data as T
    } catch (e) {
      lastError = e as Error
      // 仅在网络错误（内核未启动）时重试，HTTP 业务错误不重试
      const isNetworkError = lastError instanceof TypeError ||
        lastError.message.includes('Failed to fetch') ||
        lastError.message.includes('NetworkError') ||
        lastError.message.includes('ERR_CONNECTION_REFUSED')

      if (!isNetworkError || attempt === MAX_RETRIES) {
        throw lastError
      }
      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }

  throw lastError!
}

// ─── 连接管理 ───────────────────────────────────────────
export const connectionApi = {
  list: () => request('/api/connection/list'),
  create: (data: unknown) =>
    request('/api/connection/create', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: unknown) =>
    request(`/api/connection/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) =>
    request(`/api/connection/${id}`, { method: 'DELETE' }),
  test: (data: unknown) =>
    request('/api/connection/test', { method: 'POST', body: JSON.stringify(data) }),
  open: (id: string) =>
    request(`/api/connection/${id}/open`, { method: 'POST' }),
  close: (id: string) =>
    request(`/api/connection/${id}/close`, { method: 'POST' }),
}

// ─── 元数据 ─────────────────────────────────────────────
export const metadataApi = {
  databases: (connectionId: string) =>
    request(`/api/metadata/${connectionId}/databases`),
  objects: (connectionId: string, database: string) =>
    request(`/api/metadata/${connectionId}/${database}/objects`),
  tableDefinition: (connectionId: string, database: string, table: string) =>
    request(`/api/metadata/${connectionId}/${database}/tables/${table}/definition`),
  indexes: (connectionId: string, database: string, table: string) =>
    request(`/api/metadata/${connectionId}/${database}/tables/${table}/indexes`),
  previewRows: (connectionId: string, database: string, table: string, params?: { where?: string; orderBy?: string; limit?: number; offset?: number }) =>
    request(`/api/metadata/${connectionId}/${database}/tables/${table}/preview`, {
      method: 'POST',
      body: JSON.stringify(params || {}),
    }),
  ddl: (connectionId: string, database: string, table: string) =>
    request(`/api/metadata/${connectionId}/${database}/tables/${table}/ddl`),
  editData: (connectionId: string, database: string, table: string, changes: unknown[], dryRun = false) =>
    request(`/api/metadata/${connectionId}/${database}/tables/${table}/edit`, {
      method: 'POST',
      body: JSON.stringify({ connectionId, database, table, changes, dryRun }),
    }),
  charsets: (connectionId: string) =>
    request(`/api/metadata/${connectionId}/charsets`),
  createDatabase: (connectionId: string, name: string, charset: string, collation: string) =>
    request(`/api/metadata/${connectionId}/create-database`, {
      method: 'POST',
      body: JSON.stringify({ name, charset, collation }),
    }),
  dropDatabase: (connectionId: string, database: string) =>
    request(`/api/metadata/${connectionId}/drop-database/${database}`, { method: 'DELETE' }),
  previewCreateTable: (connectionId: string, database: string, tableDef: unknown) =>
    request(`/api/metadata/${connectionId}/${database}/preview-create-table`, {
      method: 'POST',
      body: JSON.stringify(tableDef),
    }),
  createTable: (connectionId: string, database: string, tableDef: unknown) =>
    request(`/api/metadata/${connectionId}/${database}/create-table`, {
      method: 'POST',
      body: JSON.stringify(tableDef),
    }),
  dropTable: (connectionId: string, database: string, table: string) =>
    request(`/api/metadata/${connectionId}/${database}/tables/${table}`, { method: 'DELETE' }),
  truncateTable: (connectionId: string, database: string, table: string) =>
    request(`/api/metadata/${connectionId}/${database}/tables/${table}/truncate`, { method: 'POST' }),
  alterDatabase: (connectionId: string, name: string, charset: string, collation: string) =>
    request(`/api/metadata/${connectionId}/alter-database`, {
      method: 'POST',
      body: JSON.stringify({ name, charset, collation }),
    }),
  renameTable: (connectionId: string, database: string, oldName: string, newName: string) =>
    request(`/api/metadata/${connectionId}/${database}/rename-table`, {
      method: 'POST',
      body: JSON.stringify({ oldName, newName }),
    }),
}

// ─── SQL 执行 ────────────────────────────────────────────
export const sqlApi = {
  execute: (connectionId: string, database: string, sql: string) =>
    request('/api/sql/execute', {
      method: 'POST',
      body: JSON.stringify({ connectionId, database, sql }),
    }),
  historyList: (connectionId: string) =>
    request(`/api/sql/history?connectionId=${connectionId}`),
}

// ─── 数据迁移 ────────────────────────────────────────────
export const migrationApi = {
  preview: (config: unknown) =>
    request('/api/migration/preview', { method: 'POST', body: JSON.stringify(config) }),
  validate: (config: unknown) =>
    request('/api/migration/validate', { method: 'POST', body: JSON.stringify(config) }),
  start: (config: unknown) =>
    request('/api/migration/start', { method: 'POST', body: JSON.stringify(config) }),
}

// ─── 数据同步 ────────────────────────────────────────────
export const syncApi = {
  preview: (config: unknown) =>
    request('/api/sync/preview', { method: 'POST', body: JSON.stringify(config) }),
  validate: (config: unknown) =>
    request('/api/sync/validate', { method: 'POST', body: JSON.stringify(config) }),
  start: (config: unknown) =>
    request('/api/sync/start', { method: 'POST', body: JSON.stringify(config) }),
}

// ─── 任务中心 ────────────────────────────────────────────
export const taskApi = {
  list: (status?: string) =>
    request(`/api/task/list${status ? `?status=${status}` : ''}`),
  detail: (taskId: string) =>
    request(`/api/task/${taskId}`),
  logs: (taskId: string) =>
    request(`/api/task/${taskId}/logs`),
  steps: (taskId: string) =>
    request(`/api/task/${taskId}/steps`),
  cancel: (taskId: string) =>
    request(`/api/task/${taskId}/cancel`, { method: 'POST' }),
  delete: (taskId: string) =>
    request(`/api/task/${taskId}`, { method: 'DELETE' }),
  clearCompleted: () =>
    request('/api/task/clear-completed', { method: 'POST' }),
}

// ─── 结构对比 ────────────────────────────────────────────
export const compareApi = {
  execute: (config: unknown) =>
    request('/api/compare/execute', { method: 'POST', body: JSON.stringify(config) }),
}
