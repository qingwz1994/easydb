import type { SqlResult, ColumnInfo, EditabilityStatus, EditabilityReason } from '@/types'

/**
 * 从 SQL 中提取表名
 * 使用正则匹配 FROM / UPDATE / INTO 后的表名
 */
export function extractAllTableNames(sql: string): string[] {
  if (!sql) return []
  const regex = /(?:FROM|UPDATE|INTO)\s+([`'"]?[a-zA-Z0-9_$.]+[`'"]?)/gi
  const matches = [...sql.matchAll(regex)]
  return matches.map(m => m[1].replace(/[`'"]/g, '').split('.').pop() ?? m[1])
}

/**
 * 检查 SQL 是否包含聚合关键词
 */
function hasAggregateKeywords(sql: string): boolean {
  const sqlUpper = sql.toUpperCase()
  return sqlUpper.includes('GROUP BY') ||
         sqlUpper.includes('DISTINCT') ||
         sqlUpper.includes('HAVING') ||
         /\bCOUNT\s*\(/.test(sqlUpper) ||
         /\bSUM\s*\(/.test(sqlUpper) ||
         /\bAVG\s*\(/.test(sqlUpper) ||
         /\bMIN\s*\(/.test(sqlUpper) ||
         /\bMAX\s*\(/.test(sqlUpper)
}

/**
 * 获取不可编辑原因的友好文本
 */
export function getEditabilityReasonText(reason: EditabilityReason): string {
  const texts: Record<EditabilityReason, string> = {
    'not_query': '非 SELECT 查询',
    'preview_mode': '数据已截断，需先加载完整数据',
    'missing_context': '缺少连接或数据库信息',
    'parse_error': '无法解析 SQL 结构',
    'multi_table': '多表 JOIN 查询无法确定编辑目标',
    'aggregate': '聚合查询结果无主键',
    'view': '视图通常是只读的',
    'no_primary_key': '表没有主键，无法定位行',
    'metadata_error': '无法获取表元数据',
  }
  return texts[reason] || '查询结果不可编辑'
}

/**
 * 分析 SQL 查询结果是否可编辑
 *
 * 判断流程：
 * 1. 基础检查：类型、预览模式、连接信息
 * 2. SQL 解析：提取表名、检测聚合
 * 3. 获取表元数据：主键信息
 * 4. 返回可编辑性状态
 */
export async function analyzeEditability(
  result: SqlResult,
  metadataApi: {
    tableDefinition: (connectionId: string, database: string, table: string) => Promise<unknown>
  }
): Promise<EditabilityStatus> {
  // Step 1: 基础检查
  if (result.type !== 'query') {
    return { editable: false, reason: 'not_query' }
  }

  // 注意：不再检查 preview_mode
  // 编辑基于主键定位行，只需要知道表名+主键列名+当前行的主键值
  // 即使数据截断（hasMore=true），已加载的行也可以独立编辑
  // 这与 DBeaver/Navicat 等专业数据库工具的行为一致

  if (!result.connectionId || !result.database) {
    return { editable: false, reason: 'missing_context' }
  }

  // Step 2: SQL 解析
  const tableNames = extractAllTableNames(result.sql || '')

  if (tableNames.length === 0) {
    return { editable: false, reason: 'parse_error' }
  }

  if (tableNames.length > 1) {
    return { editable: false, reason: 'multi_table' }
  }

  // 检测聚合
  if (hasAggregateKeywords(result.sql || '')) {
    return { editable: false, reason: 'aggregate' }
  }

  const tableName = tableNames[0]

  // Step 3: 获取表元数据
  try {
    const tableDef = await metadataApi.tableDefinition(
      result.connectionId,
      result.database,
      tableName
    ) as { table: { name: string; type: string }; columns: ColumnInfo[]; indexes?: unknown[] }

    // 检查是否是视图
    if (tableDef.table?.type === 'view') {
      return { editable: false, reason: 'view', tableName }
    }

    // 检查主键
    const primaryKeys = tableDef.columns
      .filter(c => c.isPrimaryKey)
      .map(c => c.name)

    if (primaryKeys.length === 0) {
      return { editable: false, reason: 'no_primary_key', tableName }
    }

    // Step 4: 返回成功
    return {
      editable: true,
      tableName,
      primaryKeys,
      columns: tableDef.columns
    }
  } catch {
    return { editable: false, reason: 'metadata_error', tableName }
  }
}