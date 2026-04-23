/**
 * EXPLAIN 解析器
 *
 * 支持两种格式：
 * - JSON：完整解析（递归处理 query_block / table / nested_loop / select_list_subqueries）
 * - TEXT：扁平解析（ExplainPlanNode[] → ExplainVisualNode[]，无父子关系重建）
 *
 * 注意：所有 rows / filtered / cost 均为 MySQL 优化器估算值，非真实运行统计。
 */

import type {
  ExplainVisualNode,
  ExplainVisualModel,
  ExplainVisualSummary,
  ExplainNodeType,
  ExplainNodeSeverity,
} from './explainTypes'
import type { ExplainPlanNode } from '@/services/slowQueryApi'

// ─── ID 生成 ─────────────────────────────────────────────

let _counter = 0
function uid(): string { return `n${++_counter}` }

// ─── access_type 工具函数 ─────────────────────────────────

function accessTypeSeverity(type?: string): ExplainNodeSeverity {
  switch (type?.toUpperCase()) {
    case 'ALL':    return 'error'
    case 'INDEX':  return 'warn'
    case 'RANGE':  return 'info'
    case 'REF':
    case 'EQ_REF':
    case 'CONST':
    case 'SYSTEM': return 'ok'
    default:       return 'info'
  }
}

export function accessTypeLabel(type?: string): string {
  switch (type?.toUpperCase()) {
    case 'ALL':    return '全表扫描'
    case 'INDEX':  return '索引全扫'
    case 'RANGE':  return '范围扫描'
    case 'REF':    return '索引匹配'
    case 'EQ_REF': return '唯一索引'
    case 'CONST':  return '常量访问'
    case 'SYSTEM': return '系统表'
    default:       return type ?? '未知'
  }
}

function accessTypeToNodeType(type?: string): ExplainNodeType {
  switch (type?.toUpperCase()) {
    case 'ALL':    return 'table_scan'
    case 'INDEX':  return 'index_scan'
    case 'RANGE':  return 'range_scan'
    default:       return 'index_lookup'
  }
}

// ─── 警告生成 ─────────────────────────────────────────────

function buildTableWarnings(
  accessType: string | undefined,
  estRows: number | undefined,
  estFiltered: number | undefined,
  hasKey: boolean,
  hasPossibleKeys: boolean,
): string[] {
  const ws: string[] = []
  if (accessType?.toUpperCase() === 'ALL' && (estRows ?? 0) > 1000) {
    ws.push(`全表扫描：单次估算扫描 ${(estRows ?? 0).toLocaleString('zh-CN')} 行`)
  }
  if (estFiltered !== undefined && estFiltered < 10 && (estRows ?? 0) > 100) {
    ws.push(`过滤率极低（${estFiltered}%）：大量扫描行被丢弃`)
  }
  if (!hasKey && hasPossibleKeys) {
    ws.push('有候选索引但优化器未选择使用')
  }
  return ws
}

// ─── JSON EXPLAIN 解析 ────────────────────────────────────

/**
 * 解析 table 对象（JSON 格式）
 */
function parseTableObj(tableObj: any, execTimes: number): ExplainVisualNode {
  const accessType = tableObj.access_type as string | undefined
  const estRows: number | undefined = tableObj.rows_examined_per_scan
  const estRowsProduced: number | undefined = tableObj.rows_produced_per_join
  const filteredRaw = tableObj.filtered
  const estFiltered: number | undefined =
    typeof filteredRaw === 'string'  ? parseFloat(filteredRaw) :
    typeof filteredRaw === 'number'  ? filteredRaw : undefined
  const costInfo = tableObj.cost_info ?? {}
  const estCost: number | undefined = costInfo.prefix_cost
    ? parseFloat(costInfo.prefix_cost)
    : undefined

  const totalEstRows = (estRows ?? 0) * execTimes
  const nodeType = accessTypeToNodeType(accessType)
  const severity = accessTypeSeverity(accessType)

  const possibleKeys = Array.isArray(tableObj.possible_keys) ? tableObj.possible_keys as string[] : undefined
  const keyUsed = (tableObj.key as string | undefined) ?? null

  const warnings = buildTableWarnings(
    accessType,
    estRows,
    estFiltered,
    !!keyUsed,
    (possibleKeys?.length ?? 0) > 0,
  )

  const tableName = tableObj.table_name as string | undefined
  const label = tableName ?? '未知表'

  return {
    id: uid(),
    nodeType,
    label,
    tableName,
    accessType,
    estRows,
    estRowsProduced,
    estFiltered,
    estCost,
    execTimes,
    totalEstRows,
    possibleKeys,
    keyUsed,
    keyLen: (tableObj.key_length as string | undefined) ?? null,
    ref: typeof tableObj.ref === 'string' ? tableObj.ref : null,
    attachedCondition: tableObj.attached_condition as string | undefined,
    usedColumns: Array.isArray(tableObj.used_columns) ? tableObj.used_columns as string[] : undefined,
    severity,
    warnings,
    children: [],
  }
}

