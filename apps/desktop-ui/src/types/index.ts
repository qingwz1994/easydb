// 全局类型定义

// 数据库类型
export type DbType = 'mysql' | 'postgresql' | 'oracle' | 'sqlserver' | 'sqlite'

// 连接状态
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

// 任务状态
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

// 任务类型
export type TaskType = 'migration' | 'sync' | 'export' | 'import'

// 迁移模式
export type MigrationMode = 'structure_only' | 'data_only' | 'structure_and_data'

// 连接配置
export interface ConnectionConfig {
  id: string
  name: string
  dbType: DbType
  host: string
  port: number
  username: string
  password: string
  database?: string
  status: ConnectionStatus
  lastUsedAt?: string
  ssh?: SshConfig
  ssl?: SslConfig
  groupId?: string
}

// 连接分组
export interface ConnectionGroup {
  id: string
  name: string
  sortOrder: number
}

// SSH 隧道配置
export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
}

// SSL 配置
export interface SslConfig {
  enabled: boolean
  caPath?: string
  certPath?: string
  keyPath?: string
  rejectUnauthorized?: boolean
}

// 数据库对象
export interface DatabaseInfo {
  name: string
  charset?: string
  collation?: string
}

// 表信息
export interface TableInfo {
  name: string
  schema?: string
  type: 'table' | 'view' | 'trigger' | 'procedure' | 'function'
  rowCount?: number
  comment?: string
  dataLength?: number
  indexLength?: number
  updateTime?: string
  engine?: string
}

// 字段信息
export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue?: string
  isPrimaryKey: boolean
  isAutoIncrement: boolean
  comment?: string
}

// 索引信息
export interface IndexInfo {
  name: string
  columns: string[]
  isUnique: boolean
  isPrimary: boolean
  type: string
}

// SQL 执行结果
export interface SqlResult {
  type: 'query' | 'update' | 'error'
  columns?: string[]
  rows?: Record<string, unknown>[]
  affectedRows?: number
  preview?: boolean
  hasMore?: boolean
  connectionId?: string // 用于加载更多
  database?: string // 用于加载更多
  totalRows?: number
  offset?: number
  pageSize?: number
  loadedRows?: number
  truncatedCellCount?: number
  duration: number
  sql: string
  executedAt: string
  error?: string
}

// SQL 历史记录
export interface SqlHistory {
  id: string
  sql: string
  executedAt: string
  duration: number
  status: 'success' | 'error'
  connectionId: string
}

// 数据验证结果（逐表）
export interface TableVerifyResult {
  tableName: string
  sourceRows: number
  targetRows: number
  status: 'match' | 'mismatch' | 'failed'
  errorMessage?: string
}

// 任务信息
export interface TaskInfo {
  id: string
  name: string
  type: TaskType
  status: TaskStatus
  progress: number
  createdAt?: string
  startedAt?: string
  completedAt?: string
  duration?: number
  successCount?: number
  failureCount?: number
  skippedCount?: number
  errorMessage?: string
  progressMessage?: string
  verification?: TableVerifyResult[]
}

// 任务步骤
export interface TaskStep {
  id: string
  taskId: string
  name: string
  status: TaskStatus
  startedAt?: string
  completedAt?: string
  message?: string
}

// 任务日志
export interface TaskLog {
  id: string
  taskId: string
  level: 'info' | 'warn' | 'error'
  message: string
  timestamp: string
}

// 迁移配置
export interface MigrationConfig {
  sourceConnectionId: string
  targetConnectionId: string
  sourceDatabase: string
  targetDatabase: string
  tables: string[]
  mode: MigrationMode
}

// 迁移预览
export interface MigrationPreview {
  totalTables: number
  totalRows?: number
  tables: MigrationTablePreview[]
  warnings: string[]
}

export interface MigrationTablePreview {
  tableName: string
  rowCount?: number
  hasStructure: boolean
  hasData: boolean
  risk?: string
}

// 同步配置
export interface SyncConfig {
  sourceConnectionId: string
  targetConnectionId: string
  sourceDatabase: string
  targetDatabase: string
  tables: string[]
}

// 同步预览
export interface SyncPreview {
  totalTables: number
  tables: SyncTablePreview[]
  warnings: string[]
}

export interface SyncTablePreview {
  tableName: string
  insertCount: number
  updateCount: number
  skipCount: number
  canSync: boolean
  reason?: string
}

export interface ExportTableEstimate {
  tableName: string
  estimatedRows: number
  estimatedBytes: number
  progressUnits: number
  risk: 'low' | 'medium' | 'high'
}

export interface ExportEstimateResult {
  totalTables: number
  selectedTables: number
  includeData: boolean
  exportContent: 'STRUCTURE_ONLY' | 'DATA_ONLY' | 'STRUCTURE_AND_DATA'
  exportFormat: 'SQL_ZIP' | 'CSV_ZIP'
  estimatedRows: number
  estimatedBytes: number
  largeTableCount: number
  tables: ExportTableEstimate[]
  warnings: string[]
}

// 结构对比配置
export interface CompareConfig {
  sourceConnectionId: string
  targetConnectionId: string
  sourceDatabase: string
  targetDatabase: string
  tables: string[]
  options: CompareOptions
}

export interface CompareOptions {
  ignoreComment: boolean
  ignoreAutoIncrement: boolean
  ignoreCharset: boolean
  ignoreCollation: boolean
  includeDropStatements: boolean
  // 扩展对象开关（默认全开）
  compareViews?: boolean
  compareProcedures?: boolean
  compareFunctions?: boolean
  compareTriggers?: boolean
}

