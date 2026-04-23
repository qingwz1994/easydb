/**
 * 慢查询分析 API 服务
 *
 * 架构：同步查询风格（参考 trackerApi.ts），一期不引入 SSE / Task Center
 *
 * 对应后端路由：/api/slow-query
 */

const BASE = 'http://localhost:18080/api/slow-query'

// ─── 公共请求工具 ────────────────────────────────────────

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    ...options,
  })
  const text = await res.text()
  if (!res.ok) {
    try {
      const errJson = JSON.parse(text)
      throw new Error(errJson.error?.message || errJson.message || `HTTP ${res.status}`)
    } catch {
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
    }
  }
  if (!text) throw new Error('Empty response from server')
  let json: { success: boolean; data: T; error?: { message: string } }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Invalid JSON response: ${text.substring(0, 200)}`)
  }
  if (json.success === false) {
    throw new Error(json.error?.message || 'Request failed')
  }
  return json.data
}

// ─── 类型定义 ────────────────────────────────────────────

export interface SlowQueryCapability {
  performanceSchemaEnabled: boolean
  digestSummaryAvailable: boolean
  historyAvailable: boolean
  explainAvailable: boolean
  explainJsonAvailable: boolean
  supportedFeatures: string[]
  warnings: string[]
}

export interface SlowQueryDigestItem {
  digest: string
  sqlFingerprint: string
  databaseName: string | null
  execCount: number
  avgLatencyMs: number
  maxLatencyMs: number
  totalLatencyMs: number
  rowsExamined: number
  rowsSent: number
  noIndexCount: number
  noGoodIndexCount: number
}

export interface SlowQueryStatistics {
  avgLatencyMs: number
  maxLatencyMs: number
  totalExecCount: number
  noIndexRatio: number
}

export interface SlowQueryDigestPage {
  items: SlowQueryDigestItem[]
  total: number
  statistics: SlowQueryStatistics
}

export interface SlowQuerySample {
  digest: string
  sqlText: string | null
  latencyMs: number
  rowsExamined: number | null
  rowsSent: number | null
  eventTime: number | null
  mayBeTruncated: boolean
}

export type SlowQuerySortField =
  | 'AVG_LATENCY'
  | 'MAX_LATENCY'
  | 'TOTAL_LATENCY'
  | 'EXEC_COUNT'

export type SortOrder = 'ASC' | 'DESC'

export interface SlowQueryQueryRequest {
  connectionId: string
  databaseName?: string | null
  minLatencyMs?: number | null
  hasNoIndex?: boolean | null
  searchKeyword?: string | null
  sortBy?: SlowQuerySortField
  sortOrder?: SortOrder
  page?: number
  pageSize?: number
}

export type ExplainFormat = 'TEXT' | 'JSON'

export interface ExplainRequest {
  connectionId: string
  database: string
  sql: string
  format?: ExplainFormat
}

export interface ExplainPlanNode {
  id: number | null
  selectType: string | null
  table: string | null
  partitions: string | null
  type: string | null
  possibleKeys: string | null
  key: string | null
  keyLen: string | null
  ref: string | null
  rows: number | null
  filtered: number | null
  extra: string | null
}

export interface ExplainResult {
  format: ExplainFormat
  rawOutput: string
  parsedPlan: ExplainPlanNode[]
  success: boolean
  errorMessage: string | null
}

export type AdviceLevel = 'ERROR' | 'WARN' | 'INFO'

export interface Advice {
  level: AdviceLevel
  category: string
  title: string
  trigger: string
  suggestion: string
}

export interface AdviseRequest {
  connectionId: string
  database: string
  sql: string
  explainResult?: ExplainResult | null
}

// ─── API 方法 ────────────────────────────────────────────

export const slowQueryApi = {
  /**
   * 获取慢查询分析能力状态
   * 前端根据返回值决定哪些功能可用（能力驱动降级）
   */
  getStatus: (connectionId: string) =>
    request<SlowQueryCapability>(`/status?connectionId=${encodeURIComponent(connectionId)}`),

  /**
   * 查询 Digest 聚合列表（分页 + 排序 + 筛选）
   */
  queryDigests: (req: SlowQueryQueryRequest) =>
    request<SlowQueryDigestPage>('/digests/query', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  /**
   * 获取某个 Digest 的最近执行样本 SQL
   * 注意：返回的 sqlText 可能为 null 或被截断
   */
  getSamples: (connectionId: string, digest: string, limit = 20) =>
    request<SlowQuerySample[]>(
      `/digests/${encodeURIComponent(digest)}/samples?connectionId=${encodeURIComponent(connectionId)}&limit=${limit}`
    ),

  /**
   * 对单条 SQL 执行 EXPLAIN 分析
   * 后端会尝试 JSON 格式，不支持时自动降级到文本格式
   */
  explain: (req: ExplainRequest) =>
    request<ExplainResult>('/explain', {
      method: 'POST',
      body: JSON.stringify(req),
    }),

  /**
   * 基于 SQL 文本及可选 EXPLAIN 结果生成规则诊断建议
   */
  advise: (req: AdviseRequest) =>
    request<Advice[]>('/advise', {
      method: 'POST',
      body: JSON.stringify(req),
    }),
}
