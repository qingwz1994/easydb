/**
 * IPC 服务层 - 封装与 Kotlin 内核的通信
 * 首版使用 HTTP 通信（内核提供本地 HTTP 服务），后续可替换为 Tauri IPC
 */

const KERNEL_BASE_URL = 'http://localhost:18080'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
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
  previewRows: (connectionId: string, database: string, table: string) =>
    request(`/api/metadata/${connectionId}/${database}/tables/${table}/preview`),
  ddl: (connectionId: string, database: string, table: string) =>
    request(`/api/metadata/${connectionId}/${database}/tables/${table}/ddl`),
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
}