/**
 * 从 query_block 中提取 "产出行数"（用来计算子查询执行次数）
 */
function extractRowsProduced(block: any): number {
  if (typeof block.table?.rows_produced_per_join === 'number') {
    return block.table.rows_produced_per_join
  }
  if (Array.isArray(block.nested_loop)) {
    const loops = block.nested_loop as any[]
    const last = loops[loops.length - 1]
    if (typeof last?.table?.rows_produced_per_join === 'number') {
      return last.table.rows_produced_per_join
    }
  }
  return 1
}

/**
 * 递归解析 query_block（JSON 格式）
 */
function parseQueryBlock(
  block: any,
  execTimes = 1,
  isDependent = false,
  isCacheable = true,
): ExplainVisualNode {
  const selectId = block.select_id as number | undefined
  const costInfo = block.cost_info ?? {}
  const estCost: number | undefined = costInfo.query_cost
    ? parseFloat(costInfo.query_cost)
    : undefined

  const children: ExplainVisualNode[] = []
  let usingFilesort = false
  let usingTemporary = false

  // 剥离 ordering/grouping 包装层
  let dataLevel: any = block
  if (block.ordering_operation) {
    usingFilesort = block.ordering_operation.using_filesort === true
    dataLevel = block.ordering_operation
  }
  if (block.grouping_operation) {
    usingTemporary = block.grouping_operation.using_temporary_table === true
    usingFilesort = usingFilesort || (block.grouping_operation.using_filesort === true)
    dataLevel = block.grouping_operation
  }

  const parentRows = extractRowsProduced(dataLevel)

  // 主访问节点（table 或 nested_loop）
  if (dataLevel.table) {
    children.push(parseTableObj(dataLevel.table, execTimes))
  }
  if (Array.isArray(dataLevel.nested_loop)) {
    for (const loop of dataLevel.nested_loop as any[]) {
      if (loop.table) children.push(parseTableObj(loop.table, execTimes))
      else if (loop.query_block) children.push(parseQueryBlock(loop.query_block, execTimes))
    }
  }

  // SELECT 列表子查询（最常见的关联子查询位置）
  const subqueries = (
    (block.select_list_subqueries ?? dataLevel.select_list_subqueries) as any[] | undefined
  )
  if (subqueries) {
    for (const subEntry of subqueries) {
      const dep = subEntry.dependent === true
      const cache = subEntry.cacheable !== false
      const subExecTimes = dep && !cache ? Math.max(1, parentRows) : 1

      if (subEntry.query_block) {
        const subNode = parseQueryBlock(subEntry.query_block, subExecTimes, dep, cache)
        subNode.isDependent = dep
        subNode.isCacheable = cache
        subNode.amplificationFactor = subExecTimes > 1 ? subExecTimes : undefined
        subNode.execTimes = subExecTimes
        subNode.nodeType = dep && !cache ? 'dependent_subquery' : 'subquery'
        subNode.label = dep && !cache
          ? `关联子查询  ×${subExecTimes.toLocaleString('zh-CN')} 次执行`
          : '子查询（已缓存）'
        if (dep && !cache) {
          subNode.severity = 'error'
          subNode.warnings.unshift(
            `N+1 问题：此子查询随外层每行执行一次（共 ${subExecTimes.toLocaleString('zh-CN')} 次）`
          )
        }
        children.push(subNode)
      }
    }
  }

  // WHERE 子句中的子查询
  const attachedSubs = block.attached_subqueries as any[] | undefined
  if (attachedSubs) {
    for (const sub of attachedSubs) {
      if (sub.query_block) {
        const subNode = parseQueryBlock(sub.query_block, execTimes)
        subNode.nodeType = 'subquery'
        subNode.label = 'WHERE 子查询'
        children.push(subNode)
      }
    }
  }

  const warnings: string[] = []
  if (isDependent && !isCacheable) {
    warnings.push(`此块将被重复执行 ${execTimes.toLocaleString('zh-CN')} 次`)
  }
  if (usingFilesort) warnings.push('文件排序（ORDER BY 无法使用索引）')
  if (usingTemporary) warnings.push('使用临时表（GROUP BY / DISTINCT）')

  const severity: ExplainNodeSeverity =
    isDependent && !isCacheable ? 'error' :
    usingTemporary ? 'warn' :
    usingFilesort  ? 'warn' : 'ok'

  return {
    id: uid(),
    nodeType: isDependent && !isCacheable ? 'dependent_subquery' : 'select',
    label: `SELECT  (id=${selectId ?? '?'})`,
    estCost,
    execTimes,
    totalEstRows: 0, // 在 computeSummary 中汇总
    usingFilesort,
    usingTemporary,
    isDependent,
    isCacheable,
    amplificationFactor: isDependent && !isCacheable && execTimes > 1 ? execTimes : undefined,
    severity,
    warnings,
    children,
  }
}

