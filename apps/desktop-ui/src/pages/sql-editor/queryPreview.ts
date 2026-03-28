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
  return /^(select|show|desc|describe|explain|with)\b/i.test(normalized)
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

export function collectSqlQuerySessionIds(...resultGroups: Array<SqlResult[] | null | undefined>): string[] {
  const sessionIds = new Set<string>()

  resultGroups.forEach((results) => {
    results?.forEach((result) => {
      if (result.querySessionId) {
        sessionIds.add(result.querySessionId)
      }
    })
  })

  return [...sessionIds]
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
