import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Select, Button, Table, Tag, Space, Alert, Typography, Drawer,
  Input, InputNumber, Switch, Empty, Tooltip, message, Spin, Segmented,
  Statistic, Row, Col, Divider, Badge, theme,
} from 'antd'
import {
  ThunderboltOutlined, SearchOutlined, ReloadOutlined,
  InfoCircleOutlined, WarningOutlined, ExclamationCircleOutlined,
  DatabaseOutlined, CodeOutlined, BulbOutlined, FilterOutlined,
  ClockCircleOutlined, EyeOutlined,
} from '@ant-design/icons'
import { connectionApi, metadataApi } from '@/services/api'
import { slowQueryApi } from '@/services/slowQueryApi'
import { ExplainWorkbench } from './ExplainWorkbench'
import type {
  SlowQueryCapability, SlowQueryDigestItem, SlowQueryDigestPage,
  SlowQuerySample, ExplainResult, Advice, SlowQueryQueryRequest,
  SlowQuerySortField, SortOrder,
} from '@/services/slowQueryApi'
import type { ConnectionConfig, DatabaseInfo } from '@/types'

const { Text } = Typography

// ─── 工具函数 ────────────────────────────────────────────

const fmtMs = (ms: number) => {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  if (ms >= 1)    return `${ms.toFixed(1)}ms`
  return `${(ms * 1000).toFixed(1)}μs`
}

const fmtNum = (n: number) => n.toLocaleString('zh-CN')

const adviceLevelConfig: Record<string, { color: 'error' | 'warning' | 'info'; icon: React.ReactNode }> = {
  ERROR: { color: 'error',   icon: <ExclamationCircleOutlined /> },
  WARN:  { color: 'warning', icon: <WarningOutlined /> },
  INFO:  { color: 'info',    icon: <InfoCircleOutlined /> },
}


// ─── 能力横幅 ────────────────────────────────────────────

const CapabilityBanner: React.FC<{
  capability: SlowQueryCapability
}> = ({ capability }) => {
  if (!capability.performanceSchemaEnabled) {
    return (
      <Alert
        type="error"
        showIcon
        icon={<ExclamationCircleOutlined />}
        message="performance_schema 未开启"
        description={
          <span>慢查询分析需要 MySQL 开启 <code>performance_schema</code>。请在 MySQL 配置文件中添加 <code>performance_schema=ON</code> 并重启 MySQL。</span>
        }
        style={{ marginBottom: 16 }}
      />
    )
  }
  if (capability.warnings.length > 0) {
    return (
      <Alert
        type="warning"
        showIcon
        message="部分功能受限"
        description={
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {capability.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        }
        style={{ marginBottom: 16 }}
        closable
      />
    )
  }
  return null
}

// ─── 汇总统计卡片 ────────────────────────────────────────

const StatisticsRow: React.FC<{
  page: SlowQueryDigestPage | null
  loading: boolean
}> = ({ page, loading }) => {
  const { token } = theme.useToken()
  const stats = page?.statistics
  const cardStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    border: `1px solid ${token.colorBorder}`,
  }

  return (
    <Row gutter={12} style={{ marginBottom: 16 }}>
      <Col span={6}>
        <Card size="small" style={cardStyle} bodyStyle={{ padding: '12px 16px' }}>
          <Statistic
            title={<Text type="secondary" style={{ fontSize: 12 }}>Digest 总数</Text>}
            value={loading ? '-' : (page?.total ?? '-')}
            formatter={v => <Text strong style={{ fontSize: 20 }}>{v}</Text>}
            prefix={<DatabaseOutlined style={{ color: token.colorPrimary, marginRight: 4 }} />}
          />
        </Card>
      </Col>
      <Col span={6}>
        <Card size="small" style={cardStyle} bodyStyle={{ padding: '12px 16px' }}>
          <Statistic
            title={<Text type="secondary" style={{ fontSize: 12 }}>平均耗时</Text>}
            value={stats ? fmtMs(stats.avgLatencyMs) : '-'}
            formatter={v => <Text strong style={{ fontSize: 20, color: '#fa8c16' }}>{v}</Text>}
            prefix={<ClockCircleOutlined style={{ color: '#fa8c16', marginRight: 4 }} />}
          />
        </Card>
      </Col>
      <Col span={6}>
        <Card size="small" style={cardStyle} bodyStyle={{ padding: '12px 16px' }}>
          <Statistic
            title={<Text type="secondary" style={{ fontSize: 12 }}>最大耗时</Text>}
            value={stats ? fmtMs(stats.maxLatencyMs) : '-'}
            formatter={v => <Text strong style={{ fontSize: 20, color: '#ff4d4f' }}>{v}</Text>}
            prefix={<ThunderboltOutlined style={{ color: '#ff4d4f', marginRight: 4 }} />}
          />
        </Card>
      </Col>
      <Col span={6}>
        <Card size="small" style={cardStyle} bodyStyle={{ padding: '12px 16px' }}>
          <Statistic
            title={<Text type="secondary" style={{ fontSize: 12 }}>无索引占比</Text>}
            value={stats ? `${(stats.noIndexRatio * 100).toFixed(1)}%` : '-'}
            formatter={v => (
              <Text strong style={{ fontSize: 20, color: Number((stats?.noIndexRatio ?? 0) * 100) > 20 ? '#ff4d4f' : '#52c41a' }}>{v}</Text>
            )}
            prefix={<FilterOutlined style={{ color: '#8c8c8c', marginRight: 4 }} />}
          />
        </Card>
      </Col>
    </Row>
  )
}

