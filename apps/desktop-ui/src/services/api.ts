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

/** 自动重连回调（可选）- 通知前端更新连接状态 */
export type ReconnectCallback = (connectionId: string) => void
let reconnectCallback: ReconnectCallback | null = null

export function setReconnectCallback(cb: ReconnectCallback | null) {
  reconnectCallback = cb
}

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
        let errorCode = ''
        try {
          const json = await res.json()
          if (json.error?.message) {
            errorMsg = json.error.message
            errorCode = json.error?.code || ''
          }
        } catch {
          // 无法解析 JSON，使用默认错误消息
        }
        throw new ApiError(errorCode, errorMsg)
      }

      const json = await res.json()
      if (!json.success) {
        throw new ApiError(json.error?.code || '', json.error?.message ?? 'Unknown error')
      }
      return json.data as T
    } catch (e) {
      lastError = e as Error
      // 仅在网络错误（内核未启动）时重试，HTTP 业务错误不重试
      const isNetworkError = lastError instanceof TypeError ||
        lastError.message.includes('Failed to fetch') ||
        lastError.message.includes('NetworkError') ||
        lastError.message.includes('ERR_CONNECTION_REFUSED')

      // 处理 NOT_CONNECTED 错误：自动重连并重试
      if (lastError instanceof ApiError && lastError.code === 'NOT_CONNECTED') {
        const connectionId = extractConnectionId(path)
        if (connectionId && attempt < MAX_RETRIES) {
          try {
            // 尝试重连
            const reconnectRes = await fetch(`${KERNEL_BASE_URL}/api/connection/${connectionId}/open`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            })
            const reconnectJson = await reconnectRes.json()
            if (reconnectJson.success) {
              // 通知前端更新连接状态
              if (reconnectCallback) {
                reconnectCallback(connectionId)
              }
              // 重连成功，重试原请求
              continue
            }
          } catch {
            // 重连失败，抛出原错误
            break
          }
        }
      }

      if (!isNetworkError || attempt === MAX_RETRIES) {
        throw lastError
      }
      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }

  throw lastError!
}

/** 从 API 路径中提取连接 ID */
function extractConnectionId(path: string): string | null {
  // 元数据路径格式: /api/metadata/{connectionId}/...
  // SQL 路径格式: /api/sql/execute (body 中有 connectionId)
  const match = path.match(/\/api\/metadata\/([^\/]+)/)
  return match ? match[1] : null
}

/** 自定义 API 错误类型，携带错误码 */
class ApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
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

// ─── 连接分组 ───────────────────────────────────────────
export const groupApi = {
  list: () => request('/api/groups/list'),
  create: (data: unknown) =>
    request('/api/groups/create', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: unknown) =>
    request(`/api/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) =>
    request(`/api/groups/${id}`, { method: 'DELETE' }),
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
  queryPreview: (config: {
    connectionId: string
    database: string
    sql: string
    offset?: number
    pageSize?: number
    maxCellChars?: number
  }) =>
    request('/api/sql/query-preview', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  importFileStart: (config: { connectionId: string; database: string; filePath: string; fileName?: string }) =>
    request('/api/sql/import-file/start', {
      method: 'POST',
      body: JSON.stringify(config),
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

// ─── 数据库导出 ────────────────────────────────────────────
export const exportApi = {
  estimate: (config: unknown) =>
    request('/api/export/estimate', { method: 'POST', body: JSON.stringify(config) }),
  start: (config: unknown) =>
    request('/api/export/start', { method: 'POST', body: JSON.stringify(config) }),
}

// ─── 数据库备份 (Backup) ──────────────────────────────────
export const backupApi = {
  estimate: (config: unknown) =>
    request('/api/backup/estimate', { method: 'POST', body: JSON.stringify(config) }),
  start: (config: unknown) =>
    request('/api/backup/start', { method: 'POST', body: JSON.stringify(config) }),
  list: () =>
    request('/api/backup/list'),
  downloadUrl: (path: string) => `${KERNEL_BASE_URL}/api/backup/download?path=${encodeURIComponent(path)}`,
}

// ─── 数据库恢复 (Restore) ─────────────────────────────────
export const restoreApi = {
  inspect: (config: { filePath: string }) =>
    request('/api/restore/inspect', { method: 'POST', body: JSON.stringify(config) }),
  start: (config: unknown) =>
    request('/api/restore/start', { method: 'POST', body: JSON.stringify(config) }),
}

// ─── 任务中心 ────────────────────────────────────────────
export const taskApi = {
  list: (status?: string) =>
    request(`/api/task/list${status ? `?status=${status}` : ''}`),
  detail: (taskId: string) =>
    request(`/api/task/${taskId}`, { cache: 'no-store' }),
  logs: (taskId: string) =>
    request(`/api/task/${taskId}/logs`, { cache: 'no-store' }),
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

// ─── 脚本收藏 ────────────────────────────────────────────
export const scriptApi = {
  list: () => request('/api/scripts/list'),
  save: (data: { id?: string; name: string; content: string; database?: string }) =>
    request('/api/scripts/save', { method: 'POST', body: JSON.stringify(data) }),
  delete: (id: string) =>
    request(`/api/scripts/${id}`, { method: 'DELETE' }),
}

// ─── 存储管理 ────────────────────────────────────────────
export const storageApi = {
  info: () => request('/api/storage/info'),
  cleanup: (target: string, mode: string, days?: number) =>
    request('/api/storage/cleanup', {
      method: 'POST',
      body: JSON.stringify({ target, mode, days: days ?? 3 }),
    }),
}
