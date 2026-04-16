import type { SqlResult } from '@/types'

export const DEFAULT_SQL_PREVIEW_PAGE_SIZE = 200
export const MAX_SQL_PREVIEW_CELL_CHARS = 4096
export const TRUNCATED_SQL_CELL_SUFFIX = ' …[truncated]'
const DEFAULT_SQL_CELL_DISPLAY_CHARS = 160

export function normalizeExecutableSql(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '').trim()
}

export function isPreviewableSql(sql: string): boolean {
  const normalized = normalizeExecutableSql(sql)
  if (!normalized) return false
  if (normalized.includes(';')) return false

  // 必须以 SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/WITH 开头
  if (!/^(select|show|desc|describe|explain|with)\b/i.test(normalized)) return false

  // 聚合函数查询（COUNT/SUM/AVG/MAX/MIN）通常只返回一行，不需要分页
  // 例如：SELECT COUNT(*) FROM table, SELECT MAX(id) FROM table
  if(/\b(COUNT|SUM|AVG|MAX|MIN)\s*\([^)]*\)/i.test(normalized)) {
    // 但如果有 GROUP BY，可能返回多行，需要分页
    if (!/\bGROUP\s+BY\b/i.test(normalized)) {
      return false
    }
  }

  // 没有 FROM 子句的 SELECT（如 SELECT 1, SELECT NOW()）只返回一行
  if (/^select\b/i.test(normalized) && !/\bFROM\b/i.test(normalized)) {
    return false
  }

  // 已经包含 LIMIT 的查询，用户已自行控制行数，不需要再包装
  if(/\bLIMIT\b/i.test(normalized)) {
    return false
  }

  return true
}

export function formatSqlCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  return String(value)
}

export function isSqlCellTruncated(value: string): boolean {
  return value.endsWith(TRUNCATED_SQL_CELL_SUFFIX)
}

export function stripSqlCellTruncationMarker(value: string): string {
  return isSqlCellTruncated(value)
    ? value.slice(0, -TRUNCATED_SQL_CELL_SUFFIX.length)
    : value
}

export function previewSqlCellText(value: unknown, maxChars = DEFAULT_SQL_CELL_DISPLAY_CHARS): string {
  const text = stripSqlCellTruncationMarker(formatSqlCell(value))
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

export function mergeSqlPreviewResult(current: SqlResult, next: SqlResult): SqlResult {
  const mergedRows = [...(current.rows ?? []), ...(next.rows ?? [])]

  return {
    ...current,
    ...next,
    rows: mergedRows,
    loadedRows: mergedRows.length,
    truncatedCellCount: (current.truncatedCellCount ?? 0) + (next.truncatedCellCount ?? 0),
    duration: (current.duration ?? 0) + (next.duration ?? 0),
  }
}
