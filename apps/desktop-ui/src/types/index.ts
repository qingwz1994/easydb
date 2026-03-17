// 全局类型定义

// 数据库类型
export type DbType = 'mysql' | 'postgresql' | 'oracle' | 'sqlserver' | 'sqlite'

// 连接状态
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

// 任务状态
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

// 任务类型
export type TaskType = 'migration' | 'sync'

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
  type: 'table' | 'view'
  rowCount?: number
  comment?: string
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

// 任务信息
export interface TaskInfo {
  id: string
  name: string
  type: TaskType
  status: TaskStatus
  progress: number
  startedAt?: string
  completedAt?: string
  duration?: number
  successCount?: number
  failureCount?: number
  skippedCount?: number
  errorMessage?: string
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
}

// 结构对比结果
export interface CompareResult {
  sourceDatabase: string
  targetDatabase: string
  totalTables: number
  diffCount: number
  tables: TableCompareResult[]
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
