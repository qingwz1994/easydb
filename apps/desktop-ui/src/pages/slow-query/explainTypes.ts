/**
 * EXPLAIN 可视化分析 — 数据模型
 *
 * 设计原则（v1.1）：
 * - 操作节点为中心（而非表节点）：SELECT / TableScan / DependentSubquery / Sort / Temp
 * - 区分"估算值"与"真实值"：所有来自 EXPLAIN 的数字均为估算
 * - 严重性继承：父节点严重性 ≥ max(子节点严重性)
 */

export type ExplainNodeType =
  | 'select'              // 顶层 query_block 包装节点
  | 'table_scan'          // access_type = ALL（高风险）
  | 'index_scan'          // access_type = index（中风险）
  | 'range_scan'          // access_type = range（低风险）
  | 'index_lookup'        // access_type = ref / eq_ref / const / system（最优）
  | 'dependent_subquery'  // dependent=true + cacheable=false → N+1 问题
  | 'subquery'            // 非关联子查询
  | 'sort'                // ordering_operation（filesort）
  | 'temporary'           // grouping_operation（using_temporary_table）
  | 'derived'             // 派生表（FROM 子句子查询）

export type ExplainNodeSeverity = 'error' | 'warn' | 'info' | 'ok'

export interface ExplainVisualNode {
  id: string
  nodeType: ExplainNodeType
  label: string              // 显示标签

  // 表信息（仅 table_scan / index_scan / range_scan / index_lookup）
  tableName?: string
  alias?: string

  // 访问方式
  accessType?: string         // 原始 access_type

  // 估算值（全部来自 EXPLAIN 优化器估算，非真实运行统计）
  estRows?: number            // rows_examined_per_scan（单次）
  estRowsProduced?: number    // rows_produced_per_join（输出行数）
  estFiltered?: number        // filtered %（0-100）
  estCost?: number            // prefix_cost 或 query_cost

  // 执行次数（关联子查询时 = 父节点 estRowsProduced）
  execTimes: number
  totalEstRows: number        // estRows * execTimes（真正的扫描放大后总量）
  amplificationFactor?: number // 等于 execTimes（> 1 时显示放大警告）

  // 索引信息
  possibleKeys?: string[]
  keyUsed?: string | null
  keyLen?: string | null
  ref?: string | null

  // 条件信息
  attachedCondition?: string
  usedColumns?: string[]

  // 额外操作标记
  usingFilesort?: boolean
  usingTemporary?: boolean
  isDependent?: boolean
  isCacheable?: boolean

  // 风险评估
  severity: ExplainNodeSeverity
  warnings: string[]

  // 树结构
  children: ExplainVisualNode[]

  // TEXT 格式专用
  selectId?: number
  selectType?: string
  extra?: string | null
}

export interface ExplainVisualSummary {
  estimatedCost?: number
  estimatedTotalRows: number     // 所有节点 totalEstRows 之和（估算）
  maxAmplification: number       // 最大放大倍数（关联子查询）
  issueCount: number             // 所有节点 warnings 总数
  hasDependentSubquery: boolean
  hasFilesort: boolean
  hasTemporary: boolean
  worstAccessType?: string       // 最坏的 access_type（ALL / INDEX / RANGE 等）
}

export interface ExplainVisualModel {
  summary: ExplainVisualSummary
  roots: ExplainVisualNode[]
  format: 'JSON' | 'TEXT'
}
