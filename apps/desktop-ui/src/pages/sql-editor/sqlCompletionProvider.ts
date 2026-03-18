import type { languages, editor, Position } from 'monaco-editor'
import { metadataApi } from '@/services/api'

// ─── SQL 关键字 ─────────────────────────────────────────────
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS', 'NULL',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'DATABASE',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'ON',
  'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'HAVING',
  'LIMIT', 'OFFSET', 'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'COUNT', 'SUM', 'AVG', 'MAX', 'MIN',
  'UNION', 'ALL', 'EXISTS', 'ANY',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE', 'DEFAULT', 'AUTO_INCREMENT',
  'IF', 'TRUNCATE', 'REPLACE', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'USE',
  'VARCHAR', 'INT', 'BIGINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'TEXT', 'BLOB',
  'DATE', 'DATETIME', 'TIMESTAMP', 'BOOLEAN', 'CHAR',
]

// ─── MySQL 内置函数 ──────────────────────────────────────────
const SQL_FUNCTIONS = [
  'NOW()', 'CURDATE()', 'CURTIME()', 'DATE_FORMAT()', 'DATEDIFF()',
  'CONCAT()', 'SUBSTRING()', 'LENGTH()', 'TRIM()', 'UPPER()', 'LOWER()', 'REPLACE()',
  'IFNULL()', 'COALESCE()', 'NULLIF()', 'CAST()',
  'ROUND()', 'CEIL()', 'FLOOR()', 'ABS()', 'MOD()',
  'GROUP_CONCAT()', 'JSON_EXTRACT()', 'JSON_OBJECT()',
]

// ─── 缓存 ─────────────────────────────────────────────────
interface TableMeta {
  name: string
  columns?: string[]
}

let cachedConnectionId = ''
let cachedDatabase = ''
let cachedTables: TableMeta[] = []
let loadingTables = false

/**
 * 加载当前数据库的表列表（带缓存）
 */
async function ensureTablesLoaded(connectionId: string, database: string): Promise<TableMeta[]> {
  if (cachedConnectionId === connectionId && cachedDatabase === database && cachedTables.length > 0) {
    return cachedTables
  }
  if (loadingTables) return cachedTables

  loadingTables = true
  try {
    const objects = await metadataApi.objects(connectionId, database) as Array<{ name: string; type: string }>
    cachedTables = objects
      .filter((o) => o.type === 'table' || o.type === 'view')
      .map((o) => ({ name: o.name }))
    cachedConnectionId = connectionId
    cachedDatabase = database
  } catch {
    // 静默失败，不影响编辑
  } finally {
    loadingTables = false
  }
  return cachedTables
}

/**
 * 加载表的字段列表（带缓存）
 */
async function ensureColumnsLoaded(connectionId: string, database: string, tableName: string): Promise<string[]> {
  const table = cachedTables.find((t) => t.name.toLowerCase() === tableName.toLowerCase())
  if (table?.columns) return table.columns

  try {
    const columns = await metadataApi.tableDefinition(connectionId, database, tableName) as Array<{ name: string }>
    const colNames = columns.map((c) => c.name)
    if (table) table.columns = colNames
    return colNames
  } catch {
    return []
  }
}

/**
 * 清除缓存（切换数据库时调用）
 */
export function clearCompletionCache() {
  cachedConnectionId = ''
  cachedDatabase = ''
  cachedTables = []
}

/**
 * 从光标位置向前查找刚输入的 "tableName." 中的表名
 */
function getTablePrefix(model: editor.ITextModel, position: Position): string | null {
  const lineContent = model.getLineContent(position.lineNumber)
  const textBefore = lineContent.substring(0, position.column - 1)

  // 匹配 "tablename." 模式（含反引号）
  const match = textBefore.match(/(?:`([^`]+)`|(\w+))\.$/i)
  if (match) return match[1] || match[2]
  return null
}

/**
 * 从编辑器内容中提取已出现的表名（用于 SELECT 字段提示）
 */
function extractReferencedTables(text: string): string[] {
  const tables: string[] = []
  // 匹配 FROM tableName, JOIN tableName
  const regex = /(?:FROM|JOIN)\s+(?:`([^`]+)`|(\w+))/gi
  let m
  while ((m = regex.exec(text)) !== null) {
    tables.push(m[1] || m[2])
  }
  return [...new Set(tables)]
}

/**
 * 创建 Monaco CompletionItemProvider
 */
export function createSqlCompletionProvider(
  connectionId: string,
  database: string,
  monacoInstance: typeof import('monaco-editor')
): languages.CompletionItemProvider {
  return {
    triggerCharacters: ['.', ' '],

    async provideCompletionItems(
      model: editor.ITextModel,
      position: Position
    ): Promise<languages.CompletionList> {
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }

      const suggestions: languages.CompletionItem[] = []

      // ─── 1. 表名.字段 补全 ──────────────────────────────────
      const tablePrefix = getTablePrefix(model, position)
      if (tablePrefix) {
        const columns = await ensureColumnsLoaded(connectionId, database, tablePrefix)
        for (const col of columns) {
          suggestions.push({
            label: col,
            kind: monacoInstance.languages.CompletionItemKind.Field,
            insertText: col,
            detail: `${tablePrefix} 字段`,
            range,
          })
        }
        return { suggestions }
      }

      // ─── 2. SQL 关键字 ─────────────────────────────────────
      for (const kw of SQL_KEYWORDS) {
        suggestions.push({
          label: kw,
          kind: monacoInstance.languages.CompletionItemKind.Keyword,
          insertText: kw,
          detail: 'SQL 关键字',
          range,
        })
      }

      // ─── 3. SQL 函数 ──────────────────────────────────────
      for (const fn of SQL_FUNCTIONS) {
        suggestions.push({
          label: fn,
          kind: monacoInstance.languages.CompletionItemKind.Function,
          insertText: fn,
          detail: 'MySQL 函数',
          range,
        })
      }

      // ─── 4. 表名补全 ──────────────────────────────────────
      const tables = await ensureTablesLoaded(connectionId, database)
      for (const table of tables) {
        suggestions.push({
          label: table.name,
          kind: monacoInstance.languages.CompletionItemKind.Struct,
          insertText: table.name,
          detail: '表',
          range,
        })
      }

      // ─── 5. 上下文中引用的表的字段（无需 "表名." 前缀） ────
      const fullText = model.getValue()
      const referencedTables = extractReferencedTables(fullText)
      for (const tName of referencedTables) {
        const columns = await ensureColumnsLoaded(connectionId, database, tName)
        for (const col of columns) {
          suggestions.push({
            label: col,
            kind: monacoInstance.languages.CompletionItemKind.Field,
            insertText: col,
            detail: `${tName}`,
            sortText: `1_${col}`, // 字段排在前面
            range,
          })
        }
      }

      return { suggestions }
    },
  }
}
