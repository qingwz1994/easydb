/**
 * EXPLAIN 可视化分析工作台（v1.1 MVP）
 *
 * 四层结构（v1.1 规范）：
 * - Layer 1：风险摘要栏（Risk Summary）
 * - Layer 2：执行路径图（Visual Plan Tree）
 * - Layer 3：节点解释面板（Node Insight，点击节点触发）
 * - Tab：原始输出（Raw Output，供高级用户核对）
 */

import React, { useMemo, useState } from 'react'
import {
  Row, Col, Tag, Space, Typography, Tooltip, Divider,
  theme, Segmented, Alert,
} from 'antd'
import {
  WarningOutlined, ExclamationCircleOutlined,
  InfoCircleOutlined, CheckCircleOutlined, ArrowDownOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import type { ExplainResult } from '@/services/slowQueryApi'
import type { ExplainVisualNode, ExplainVisualSummary, ExplainNodeSeverity } from './explainTypes'
import { parseJsonExplain, parseTextExplain, accessTypeLabel } from './explainParser'

const { Text } = Typography

// ─── 配色系统 ─────────────────────────────────────────────

const SEVERITY_COLOR: Record<ExplainNodeSeverity, string> = {
  error: '#ff4d4f',
  warn:  '#fa8c16',
  info:  '#c9a227',  // 深金色，可读性远胜于亮黄 #fadb14
  ok:    '#52c41a',
}

const SEVERITY_BG: Record<ExplainNodeSeverity, string> = {
  error: 'rgba(255, 77, 79, 0.08)',
  warn:  'rgba(250, 140, 22, 0.08)',
  info:  'rgba(201, 162, 39, 0.07)',
  ok:    'rgba(82, 196, 26, 0.06)',
}

const SEVERITY_ICON: Record<ExplainNodeSeverity, React.ReactNode> = {
  error: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
  warn:  <WarningOutlined style={{ color: '#fa8c16' }} />,
  info:  <InfoCircleOutlined style={{ color: '#c9a227' }} />,
  ok:    <CheckCircleOutlined style={{ color: '#52c41a' }} />,
}

const ACCESS_TYPE_COLOR: Record<string, string> = {
  ALL:    '#ff4d4f',
  INDEX:  '#fa8c16',
  RANGE:  '#c9a227',  // 金色，可读
  REF:    '#1677ff',
  EQ_REF: '#13c2c2',
  CONST:  '#52c41a',
  SYSTEM: '#52c41a',
}

// ─── 工具函数 ─────────────────────────────────────────────

const fmtRows = (n: number | undefined) =>
  n == null ? '-' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` :
  n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : n.toLocaleString('zh-CN')

// ─── Layer 1：风险摘要栏 ──────────────────────────────────

const SummaryBar: React.FC<{
  summary: ExplainVisualSummary
  format: 'JSON' | 'TEXT'
}> = ({ summary, format }) => {
  const { token } = theme.useToken()

  const cardStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 10,
    border: `1px solid ${token.colorBorder}`,
    padding: '12px 16px',
  }

  const worstColor = summary.worstAccessType
    ? (ACCESS_TYPE_COLOR[summary.worstAccessType] ?? '#8c8c8c')
    : '#52c41a'

  const issueColor = summary.issueCount === 0 ? '#52c41a' :
    summary.issueCount <= 2 ? '#fa8c16' : '#ff4d4f'

  return (
    <div style={{ marginBottom: 16 }}>
      <Row gutter={12}>
        {/* 估算成本 */}
        <Col span={format === 'JSON' ? 6 : 8}>
          <div style={cardStyle}>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
              估算成本
            </Text>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <Text style={{ fontSize: 22, fontWeight: 700, color: '#fa8c16', fontFamily: 'monospace' }}>
                {summary.estimatedCost != null ? summary.estimatedCost.toFixed(0) : '-'}
              </Text>
              <Text type="secondary" style={{ fontSize: 10 }}>（优化器估算）</Text>
            </div>
          </div>
        </Col>

        {/* 最坏访问类型 */}
        <Col span={format === 'JSON' ? 6 : 8}>
          <div style={cardStyle}>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
              最坏访问类型
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {SEVERITY_ICON[summary.worstAccessType === 'ALL' ? 'error' :
                summary.worstAccessType === 'INDEX' ? 'warn' :
                summary.worstAccessType === 'RANGE' ? 'info' : 'ok']}
              <Text style={{ fontSize: 20, fontWeight: 700, color: worstColor }}>
                {summary.worstAccessType ?? '—'}
              </Text>
            </div>
            <Text type="secondary" style={{ fontSize: 10 }}>
              {summary.worstAccessType ? accessTypeLabel(summary.worstAccessType) : '暂无数据'}
            </Text>
          </div>
        </Col>

        {/* 扫描放大（JSON 专用）*/}
        {format === 'JSON' && (
          <Col span={6}>
            <div style={cardStyle}>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                扫描放大倍率
              </Text>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <Text style={{
                  fontSize: 22, fontWeight: 700,
                  color: summary.maxAmplification > 1 ? '#ff4d4f' : '#52c41a',
                  fontFamily: 'monospace',
                }}>
                  ×{summary.maxAmplification.toLocaleString('zh-CN')}
                </Text>
              </div>
              <Text type="secondary" style={{ fontSize: 10 }}>
                {summary.hasDependentSubquery ? '关联子查询重复执行' : '无放大'}
              </Text>
            </div>
          </Col>
        )}

        {/* 风险问题数 */}
        <Col span={format === 'JSON' ? 6 : 8}>
          <div style={{ ...cardStyle, borderColor: summary.issueCount > 0 ? issueColor : token.colorBorder }}>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
              风险问题
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 22, fontWeight: 700, color: issueColor }}>
                {summary.issueCount}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>个</Text>
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
              {summary.hasDependentSubquery && <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>N+1</Tag>}
              {summary.hasFilesort && <Tag color="warning" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>排序</Tag>}
              {summary.hasTemporary && <Tag color="warning" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>临时表</Tag>}
            </div>
          </div>
        </Col>
      </Row>

      {/* 估算值免责说明 */}
      <Text type="secondary" style={{ fontSize: 10, display: 'block', marginTop: 6, marginLeft: 2 }}>
        ⚠ 以上数字均来自 MySQL 优化器估算，不等于真实运行时统计。如需真实数据请使用 EXPLAIN ANALYZE（MySQL 8.0.18+）
      </Text>
    </div>
  )
}

// ─── AccessType Badge ─────────────────────────────────────

const AccessBadge: React.FC<{ type?: string }> = ({ type }) => {
  if (!type) return null
  const color = ACCESS_TYPE_COLOR[type.toUpperCase()] ?? '#8c8c8c'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: `${color}22`,
      border: `1px solid ${color}55`,
      borderRadius: 4, padding: '1px 6px',
      fontSize: 11, fontWeight: 700, color, lineHeight: '18px',
    }}>
      {type.toUpperCase()}
    </span>
  )
}

// ─── filtered 进度条 ──────────────────────────────────────

const FilteredBar: React.FC<{ filtered?: number }> = ({ filtered }) => {
  if (filtered == null) return <Text type="secondary" style={{ fontSize: 11 }}>-</Text>
  const color = filtered < 10 ? '#ff4d4f' : filtered < 30 ? '#fa8c16' : '#52c41a'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 48, height: 5, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(filtered, 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <Text style={{ fontSize: 11, color }}>filtered {filtered.toFixed(1)}%</Text>
    </div>
  )
}

// ─── Layer 2：树节点卡片 ──────────────────────────────────

const NodeCard: React.FC<{
  node: ExplainVisualNode
  isSelected: boolean
  onClick: () => void
}> = ({ node, isSelected, onClick }) => {
  const { token } = theme.useToken()
  const sColor = SEVERITY_COLOR[node.severity]
  const sBg = SEVERITY_BG[node.severity]

  const isTableNode = ['table_scan', 'index_scan', 'range_scan', 'index_lookup'].includes(node.nodeType)

  return (
    <div
      onClick={onClick}
      style={{
        background: isSelected ? `${sColor}18` : sBg,
        border: `1px solid ${isSelected ? sColor : `${sColor}44`}`,
        borderLeft: `3px solid ${sColor}`,
        borderRadius: 8,
        padding: '10px 14px',
        cursor: 'pointer',
        transition: 'all 0.15s',
        maxWidth: 480,
      }}
    >
      {/* 主行：图标 + 标签 + 访问类型徽章 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14 }}>{SEVERITY_ICON[node.severity]}</span>
        <Text strong style={{ fontSize: 13, color: isTableNode ? token.colorText : token.colorTextSecondary }}>
          {node.label}
        </Text>
        {node.accessType && <AccessBadge type={node.accessType} />}
        {node.amplificationFactor && node.amplificationFactor > 1 && (
          <Tag color="error" style={{ fontSize: 10, fontWeight: 700 }}>
            N+1 ×{node.amplificationFactor.toLocaleString('zh-CN')}
          </Tag>
        )}
        {node.usingFilesort && (
          <Tag color="warning" style={{ fontSize: 10 }}>filesort</Tag>
        )}
        {node.usingTemporary && (
          <Tag color="warning" style={{ fontSize: 10 }}>临时表</Tag>
        )}
      </div>

      {/* 次行：估算数字 + filtered 进度条 */}
      {isTableNode && (
        <div style={{ marginTop: 6, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            估算扫描{' '}
            <span style={{ color: (node.estRows ?? 0) > 10_000 ? '#ff4d4f' : (node.estRows ?? 0) > 1000 ? '#fa8c16' : '#52c41a', fontWeight: 600 }}>
              {fmtRows(node.estRows)}
            </span>{' '}行
            {node.execTimes > 1 && (
              <span style={{ color: '#ff4d4f', fontWeight: 700, marginLeft: 4 }}>
                × {node.execTimes.toLocaleString('zh-CN')} 次
              </span>
            )}
          </Text>
          <FilteredBar filtered={node.estFiltered} />
          {node.keyUsed && (
            <Text style={{ fontSize: 11, color: '#1677ff' }}>
              🔑 {node.keyUsed}
            </Text>
          )}
          {!node.keyUsed && node.accessType?.toUpperCase() === 'ALL' && (
            <Text style={{ fontSize: 11, color: '#ff4d4f' }}>无索引</Text>
          )}
        </div>
      )}

      {/* 子查询节点：显示子查询摘要信息（估算成本）*/}
      {!isTableNode && node.estCost != null && (
        <div style={{ marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>估算成本 {node.estCost.toFixed(0)}</Text>
        </div>
      )}

      {/* 警告 chips */}
      {node.warnings.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {node.warnings.slice(0, 2).map((w, i) => (
            <Text key={i} style={{
              fontSize: 10, color: sColor,
              background: `${sColor}15`,
              padding: '1px 6px', borderRadius: 4,
            }}>
              {w}
            </Text>
          ))}
          {node.warnings.length > 2 && (
            <Tooltip title={node.warnings.slice(2).join('\n')}>
              <Text type="secondary" style={{ fontSize: 10 }}>+{node.warnings.length - 2}…</Text>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Layer 2：树连接线 ────────────────────────────────────


// ─── Layer 2：递归树渲染 ──────────────────────────────────

const PlanTreeNode: React.FC<{
  node: ExplainVisualNode
  depth: number
  isLast: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  parentAmplification?: number
}> = ({ node, depth, selectedId, onSelect }) => {

  return (
    <div style={{ position: 'relative' }}>
      {/* 连接线（非根节点） */}
      {depth > 0 && (
        <div style={{ display: 'flex', gap: 0, marginBottom: 4 }}>
          <div style={{
            width: 24, flexShrink: 0,
            borderLeft: node.nodeType === 'dependent_subquery' ? '2px dashed rgba(255,77,79,0.4)' : '2px solid rgba(100,100,100,0.3)',
            borderBottom: node.nodeType === 'dependent_subquery' ? '2px dashed rgba(255,77,79,0.4)' : '2px solid rgba(100,100,100,0.3)',
            height: 16, marginLeft: 10,
            borderBottomLeftRadius: 4,
          }} />
          {node.nodeType === 'dependent_subquery' && (
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 0, marginLeft: 4 }}>
              <Text style={{
                fontSize: 10, color: '#ff4d4f',
                background: 'rgba(255,77,79,0.1)',
                padding: '1px 5px', borderRadius: 3,
                border: '1px solid rgba(255,77,79,0.25)',
                fontWeight: 600,
              }}>
                ⚠ 关联子查询{node.amplificationFactor && node.amplificationFactor > 1
                  ? ` ×${node.amplificationFactor.toLocaleString('zh-CN')}`
                  : ''}
              </Text>
            </div>
          )}
        </div>
      )}

      {/* 节点卡片（select 节点只显示轻量标题，不显示卡片） */}
      {node.nodeType === 'select' ? (
        <div style={{ marginBottom: 6, marginLeft: depth * 24 }}>
          <Text type="secondary" style={{ fontSize: 11, fontStyle: 'italic' }}>
            {node.label}
            {node.estCost != null && (
              <span style={{ marginLeft: 8, color: '#fa8c16' }}>
                估算成本 {node.estCost.toFixed(0)}
              </span>
            )}
            {node.usingFilesort && <Tag color="warning" style={{ fontSize: 10, marginLeft: 6 }}>filesort</Tag>}
            {node.usingTemporary && <Tag color="warning" style={{ fontSize: 10, marginLeft: 4 }}>临时表</Tag>}
          </Text>
        </div>
      ) : (
        <div style={{ marginLeft: depth > 0 ? depth * 24 : 0, marginBottom: 8 }}>
          <NodeCard
            node={node}
            isSelected={selectedId === node.id}
            onClick={() => onSelect(node.id)}
          />
        </div>
      )}

      {/* 子节点 */}
      {node.children.map((child, i) => (
        <div key={child.id} style={{ marginLeft: depth * 24 }}>
          <PlanTreeNode
            node={child}
            depth={depth + 1}
            isLast={i === node.children.length - 1}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        </div>
      ))}
    </div>
  )
}

// ─── Layer 3：节点解释面板 ────────────────────────────────

const ACCESS_TYPE_EXPLANATION: Record<string, string> = {
  ALL:    '全表扫描：优化器未选择任何索引，将逐行读取整张表，数据量越大性能越差。',
  INDEX:  '索引全扫：沿索引树读取所有叶节点，比 ALL 略快（索引比全表小），但仍非最优。',
  RANGE:  '范围扫描：通过索引仅读取满足条件的行范围，有索引且范围较小时性能较好。',
  REF:    '索引匹配：基于非唯一索引精确查找，每次可能返回多行，常见于 JOIN 和 WHERE 等值查询。',
  EQ_REF: '唯一索引匹配：基于唯一索引或主键精确查找，每次最多返回 1 行，是 JOIN 中的最优访问方式。',
  CONST:  '常量访问：主键或唯一索引的等值查询，MySQL 优化器视为常量，只需一次查找。',
  SYSTEM: '系统表：系统级只有 1 行的表，MySQL 将其视为常量处理。',
}

const NodeInsightPanel: React.FC<{
  node: ExplainVisualNode
  onClose: () => void
}> = ({ node, onClose }) => {
  const { token } = theme.useToken()
  const sColor = SEVERITY_COLOR[node.severity]
  const isTableNode = ['table_scan', 'index_scan', 'range_scan', 'index_lookup'].includes(node.nodeType)

  const rows: { label: string; value: React.ReactNode }[] = []

  if (isTableNode) {
    if (node.tableName) rows.push({ label: '表名', value: <Text code>{node.tableName}</Text> })
    if (node.accessType) rows.push({
      label: '访问方式',
      value: (
        <Space>
          <AccessBadge type={node.accessType} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {accessTypeLabel(node.accessType)}
          </Text>
        </Space>
      )
    })
    if (node.estRows != null) rows.push({
      label: '估算扫描行（单次）',
      value: (
        <Text style={{ color: (node.estRows) > 10000 ? '#ff4d4f' : '#fa8c16' }}>
          {node.estRows.toLocaleString('zh-CN')} 行
        </Text>
      )
    })
    if (node.execTimes > 1) rows.push({
      label: '执行次数',
      value: <Text style={{ color: '#ff4d4f', fontWeight: 700 }}>×{node.execTimes.toLocaleString('zh-CN')}（关联子查询）</Text>
    })
    if (node.estFiltered != null) rows.push({
      label: 'filtered（估算过滤率）',
      value: (
        <Space>
          <FilteredBar filtered={node.estFiltered} />
          <Text style={{ fontSize: 12 }}>（意味着约 {node.estFiltered}% 的扫描行最终满足条件）</Text>
        </Space>
      )
    })
    if (node.keyUsed) rows.push({
      label: '命中索引',
      value: <Text style={{ color: '#1677ff' }} code>{node.keyUsed}</Text>
    })
    if (!node.keyUsed && node.possibleKeys?.length) rows.push({
      label: '候选索引（未使用）',
      value: <Text type="secondary" style={{ fontSize: 12 }}>{node.possibleKeys.join(', ')}</Text>
    })
    if (node.attachedCondition) rows.push({
      label: 'WHERE 条件',
      value: <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>{node.attachedCondition}</Text>
    })
    if (node.usedColumns?.length) rows.push({
      label: '使用的列',
      value: (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {node.usedColumns.map(c => <Tag key={c} style={{ fontSize: 10 }}>{c}</Tag>)}
        </div>
      )
    })
  }

  return (
    <div style={{
      background: 'rgba(255,255,255,0.04)',
      border: `1px solid ${sColor}55`,
      borderRadius: 8,
      padding: 16,
      marginTop: 12,
    }}>
      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <Space>
          {SEVERITY_ICON[node.severity]}
          <Text strong style={{ fontSize: 13 }}>节点解释：{node.label}</Text>
          {node.accessType && <AccessBadge type={node.accessType} />}
        </Space>
        <CloseOutlined
          style={{ cursor: 'pointer', color: token.colorTextSecondary, fontSize: 12 }}
          onClick={onClose}
        />
      </div>

      {/* access_type 解释 */}
      {node.accessType && ACCESS_TYPE_EXPLANATION[node.accessType.toUpperCase()] && (
        <Alert
          type={node.severity === 'error' ? 'error' : node.severity === 'warn' ? 'warning' : 'info'}
          showIcon={false}
          style={{ marginBottom: 12, fontSize: 12 }}
          message={ACCESS_TYPE_EXPLANATION[node.accessType.toUpperCase()]}
        />
      )}

      {/* 详细字段表格 */}
      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Text type="secondary" style={{ fontSize: 12, minWidth: 120, flexShrink: 0 }}>{r.label}</Text>
              <div style={{ flex: 1 }}>{r.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* 警告列表 */}
      {node.warnings.length > 0 && (
        <>
          <Divider style={{ margin: '12px 0' }} />
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>⚠ 风险说明</Text>
            {node.warnings.map((w, i) => (
              <div key={i} style={{
                fontSize: 12, color: sColor,
                background: `${sColor}12`,
                padding: '4px 10px', borderRadius: 4,
                marginBottom: 4,
              }}>
                {w}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── 主工作台 ─────────────────────────────────────────────

type TabKey = 'visual' | 'raw'

export const ExplainWorkbench: React.FC<{
  result: ExplainResult
}> = ({ result }) => {
  const { token } = theme.useToken()
  const [tab, setTab] = useState<TabKey>('visual')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const model = useMemo(() => {
    if (!result.success) return null
    if (result.format === 'JSON') return parseJsonExplain(result.rawOutput)
    return parseTextExplain(result.parsedPlan)
  }, [result])

  const selectedNode = useMemo(() => {
    if (!selectedId || !model) return null
    function find(nodes: ExplainVisualNode[]): ExplainVisualNode | null {
      for (const n of nodes) {
        if (n.id === selectedId) return n
        const c = find(n.children)
        if (c) return c
      }
      return null
    }
    return find(model.roots)
  }, [selectedId, model])

  const handleSelect = (id: string) => {
    setSelectedId(prev => prev === id ? null : id)
  }

  // 格式化原始输出
  const prettyRaw = useMemo(() => {
    if (result.format !== 'JSON' || !result.rawOutput) return result.rawOutput
    try { return JSON.stringify(JSON.parse(result.rawOutput), null, 2) } catch { return result.rawOutput }
  }, [result])

  return (
    <div>
      {/* Tab 切换 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <Segmented<TabKey>
          size="small"
          value={tab}
          onChange={setTab}
          options={[
            { label: '🔍 执行计划', value: 'visual' },
            { label: '{ } 原始输出', value: 'raw' },
          ]}
        />
        {model && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {result.format === 'JSON' ? 'FORMAT=JSON' : 'FORMAT=TEXT'} ·
            {' '}{model.roots.length} 个查询块 ·
            {' '}点击节点查看解释
          </Text>
        )}
      </div>

      {/* ── 执行计划 Tab ── */}
      {tab === 'visual' && (
        <>
          {!model && (
            <Alert
              type="warning"
              showIcon
              message="无法解析执行计划"
              description="请确认 EXPLAIN 执行成功且返回了有效数据"
              style={{ marginBottom: 12 }}
            />
          )}

          {model && (
            <>
              {/* Layer 1：风险摘要栏 */}
              <SummaryBar summary={model.summary} format={model.format} />

              {/* 分隔 */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                marginBottom: 12, color: token.colorTextSecondary,
                fontSize: 12,
              }}>
                <ArrowDownOutlined />
                <Text type="secondary" style={{ fontSize: 12 }}>执行路径图</Text>
                <div style={{ flex: 1, height: 1, background: token.colorBorder }} />
              </div>

              {/* Layer 2：执行路径树 */}
              <div style={{ marginBottom: 8 }}>
                {model.roots.map((root, i) => (
                  <PlanTreeNode
                    key={root.id}
                    node={root}
                    depth={0}
                    isLast={i === model.roots.length - 1}
                    selectedId={selectedId}
                    onSelect={handleSelect}
                  />
                ))}
              </div>

              {/* TEXT 格式降级提示 */}
              {model.format === 'TEXT' && (
                <Alert
                  type="info"
                  showIcon={false}
                  style={{ fontSize: 11, marginTop: 8 }}
                  message="TEXT 格式：节点按行顺序显示，无法重建父子关系。建议使用 EXPLAIN FORMAT=JSON 获得完整执行路径图。"
                />
              )}

              {/* Layer 3：节点解释面板（选中时显示） */}
              {selectedNode && (
                <NodeInsightPanel
                  node={selectedNode}
                  onClose={() => setSelectedId(null)}
                />
              )}
            </>
          )}
        </>
      )}

      {/* ── 原始输出 Tab ── */}
      {tab === 'raw' && (
        <div>
          <Alert
            type="info"
            showIcon={false}
            style={{ fontSize: 11, marginBottom: 8 }}
            message="原始输出：供高级用户核对，以下内容完全来自 MySQL EXPLAIN 返回。"
          />
          <pre style={{
            background: 'rgba(0,0,0,0.3)',
            border: `1px solid ${token.colorBorder}`,
            borderRadius: 8,
            padding: 14,
            fontSize: 11,
            fontFamily: 'monospace',
            overflow: 'auto',
            maxHeight: 400,
            color: token.colorTextSecondary,
            margin: 0,
            lineHeight: 1.6,
          }}>
            {prettyRaw || result.rawOutput || '（空）'}
          </pre>
        </div>
      )}
    </div>
  )
}

export default ExplainWorkbench