// ─── 摘要计算 ─────────────────────────────────────────────

const ACCESS_PRIORITY: Record<string, number> = {
  ALL: 4, INDEX: 3, RANGE: 2, REF: 1, EQ_REF: 0, CONST: 0, SYSTEM: 0,
}

function computeSummary(roots: ExplainVisualNode[]): ExplainVisualSummary {
  let estimatedCost: number | undefined
  let estimatedTotalRows = 0
  let maxAmplification = 1
  let issueCount = 0
  let hasDependentSubquery = false
  let hasFilesort = false
  let hasTemporary = false
  let worstAccessType: string | undefined
  let worstPriority = -1

  function traverse(node: ExplainVisualNode) {
    if (node.estCost !== undefined) {
      if (estimatedCost === undefined || node.estCost > (estimatedCost ?? 0)) {
        estimatedCost = node.estCost
      }
    }
    if (node.estRows !== undefined) {
      estimatedTotalRows += node.totalEstRows
    }
    if ((node.amplificationFactor ?? 0) > maxAmplification) {
      maxAmplification = node.amplificationFactor!
    }
    if (node.isDependent && !node.isCacheable) hasDependentSubquery = true
    if (node.usingFilesort) hasFilesort = true
    if (node.usingTemporary) hasTemporary = true
    issueCount += node.warnings.length

    if (node.accessType) {
      const p = ACCESS_PRIORITY[node.accessType.toUpperCase()] ?? -1
      if (p > worstPriority) {
        worstPriority = p
        worstAccessType = node.accessType.toUpperCase()
      }
    }
    node.children.forEach(traverse)
  }

  roots.forEach(traverse)

  return {
    estimatedCost,
    estimatedTotalRows,
    maxAmplification,
    issueCount,
    hasDependentSubquery,
    hasFilesort,
    hasTemporary,
    worstAccessType,
  }
}

// ─── 公开 API ─────────────────────────────────────────────

/**
 * 解析 EXPLAIN FORMAT=JSON 的 rawOutput
 */
export function parseJsonExplain(rawJson: string): ExplainVisualModel | null {
  _counter = 0
  try {
    const parsed = JSON.parse(rawJson) as any
    const queryBlock = parsed.query_block
    if (!queryBlock) return null

    const rootNode = parseQueryBlock(queryBlock)
    const roots = [rootNode]
    const summary = computeSummary(roots)

    return { summary, roots, format: 'JSON' }
  } catch {
    return null
  }
}

/**
 * 将 TEXT EXPLAIN 的 parsedPlan 转换为可视化模型
 * 注：TEXT 格式不做树重建，按扁平列表处理
 */
export function parseTextExplain(parsedPlan: ExplainPlanNode[]): ExplainVisualModel | null {
  if (!parsedPlan || parsedPlan.length === 0) return null
  _counter = 0

  const nodes: ExplainVisualNode[] = parsedPlan.map(row => {
    const accessType = row.type ?? undefined
    const estRows = row.rows != null ? Number(row.rows) : undefined
    const estFiltered = row.filtered ?? undefined
    const extra = row.extra ?? ''
    const severity = accessTypeSeverity(accessType)
    const possibleKeys = row.possibleKeys ? [row.possibleKeys] : undefined
    const keyUsed = row.key ?? null

    const warnings = buildTableWarnings(accessType, estRows, estFiltered, !!keyUsed, (possibleKeys?.length ?? 0) > 0)
    if (extra.includes('filesort')) warnings.push('文件排序（Using filesort）')
    if (extra.includes('temporary')) warnings.push('使用临时表（Using temporary）')

    return {
      id: uid(),
      nodeType: accessTypeToNodeType(accessType),
      label: `${row.table ?? '?'}`,
      tableName: row.table ?? undefined,
      accessType,
      estRows,
      estFiltered,
      execTimes: 1,
      totalEstRows: estRows ?? 0,
      possibleKeys,
      keyUsed,
      severity,
      warnings,
      children: [],
      selectId: row.id ?? undefined,
      selectType: row.selectType ?? undefined,
      extra: row.extra ?? null,
      usingFilesort: extra.includes('filesort'),
      usingTemporary: extra.includes('temporary'),
    }
  })

  const summary = computeSummary(nodes)
  return { summary, roots: nodes, format: 'TEXT' }
}