// ─── Explain 面板（v1.1：ExplainWorkbench 可视化工作台）────

const ExplainPanel: React.FC<{
  result: ExplainResult | null
  loading: boolean
}> = ({ result, loading }) => {
  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}><Spin tip="执行 EXPLAIN..." /></div>
  if (!result)  return null

  if (!result.success) {
    return (
      <Alert type="error" showIcon message="EXPLAIN 执行失败" description={result.errorMessage} />
    )
  }

  return <ExplainWorkbench result={result} />
}

// ─── Advice 面板 ────────────────────────────────────────

const AdvicePanel: React.FC<{
  advices: Advice[]
  loading: boolean
  hasExplain: boolean  // 是否已纳入 EXPLAIN 执行计划分析
}> = ({ advices, loading, hasExplain }) => {
  if (loading) return <Spin tip="生成诊断建议..." style={{ padding: 24 }} />
  if (advices.length === 0) return (
    <Empty description="暂无诊断建议（SQL 看起来不错）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 诊断层次提示 */}
      <Alert
        type={hasExplain ? 'success' : 'info'}
        showIcon={false}
        style={{ fontSize: 11, padding: '4px 10px', marginBottom: 4 }}
        message={
          hasExplain
            ? '✅ 已纳入 EXPLAIN 执行计划分析（包含 N+1、全表扫等执行层分析）'
            : '⚠️ 当前为基础文本分析，得击「执行 EXPLAIN」可获取执行计划级深度诊断（N+1、全表扫等）'
        }
      />
      {advices.map((a, i) => {
        const cfg = adviceLevelConfig[a.level] ?? adviceLevelConfig.INFO
        return (
          <Alert
            key={i}
            type={cfg.color}
            showIcon
            icon={cfg.icon}
            message={
              <Space>
                <Text strong>{a.title}</Text>
                <Tag style={{ fontSize: 10 }}>{a.category}</Tag>
              </Space>
            }
            description={
              <div style={{ fontSize: 12 }}>
                <div><Text type="secondary">触发依据：</Text>{a.trigger}</div>
                <div style={{ marginTop: 4 }}><Text type="secondary">建议：</Text>{a.suggestion}</div>
              </div>
            }
          />
        )
      })}
    </div>
  )
}

// ─── 详情抽屉 ────────────────────────────────────────────