// 结构对比结果
export interface CompareResult {
  sourceDatabase: string
  targetDatabase: string
  totalTables: number
  diffCount: number
  tables: TableCompareResult[]
  // 扩展对象
  views:      ObjectCompareResult[]
  procedures: ObjectCompareResult[]
  functions:  ObjectCompareResult[]
  triggers:   ObjectCompareResult[]
}

/** 非表对象对比结果（视图/存储过程/函数/触发器） */
export interface ObjectCompareResult {
  name: string
  objectType: 'view' | 'procedure' | 'function' | 'trigger'
  status: 'only_in_source' | 'only_in_target' | 'different' | 'identical'
  sourceDdl: string
  targetDdl: string
  summary: string
}

export interface TableCompareResult {
  tableName: string
  status: 'only_in_source' | 'only_in_target' | 'different' | 'identical'
  risk: 'low' | 'medium' | 'high'
  columnDiffs: ColumnDiff[]
  indexDiffs: IndexDiff[]
  sql: string
  summary: string
}

export interface ColumnDiff {
  columnName: string
  status: 'added' | 'removed' | 'modified' | 'identical'
  sourceType?: string
  targetType?: string
  sourceNullable?: boolean
  targetNullable?: boolean
  sourceDefault?: string
  targetDefault?: string
  sourceComment?: string
  targetComment?: string
  details: string
}

export interface IndexDiff {
  indexName: string
  status: 'added' | 'removed' | 'modified' | 'identical'
  sourceColumns?: string[]
  targetColumns?: string[]
  sourceUnique?: boolean
  targetUnique?: boolean
  details: string
}

// IPC 响应包装
export interface IpcResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}

// 数据编辑
export interface RowChange {
  type: 'insert' | 'update' | 'delete'
  primaryKeys: Record<string, string | null>
  values: Record<string, string | null>
  oldValues: Record<string, string | null>
}

export interface DataEditRequest {
  connectionId: string
  database: string
  table: string
  changes: RowChange[]
  dryRun?: boolean
}

export interface DataEditResult {
  success: boolean
  sqlStatements: string[]
  affectedRows: number
  errors: string[]
}

// 脚本收藏夹
export interface SavedScript {
  id: string
  name: string
  content: string
  database?: string
  createdAt: string
  updatedAt: string
}

// ─── 数据追踪（Change Tracker）────────────────────────────

export interface ChangeEvent {
  id: string
  timestamp: number
  database: string
  table: string
  /** INSERT | UPDATE | DELETE | DDL_CREATE_TABLE | DDL_ALTER_TABLE | DDL_DROP_TABLE | DDL_TRUNCATE_TABLE | DDL_RENAME_TABLE | DDL_OTHER */
  eventType: string
  columns: string[]
  rowsBefore?: Record<string, string | null>[]
  rowsAfter?: Record<string, string | null>[]
  rowCount: number
  sourceInfo?: {
    type: string
    file?: string
    position?: number
    serverId?: number
  }
  transactionId?: string
  // DDL 专属字段（DML 事件为 undefined）
  ddlSql?: string
  ddlObjectType?: string
  ddlRisk?: 'low' | 'medium' | 'high' | 'critical'
}

export interface TrackerSessionConfig {
  connectionId: string
  database?: string
  mode?: 'realtime' | 'replay'
  startFile?: string
  startPosition?: number
  endFile?: string
  endPosition?: number
  filterTables?: string[]
  filterTypes?: string[]
  targetTables?: string[]  // 内核级白名单，在 TABLE_MAP 阶段过滤
}

export interface TrackerSessionStatus {
  sessionId: string
  connectionId: string
  status: 'running' | 'stopped' | 'error' | 'checking' | 'completed'
  currentFile?: string
  currentPosition?: number
  eventCount: number
  startedAt?: string
  errorMessage?: string
  database?: string
}

export interface TrackerServerCheck {
  compatible: boolean
  binlogEnabled: boolean
  binlogFormat?: string
  binlogRowImage?: string
  hasReplicationPrivilege: boolean
  currentFile?: string
  currentPosition?: number
  issues: string[]
}

export interface RollbackSqlRequest {
  connectionId: string
  database: string
  eventIds: string[]
}

export interface RollbackSqlResult {
  sqlStatements: string[]
  affectedTables: string[]
  totalRows: number
  warnings: string[]
}

export interface BinlogFileInfo {
  file: string
  size: number
  encrypted?: string
}

export interface PagedHistoryResponse {
  items: ChangeEvent[]
  total: number
  page: number
  pageSize: number
  stats: HistoryStats
}

export interface HistoryStats {
  insertCount: number
  updateCount: number
  deleteCount: number
  ddlCount: number    // DDL 事件计数
  tables: string[]
  timeRange: number[]  // [minTimestamp, maxTimestamp]
}

export interface SseTick {
  type: 'tick' | 'completed' | 'error'
  totalCount: number
  rate: number
  latestId?: string
  message?: string
}

// ─── 查询结果可编辑性分析 ─────────────────────────────

export type EditabilityReason =
  | 'not_query'           // 非 SELECT 查询
  | 'preview_mode'        // 预览模式（数据可能截断）
  | 'missing_context'     // 缺少 connectionId 或 database
  | 'parse_error'         // SQL 解析失败
  | 'multi_table'         // 多表 JOIN
  | 'aggregate'           // 聚合查询
  | 'view'                // 视图查询
  | 'no_primary_key'      // 表无主键
  | 'metadata_error'      // 元数据获取失败

export interface EditabilityStatus {
  editable: boolean
  reason?: EditabilityReason
  tableName?: string
  primaryKeys?: string[]
  columns?: ColumnInfo[]
}

