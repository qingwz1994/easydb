/**
 * 数据导出工具 — 前端 CSV/JSON 生成 + Blob 下载
 */

/** 将数据行转为 CSV 字符串 */
export function rowsToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escapeCsvCell = (value: unknown): string => {
    const str = value === null || value === undefined ? '' : String(value)
    // 包含逗号、换行、双引号时需用双引号包裹并转义
    if (str.includes(',') || str.includes('\n') || str.includes('"')) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  const header = columns.map(escapeCsvCell).join(',')
  const body = rows.map(row =>
    columns.map(col => escapeCsvCell(row[col])).join(',')
  ).join('\n')

  return `${header}\n${body}`
}

/** 将数据行转为格式化 JSON 字符串 */
export function rowsToJson(columns: string[], rows: Record<string, unknown>[]): string {
  // 只保留 columns 中的字段，过滤掉前端添加的 _key 等临时字段
  const cleanRows = rows.map(row => {
    const clean: Record<string, unknown> = {}
    for (const col of columns) {
      clean[col] = row[col] ?? null
    }
    return clean
  })
  return JSON.stringify(cleanRows, null, 2)
}

/** 将数据行转为 SQL INSERT 语句 */
export function rowsToSqlInsert(tableName: string, columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return `-- 表 ${tableName} 无数据\n`

  const escapeSqlValue = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'boolean') return value ? '1' : '0'
    const str = String(value)
    return `'${str.replace(/'/g, "''")}'`
  }

  const colList = columns.map(c => `\`${c}\``).join(', ')
  const statements = rows.map(row => {
    const values = columns.map(col => escapeSqlValue(row[col])).join(', ')
    return `INSERT INTO \`${tableName}\` (${colList}) VALUES (${values});`
  })

  return statements.join('\n')
}

/** 触发浏览器文件下载 */
export function downloadBlob(content: string, filename: string, mimeType: string): void {
  // 添加 BOM 以便 Excel 正确识别 UTF-8
  const bom = mimeType.includes('csv') ? '\uFEFF' : ''
  const blob = new Blob([bom + content], { type: `${mimeType};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 导出查询结果 — 一步到位 */
export function exportResultSet(
  columns: string[],
  rows: Record<string, unknown>[],
  format: 'csv' | 'json',
  filenameBase = 'query_result',
): void {
  let content: string
  let ext: string
  let mime: string

  switch (format) {
    case 'csv':
      content = rowsToCsv(columns, rows)
      ext = 'csv'
      mime = 'text/csv'
      break
    case 'json':
      content = rowsToJson(columns, rows)
      ext = 'json'
      mime = 'application/json'
      break
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  downloadBlob(content, `${filenameBase}_${timestamp}.${ext}`, mime)
}

/** 导出表数据（含 SQL INSERT 格式） */
export function exportTableData(
  tableName: string,
  columns: string[],
  rows: Record<string, unknown>[],
  format: 'csv' | 'json' | 'sql',
): void {
  let content: string
  let ext: string
  let mime: string

  switch (format) {
    case 'csv':
      content = rowsToCsv(columns, rows)
      ext = 'csv'
      mime = 'text/csv'
      break
    case 'json':
      content = rowsToJson(columns, rows)
      ext = 'json'
      mime = 'application/json'
      break
    case 'sql':
      content = rowsToSqlInsert(tableName, columns, rows)
      ext = 'sql'
      mime = 'text/plain'
      break
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  downloadBlob(content, `${tableName}_${timestamp}.${ext}`, mime)
}