const SlowQueryDetailDrawer: React.FC<{
  open: boolean
  onClose: () => void
  digest: SlowQueryDigestItem | null
  connectionId: string
  capability: SlowQueryCapability | null
}> = ({ open, onClose, digest, connectionId, capability }) => {
  const { token } = theme.useToken()
  const [samples, setSamples] = useState<SlowQuerySample[]>([])
  const [loadingSamples, setLoadingSamples] = useState(false)
  const [selectedSql, setSelectedSql] = useState<string | null>(null)
  const [explainResult, setExplainResult] = useState<ExplainResult | null>(null)
  const [loadingExplain, setLoadingExplain] = useState(false)
  const [advices, setAdvices] = useState<Advice[]>([])
  const [loadingAdvice, setLoadingAdvice] = useState(false)
  const [activePanelKey, setActivePanelKey] = useState<'explain' | 'advice'>('explain')

  // 获取样本数据库名（从 digest 的 databaseName 或回退）
  const dbName = digest?.databaseName ?? ''

  useEffect(() => {
    if (!open || !digest) return
    setSamples([])
    setSelectedSql(null)
    setExplainResult(null)
    setAdvices([])

    setLoadingSamples(true)
    slowQueryApi.getSamples(connectionId, digest.digest).then(data => {
      setSamples(data)
      // 自动选中第一个有完整 SQL 的样本
      const first = data.find(s => s.sqlText && s.sqlText.trim())
      if (first?.sqlText) setSelectedSql(first.sqlText)
    }).catch(e => {
      message.error(`获取样本失败: ${e.message}`)
    }).finally(() => setLoadingSamples(false))
  }, [open, digest, connectionId])

  const handleExplain = async () => {
    if (!selectedSql || !digest) return
    setLoadingExplain(true)
    setExplainResult(null)
    try {
      const result = await slowQueryApi.explain({
        connectionId,
        database: dbName,
        sql: selectedSql,
        format: capability?.explainJsonAvailable ? 'JSON' : 'TEXT',
      })
      setExplainResult(result)
      // EXPLAIN 完成后，若已有诊断数据，自动用新 explainResult 刷新运行规则诊断
      if (advices.length > 0) {
        doAdvise(result)
      }
    } catch (e: any) {
      message.error(`EXPLAIN 失败: ${e.message}`)
    } finally {
      setLoadingExplain(false)
    }
  }

  // 规则诊断核心函数：接受显式 explainResult（无需等待 state 更新）
  const doAdvise = async (latestExplain: ExplainResult | null = explainResult) => {
    if (!selectedSql) return
    setLoadingAdvice(true)
    setAdvices([])
    try {
      const result = await slowQueryApi.advise({
        connectionId,
        database: dbName,
        sql: selectedSql,
        explainResult: latestExplain ?? undefined,
      })
      setAdvices(result)
    } catch (e: any) {
      message.error(`诊断分析失败: ${e.message}`)
    } finally {
      setLoadingAdvice(false)
    }
  }

  const handleAdvise = () => doAdvise(explainResult)

  if (!digest) return null

  return (
    <Drawer
      title={
        <Space>
          <DatabaseOutlined />
          <Text strong>慢查询详情</Text>
          {digest.databaseName && <Tag>{digest.databaseName}</Tag>}
        </Space>
      }
      width={760}
      open={open}
      onClose={onClose}
      destroyOnClose
      styles={{ body: { padding: '16px', overflowY: 'auto' } }}
    >
      {/* SQL 指纹 */}
      <Card
        size="small"
        title={<Text strong><CodeOutlined style={{ marginRight: 6 }} />SQL 指纹（Digest）</Text>}
        style={{ marginBottom: 16 }}
        bodyStyle={{ padding: 12 }}
      >
        <pre style={{
          background: 'rgba(0,0,0,0.2)',
          border: `1px solid ${token.colorBorder}`,
          borderRadius: 8,
          padding: 10,
          fontSize: 12,
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          margin: 0,
          maxHeight: 120,
          overflow: 'auto',
        }}>
          {digest.sqlFingerprint}
        </pre>

        {/* 指标行 */}
        <Row gutter={16} style={{ marginTop: 10 }}>
          {[
            { label: '执行次数', value: fmtNum(digest.execCount) },
            { label: '平均耗时', value: fmtMs(digest.avgLatencyMs), warn: digest.avgLatencyMs > 1000 },
            { label: '最大耗时', value: fmtMs(digest.maxLatencyMs), warn: digest.maxLatencyMs > 5000 },
            { label: '扫描行数', value: fmtNum(digest.rowsExamined) },
            { label: '无索引次数', value: fmtNum(digest.noIndexCount), warn: digest.noIndexCount > 0 },
          ].map(({ label, value, warn }) => (
            <Col key={label} span={8} style={{ marginBottom: 6 }}>
              <Space direction="vertical" size={0}>
                <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
                <Text style={{ fontWeight: 600, color: warn ? '#ff4d4f' : 'inherit' }}>{value}</Text>
              </Space>
            </Col>
          ))}
        </Row>
      </Card>

      {/* 样本 SQL */}
      <Card
        size="small"
        title={
          <Space>
            <Text strong>最近执行样本 SQL</Text>
            {loadingSamples && <Spin size="small" />}
            <Text type="secondary" style={{ fontSize: 11 }}>（点击样本以选择用于 EXPLAIN）</Text>
          </Space>
        }
        style={{ marginBottom: 16 }}
        bodyStyle={{ padding: 12 }}
      >
        {samples.length === 0 && !loadingSamples ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div style={{ textAlign: 'left', maxWidth: 420, margin: '0 auto' }}>
                {capability?.historyAvailable === false ? (
                  <>
                    <Text type="secondary">⚠️ <code>events_statements_history_long</code> consumer 未开启，无法捕获样本 SQL。</Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 11 }}>执行以下 SQL 后重新探测：</Text>
                    <pre style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 6, padding: '4px 8px', fontSize: 11, marginTop: 4 }}>
                      {`UPDATE performance_schema.setup_consumers\nSET ENABLED='YES'\nWHERE NAME='events_statements_history_long';`}
                    </pre>
                  </>
                ) : (
                  <>
                    <Text type="secondary">此 Digest 在 <code>history_long</code> 中暂无样本，可能原因：</Text>
                    <ul style={{ margin: '6px 0 6px 16px', padding: 0, fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
                      <li>该 SQL 在 <code>history_long consumer</code> 开启之前执行，未被记录</li>
                      <li>环形缓冲已被新查询覆盖（默认保留最近 10,000 条）</li>
                    </ul>
                    <Text type="secondary" style={{ fontSize: 12 }}>👉 重新执行一次该 SQL，再点「详情」即可获取样本</Text>
                  </>
                )}
              </div>
            }
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {samples.map((sample, i) => {
              const isSelected = selectedSql === sample.sqlText
              const hasSql = !!sample.sqlText
              return (
                <div
                  key={i}
                  onClick={() => hasSql && setSelectedSql(sample.sqlText!)}
                  style={{
                    border: `1px solid ${isSelected ? token.colorPrimary : token.colorBorder}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    cursor: hasSql ? 'pointer' : 'not-allowed',
                    background: isSelected ? 'rgba(124,58,237,0.12)' : 'transparent',
                    transition: 'all 0.2s',
                    opacity: hasSql ? 1 : 0.5,
                  }}
                >
                  <Space style={{ fontSize: 11 }}>
                    <Tag color="blue">{fmtMs(sample.latencyMs)}</Tag>
                    {sample.rowsExamined != null && (
                      <Text type="secondary">扫描 {fmtNum(sample.rowsExamined)} 行</Text>
                    )}
                    {sample.mayBeTruncated && (
                      <Tooltip title="SQL 文本可能被 performance_schema 截断，EXPLAIN 结果仅供参考">
                        <Tag color="orange" style={{ fontSize: 10 }}>可能截断</Tag>
                      </Tooltip>
                    )}
                  </Space>
                  <pre style={{
                    margin: '4px 0 0',
                    fontSize: 11,
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    color: hasSql ? 'inherit' : '#8c8c8c',
                  }}>
                    {sample.sqlText ?? '（SQL 文本不可用）'}
                  </pre>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* Explain + Advice 操作区 */}
      <Card
        size="small"
        title={
          <Space>
            <Segmented
              value={activePanelKey}
              onChange={v => {
                const next = v as 'explain' | 'advice'
                setActivePanelKey(next)
                // 切换到「规则诊断」Tab 时，若还没有诊断数据则自动触发生成
                if (next === 'advice' && advices.length === 0 && selectedSql) {
                  handleAdvise()
                }
              }}
              options={[
                { label: 'EXPLAIN 分析', value: 'explain', icon: <EyeOutlined /> },
                { label: '规则诊断', value: 'advice', icon: <BulbOutlined /> },
              ]}
            />
            {/* EXPLAIN 分析 Tab：执行按钮 */}
            {activePanelKey === 'explain' && (
              <Button
                size="small"
                type="primary"
                icon={<EyeOutlined />}
                disabled={!selectedSql || !capability?.explainAvailable}
                loading={loadingExplain}
                onClick={handleExplain}
              >
                执行 EXPLAIN
              </Button>
            )}
            {/* 规则诊断 Tab：只在有数据时提供「重新诊断」小按钮（自动触发，无需主动操作）*/}
            {activePanelKey === 'advice' && advices.length > 0 && !loadingAdvice && (
              <Button
                size="small"
                type="text"
                icon={<BulbOutlined />}
                disabled={!selectedSql}
                onClick={handleAdvise}
                style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}
              >
                重新诊断
              </Button>
            )}
            {!capability?.explainAvailable && (
              <Tooltip title="当前连接不支持 EXPLAIN">
                <Tag color="orange">EXPLAIN 不可用</Tag>
              </Tooltip>
            )}
            {!selectedSql && (
              <Text type="secondary" style={{ fontSize: 11 }}>请先在上方选择一条样本 SQL</Text>
            )}
          </Space>
        }
        bodyStyle={{ padding: 16 }}
      >
        {activePanelKey === 'explain' ? (
          <ExplainPanel result={explainResult} loading={loadingExplain} />
        ) : (
          <AdvicePanel advices={advices} loading={loadingAdvice} hasExplain={!!explainResult} />
        )}
      </Card>
    </Drawer>
  )
}

// ─── 主页面 ──────────────────────────────────────────────

export const SlowQueryPage: React.FC = () => {
  const { token } = theme.useToken()

  // 连接与能力状态
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [selectedConnId, setSelectedConnId] = useState<string>('')
  const [capability, setCapability] = useState<SlowQueryCapability | null>(null)
  const [checkingCap, setCheckingCap] = useState(false)

  // 查询参数
  const [databaseName, setDatabaseName] = useState<string>('')
  const [minLatencyMs, setMinLatencyMs] = useState<number | null>(100)
  const [hasNoIndex, setHasNoIndex] = useState<boolean | null>(null)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [sortBy, setSortBy] = useState<SlowQuerySortField>('AVG_LATENCY')
  const [sortOrder] = useState<SortOrder>('DESC')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)

  // 查询结果
  const [digestPage, setDigestPage] = useState<SlowQueryDigestPage | null>(null)
  const [loading, setLoading] = useState(false)

  // 详情抽屉
  const [selectedDigest, setSelectedDigest] = useState<SlowQueryDigestItem | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // 数据库列表状态
  const [databases, setDatabases] = useState<string[]>([])
  const [loadingDatabases, setLoadingDatabases] = useState(false)

  // ── 加载连接列表
  useEffect(() => {
    connectionApi.list().then(data => setConnections(data as ConnectionConfig[])).catch(console.error)
  }, [])

  // ── 选择连接：自动建立连接 + 加载数据库列表 + 能力探测
  const handleConnectionChange = async (connId: string) => {
    setSelectedConnId(connId)
    setDigestPage(null)
    setCapability(null)
    setDatabases([])
    setDatabaseName('')

    if (!connId) return

    // 如果连接未建立，自动 open
    const conn = connections.find(c => c.id === connId)
    if (conn?.status !== 'connected') {
      try {
        await connectionApi.open(connId)
        message.success(`已连接到「${conn?.name ?? connId}」`)
        // 不需要更新有状态的 store，居中转发上寄寄可自动重连
      } catch (e: any) {
        message.error(`连接失败: ${e.message}`)
        return
      }
    }

    // 并发：加载数据库列表 + 能力探测
    setCheckingCap(true)
    setLoadingDatabases(true)
    try {
      const [dbs, cap] = await Promise.all([
        metadataApi.databases(connId).catch(() => []),
        slowQueryApi.getStatus(connId),
      ])
      setDatabases((dbs as DatabaseInfo[]).map(d => d.name).filter(Boolean))
      setCapability(cap)
    } catch (e: any) {
      message.error(`能力探测失败: ${e.message}`)
    } finally {
      setCheckingCap(false)
      setLoadingDatabases(false)
    }
  }

  // 重新探测（保留给「重新探测」按钮）
  const checkCapability = useCallback(async (connId: string) => {
    if (!connId) return
    setCheckingCap(true)
    setCapability(null)
    setDigestPage(null)
    try {
      const cap = await slowQueryApi.getStatus(connId)
      setCapability(cap)
    } catch (e: any) {
      message.error(`能力探测失败: ${e.message}`)
    } finally {
      setCheckingCap(false)
    }
  }, [])

  // ── 查询 Digest 列表
  const queryDigests = useCallback(async (currentPage = 1) => {
    if (!selectedConnId || !capability?.digestSummaryAvailable) return
    setLoading(true)
    try {
      const req: SlowQueryQueryRequest = {
        connectionId: selectedConnId,
        databaseName: databaseName || null,
        minLatencyMs: minLatencyMs,
        hasNoIndex: hasNoIndex,
        searchKeyword: searchKeyword || null,
        sortBy,
        sortOrder,
        page: currentPage,
        pageSize,
      }
      const result = await slowQueryApi.queryDigests(req)
      setDigestPage(result)
      setPage(currentPage)
    } catch (e: any) {
      message.error(`查询失败: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [selectedConnId, capability, databaseName, minLatencyMs, hasNoIndex, searchKeyword, sortBy, sortOrder, pageSize])

  // ── 表格列定义
  const columns = [
    {
      title: 'SQL 指纹',
      dataIndex: 'sqlFingerprint',
      ellipsis: true,
      render: (text: string) => (
        <Tooltip title={text} placement="topLeft">
          <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{text}</Text>
        </Tooltip>
      ),
    },
    {
      title: '数据库',
      dataIndex: 'databaseName',
      width: 150,
      ellipsis: true,
      render: (v: string | null) => v
        ? <Tooltip title={v}><Tag style={{ fontSize: 11, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</Tag></Tooltip>
        : <Text type="secondary">—</Text>,
    },
    {
      title: '执行次数',
      dataIndex: 'execCount',
      width: 95,
      sorter: true,
      render: (v: number) => fmtNum(v),
    },
    {
      title: '平均耗时',
      dataIndex: 'avgLatencyMs',
      width: 105,
      defaultSortOrder: 'descend' as const,
      sorter: true,
      render: (v: number) => (
        <Text style={{ color: v > 1000 ? '#ff4d4f' : v > 200 ? '#fa8c16' : 'inherit', fontWeight: 600 }}>
          {fmtMs(v)}
        </Text>
      ),
    },
    {
      title: '最大耗时',
      dataIndex: 'maxLatencyMs',
      width: 105,
      sorter: true,
      render: (v: number) => <Text style={{ color: v > 5000 ? '#ff4d4f' : 'inherit' }}>{fmtMs(v)}</Text>,
    },
    {
      title: '扫描行数',
      dataIndex: 'rowsExamined',
      width: 95,
      sorter: false,
      render: (v: number) => <Text style={{ color: v > 100000 ? '#ff4d4f' : 'inherit' }}>{fmtNum(v)}</Text>,
    },
    {
      title: '无索引',
      dataIndex: 'noIndexCount',
      width: 85,
      render: (v: number) => v > 0
        ? <Tag color="red" style={{ fontSize: 11 }}>{fmtNum(v)}</Tag>
        : <Tag color="green" style={{ fontSize: 11 }}>0</Tag>,
    },
    {
      title: '操作',
      width: 80,
      render: (_: any, record: SlowQueryDigestItem) => (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => { setSelectedDigest(record); setDrawerOpen(true) }}
        >
          详情
        </Button>
      ),
    },
  ]

  const canQuery = !!selectedConnId && !!capability?.digestSummaryAvailable

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflow: 'auto' }}>
      {/* 页面标题 */}
      <div style={{ marginBottom: 16 }}>
        <Space align="center">
          <ThunderboltOutlined style={{ color: token.colorPrimary, fontSize: 20 }} />
          <Text strong style={{ fontSize: 18 }}>慢查询分析</Text>
          <Tag color="purple">performance_schema</Tag>
          {capability && (
            <Badge
              status={capability.performanceSchemaEnabled ? 'success' : 'error'}
              text={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {capability.performanceSchemaEnabled ? 'P_S 已开启' : 'P_S 未开启'}
                </Text>
              }
            />
          )}
        </Space>
      </div>

      {/* 连接选择 + 控制栏 */}
      <Card
        size="small"
        style={{ marginBottom: 16, background: 'rgba(255,255,255,0.04)' }}
        bodyStyle={{ padding: '12px 16px' }}
      >
        <Space wrap>
          <Select
            placeholder="选择数据库连接"
            style={{ width: 240 }}
            value={selectedConnId || undefined}
            onChange={v => handleConnectionChange(v ?? '')}
            onClear={() => handleConnectionChange('')}
            options={connections.map(c => ({
              value: c.id,
              label: (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                  {c.status !== 'connected' && (
                    <span style={{ fontSize: 10, color: '#8c8c8c', flexShrink: 0 }}>未连</span>
                  )}
                </div>
              )
            }))}
            loading={checkingCap}
            allowClear
          />

          <Divider type="vertical" />

          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>数据库</Text>
            <Select
              placeholder="可选，留空查全部"
              style={{ width: 160 }}
              value={databaseName || undefined}
              onChange={v => setDatabaseName(v ?? '')}
              onClear={() => setDatabaseName('')}
              options={databases.map(db => ({ value: db, label: db }))}
              disabled={!selectedConnId}
              loading={loadingDatabases}
              allowClear
              showSearch
            />
          </Space>

          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>最低耗时</Text>
            <InputNumber
              placeholder="ms"
              style={{ width: 100 }}
              min={0}
              value={minLatencyMs ?? undefined}
              onChange={v => setMinLatencyMs(v ?? null)}
              addonAfter="ms"
            />
          </Space>

          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>仅无索引</Text>
            <Switch
              size="small"
              checked={hasNoIndex === true}
              onChange={v => setHasNoIndex(v ? true : null)}
            />
          </Space>

          <Input.Search
            placeholder="关键词搜索"
            style={{ width: 180 }}
            value={searchKeyword}
            onChange={e => setSearchKeyword(e.target.value)}
            onSearch={() => queryDigests(1)}
            allowClear
          />

          <Select
            style={{ width: 130 }}
            value={sortBy}
            onChange={v => setSortBy(v)}
            options={[
              { value: 'AVG_LATENCY',   label: '按平均耗时' },
              { value: 'MAX_LATENCY',   label: '按最大耗时' },
              { value: 'TOTAL_LATENCY', label: '按总耗时' },
              { value: 'EXEC_COUNT',    label: '按执行次数' },
            ]}
          />

          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={loading}
            disabled={!canQuery}
            onClick={() => queryDigests(1)}
          >
            查询
          </Button>

          <Button
            icon={<ReloadOutlined />}
            loading={checkingCap}
            disabled={!selectedConnId}
            onClick={() => checkCapability(selectedConnId)}
          >
            重新探测
          </Button>
        </Space>
      </Card>

      {/* 能力横幅 */}
      {capability && <CapabilityBanner capability={capability} />}

      {/* 统计卡片 */}
      {(digestPage || loading) && (
        <StatisticsRow page={digestPage} loading={loading} />
      )}

      {/* Digest 列表 */}
      <Card
        size="small"
        style={{ background: 'rgba(255,255,255,0.04)' }}
        bodyStyle={{ padding: 0 }}
      >
        <Table
          dataSource={digestPage?.items ?? []}
          columns={columns}
          rowKey="digest"
          loading={loading}
          size="small"
          scroll={{ x: 980 }}
          pagination={{
            current: page,
            pageSize,
            total: digestPage?.total ?? 0,
            showSizeChanger: false,
            showQuickJumper: true,
            showTotal: (total) => `共 ${fmtNum(total)} 个 Digest`,
            onChange: (p) => queryDigests(p),
          }}
          locale={{
            emptyText: selectedConnId && capability?.digestSummaryAvailable
              ? <Empty description="暂无慢查询数据，请尝试调整筛选条件" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              : <Empty description={selectedConnId ? '正在加载...' : '请先选择数据库连接'} image={Empty.PRESENTED_IMAGE_SIMPLE} />,
          }}
          onRow={record => ({
            onClick: () => { setSelectedDigest(record); setDrawerOpen(true) },
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      {/* 详情抽屉 */}
      <SlowQueryDetailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        digest={selectedDigest}
        connectionId={selectedConnId}
        capability={capability}
      />
    </div>
  )
}
