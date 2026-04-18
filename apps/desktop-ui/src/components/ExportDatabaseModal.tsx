import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Result,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd'
import {
  SettingOutlined, SyncOutlined, CheckCircleOutlined, DownloadOutlined, DatabaseOutlined
} from '@ant-design/icons'
import { metadataApi, exportApi, taskApi } from '@/services/api'
import type { ExportEstimateResult, TableInfo } from '@/types'
import { handleApiError, toast } from '@/utils/notification'
import { formatDuration, getElapsedMs } from '@/utils/format'

function formatSize(bytes: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface ExportDatabaseModalProps {
  open: boolean
  onClose: () => void
  connectionId: string
  connectionName: string
  database: string
}

interface ExportTableItem {
  key: string
  name: string
  comment?: string
  size: number
}

type ExportTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

interface ExportTaskInfo {
  progress?: number
  status: ExportTaskStatus
  progressMessage?: string
  startedAt?: string
  duration?: number
}

interface ExportTaskLog {
  timestamp: string
  level: string
  message: string
}

function parseStageMeta(message: string) {
  if (!message) return null

  const match = message.match(/: ([^(]+?) \((\d+)\/(\d+)(?:, 已处理 (\d+) 行)?\)/)
  if (!match) return null

  const [, tableName, currentIndexRaw, totalRaw, rowCountRaw] = match
  const currentIndex = Number(currentIndexRaw)
  const total = Number(totalRaw)
  const rowCount = rowCountRaw ? Number(rowCountRaw) : null
  const completedCount = message.startsWith('已完成表')
    ? currentIndex
    : Math.max(currentIndex - 1, 0)

  return {
    tableName: tableName.trim(),
    currentIndex,
    total,
    completedCount,
    rowCount,
  }
}

const { Text } = Typography
const LARGE_TABLE_THRESHOLD = 10 * 1024 * 1024

export default function ExportDatabaseModal({
  open, onClose, connectionId, connectionName, database
}: ExportDatabaseModalProps) {
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const exportContent = Form.useWatch('exportContent', form) ?? 'STRUCTURE_AND_DATA'
  const exportFormat = Form.useWatch('exportFormat', form) ?? 'SQL_ZIP'
  
  // -- Step State --
  const [currentStep, setCurrentStep] = useState(0) // 0: Config, 1: Processing, 2: Finished

  // -- Data Loading --
  const [tables, setTables] = useState<ExportTableItem[]>([])
  const [loading, setLoading] = useState(false)
  const [estimateLoading, setEstimateLoading] = useState(false)
  const [targetKeys, setTargetKeys] = useState<string[]>([])
  const [searchKeyword, setSearchKeyword] = useState('')
  const [tableFilter, setTableFilter] = useState<'all' | 'commented' | 'large'>('all')
  const [estimate, setEstimate] = useState<ExportEstimateResult | null>(null)

  // -- Task Tracking --
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskStatus, setTaskStatus] = useState<ExportTaskStatus>('pending')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [startedAt, setStartedAt] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [logs, setLogs] = useState<ExportTaskLog[]>([])
  const [pollRetryCount, setPollRetryCount] = useState(0)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const estimateSeqRef = useRef(0)
  const pollingRef = useRef(false)
  const latestLogMessage = logs.length > 0 ? logs[logs.length - 1].message : ''
  const stageMessage = progressMessage || latestLogMessage
  const stageMeta = parseStageMeta(stageMessage)
  const durationText = taskStatus === 'running' && startedAt
    ? formatDuration(getElapsedMs(startedAt))
    : duration != null
      ? formatDuration(duration)
      : ''
  const tableSizeMap = useMemo(
    () => new Map(tables.map((table) => [table.key, table.size])),
    [tables]
  )
  const filteredTables = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase()
    return tables.filter((table) => {
      const matchesKeyword = !keyword
        || table.name.toLowerCase().includes(keyword)
        || table.comment?.toLowerCase().includes(keyword)
      const matchesFilter = tableFilter === 'all'
        || (tableFilter === 'commented' && Boolean(table.comment))
        || (tableFilter === 'large' && table.size >= LARGE_TABLE_THRESHOLD)
      return matchesKeyword && matchesFilter
    })
  }, [searchKeyword, tableFilter, tables])
  const filteredTableKeys = useMemo(
    () => filteredTables.map((table) => table.key),
    [filteredTables]
  )
  const selectedCount = targetKeys.length
  const selectedSize = useMemo(
    () => targetKeys.reduce((sum, key) => sum + (tableSizeMap.get(key) ?? 0), 0),
    [tableSizeMap, targetKeys]
  )
  const selectedTables = useMemo(
    () => tables.filter((table) => targetKeys.includes(table.key)),
    [tables, targetKeys]
  )
  const selectedVisibleCount = useMemo(() => {
    const selectedSet = new Set(targetKeys)
    return filteredTableKeys.filter((key) => selectedSet.has(key)).length
  }, [filteredTableKeys, targetKeys])
  const selectedLargeTables = useMemo(
    () => selectedTables.filter((table) => table.size >= LARGE_TABLE_THRESHOLD),
    [selectedTables]
  )
  const topSelectedTables = estimate?.tables.slice(0, 3) ?? [...selectedTables].sort((a, b) => b.size - a.size).slice(0, 3).map((table) => ({
    tableName: table.name,
    estimatedBytes: table.size,
    estimatedRows: 0,
    progressUnits: 0,
    risk: table.size >= LARGE_TABLE_THRESHOLD ? 'medium' as const : 'low' as const,
  }))
  const selectionRatio = tables.length > 0 ? Math.round((selectedCount / tables.length) * 100) : 0
  const includesData = exportContent === 'DATA_ONLY' || exportContent === 'STRUCTURE_AND_DATA'
  const estimatedSize = estimate?.estimatedBytes ?? selectedSize
  const estimatedRows = estimate?.estimatedRows ?? 0
  const estimatedLargeTableCount = estimate?.largeTableCount ?? selectedLargeTables.length
  const riskLevel = estimatedLargeTableCount >= 3 || estimatedSize >= 200 * 1024 * 1024 ? 'high'
    : estimatedLargeTableCount > 0 || estimatedSize >= 50 * 1024 * 1024 ? 'medium'
      : 'low'
  const riskAlertType = riskLevel === 'high' ? 'warning' : riskLevel === 'medium' ? 'info' : 'success'
  const riskMessage = estimate?.warnings[0] ?? (
    !includesData
      ? '当前仅导出结构，执行速度通常会更快。'
      : riskLevel === 'high'
        ? `已选择 ${estimatedLargeTableCount} 张高负载表，且预计导出体积较大，建议预留更长时间。`
        : riskLevel === 'medium'
          ? `当前包含 ${estimatedLargeTableCount} 张较大表，导出数据时可能持续较久。`
          : '当前导出范围较轻量，通常适合直接执行。'
  )

  const columns: TableColumnsType<ExportTableItem> = [
    {
      title: '表名',
      dataIndex: 'name',
      key: 'name',
      render: (_, record) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Text strong ellipsis style={{ maxWidth: 260 }}>
              {record.name}
            </Text>
            {record.size >= LARGE_TABLE_THRESHOLD && <Tag color="orange">大表</Tag>}
          </div>
          <Text type="secondary" ellipsis style={{ display: 'block', marginTop: 2 }}>
            {record.comment || '无备注'}
          </Text>
        </div>
      ),
    },
    {
      title: '预计大小',
      dataIndex: 'size',
      key: 'size',
      width: 120,
      align: 'right',
      sorter: (a, b) => a.size - b.size,
      defaultSortOrder: 'ascend',
      render: (size: number) => (
        <Text type={size >= LARGE_TABLE_THRESHOLD ? 'warning' : undefined}>
          {formatSize(size)}
        </Text>
      ),
    },
  ]

  // 1. 初始化时加载所有表
  useEffect(() => {
    if (open && currentStep === 0) {
      loadTables()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentStep, connectionId, database])

  useEffect(() => {
    if (!open) {
      stopPolling()
    }
    return () => stopPolling()
  }, [open])

  useEffect(() => {
    if (!open || currentStep !== 0 || tables.length === 0) return
    if (targetKeys.length === 0) {
      setEstimate(null)
      setEstimateLoading(false)
      return
    }

    const requestId = ++estimateSeqRef.current
    const timer = setTimeout(async () => {
      setEstimateLoading(true)
      try {
        const result = await exportApi.estimate({
          connectionId,
          database,
          tables: targetKeys,
          exportContent,
          exportFormat,
        }) as ExportEstimateResult
        if (requestId === estimateSeqRef.current) {
          setEstimate(result)
        }
      } catch (error) {
        if (requestId === estimateSeqRef.current) {
          setEstimate(null)
        }
        console.warn('Estimate export payload failed', error)
      } finally {
        if (requestId === estimateSeqRef.current) {
          setEstimateLoading(false)
        }
      }
    }, 250)

    return () => clearTimeout(timer)
  }, [connectionId, currentStep, database, exportContent, exportFormat, open, tables.length, targetKeys])

  const loadTables = async () => {
    setLoading(true)
    try {
      const res = await metadataApi.objects(connectionId, database) as TableInfo[]
      const list = res
        .filter((item) => item.type !== 'trigger')
        .map((t) => ({
        key: t.name,
        name: t.name,
        comment: t.comment,
        size: t.dataLength || 0,
      })).sort((a, b) => a.name.localeCompare(b.name))
      setTables(list)
      setTargetKeys(list.map(t => t.key)) // 默认全选
    } catch (e: unknown) {
      handleApiError(e, '获取表列表失败')
    } finally {
      setLoading(false)
    }
  }

  // 2. 开始导出任务
  const handleStart = async () => {
    try {
      const values = await form.validateFields()
      if (targetKeys.length === 0) {
        toast.warning('请至少选择一张表进行导出')
        return
      }

      setLoading(true)
      const req = {
        connectionId,
        database,
        tables: targetKeys,
        exportContent: values.exportContent,
        exportFormat: values.exportFormat,
        addDropTable: values.addDropTable
      }

      const res = await exportApi.start(req) as { taskId: string }
      setTaskId(res.taskId)
      setCurrentStep(1)
      setTaskStatus('running')
      setProgress(0)
      setProgressMessage('')
      setStartedAt(null)
      setDuration(null)
      setPollRetryCount(0)
      setLogs([])

      // 启动轮询
      startPolling(res.taskId)
    } catch (e: unknown) {
      handleApiError(e, '启动导出失败')
    } finally {
      setLoading(false)
    }
  }

  // 3. 轮询任务状态
  const pollOnce = async (tid: string) => {
    if (pollingRef.current) return
    pollingRef.current = true
    try {
      const [taskInfo, taskLogs] = await Promise.all([
        taskApi.detail(tid) as Promise<ExportTaskInfo>,
        taskApi.logs(tid) as Promise<ExportTaskLog[]>
      ])
      setPollRetryCount(0)
      setProgress(taskInfo.progress ?? 0)
      setTaskStatus(taskInfo.status)
      setProgressMessage(taskInfo.progressMessage ?? '')
      setStartedAt(taskInfo.startedAt ?? null)
      setDuration(taskInfo.duration ?? null)
      setLogs(taskLogs || [])
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
      }
      if (taskInfo.status === 'completed' || taskInfo.status === 'failed' || taskInfo.status === 'cancelled') {
        stopPolling()
        if (taskInfo.status === 'completed') {
          setProgress(100)
          setCurrentStep(2)
        }
      }
    } catch (e) {
      setPollRetryCount((count) => {
        // A7: 超过 20 次连续失败则停止轮询，防止后端崩溃时僵尸轮询
        if (count + 1 >= 20) {
          stopPolling()
          console.error('Polling export task failed too many times, stopped.')
        }
        return count + 1
      })
      console.warn('Polling task failed, will retry', e)
    } finally {
      pollingRef.current = false
    }
  }

  // A7: 串行轮询 —— 上一次请求完成后再等 1.5s 发下一次，避免慢响应积压
  const startPolling = (tid: string) => {
    stopPolling()
    const poll = async () => {
      await pollOnce(tid)
      timerRef.current = setTimeout(() => void poll(), 1500) as unknown as ReturnType<typeof setInterval>
    }
    void poll()
  }

  const stopPolling = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    pollingRef.current = false
  }

  // 取消导出
  const handleAbort = async () => {
    if (!taskId) return
    try {
      await taskApi.cancel(taskId)
      stopPolling()
      toast.success('已发送取消信号')
      setTaskStatus('cancelled')
    } catch (e) {
      handleApiError(e, '中止任务失败')
    }
  }

  // 关闭时重置
  const handleClose = () => {
    stopPolling()
    estimateSeqRef.current += 1
    form.resetFields()
    setCurrentStep(0)
    setTaskStatus('pending')
    setProgress(0)
    setProgressMessage('')
    setStartedAt(null)
    setDuration(null)
    setPollRetryCount(0)
    setTaskId(null)
    setLogs([])
    setSearchKeyword('')
    setTableFilter('all')
    setEstimate(null)
    setEstimateLoading(false)
    setTargetKeys([])
    onClose()
  }

  const handleSelectAll = () => {
    setTargetKeys(tables.map((table) => table.key))
  }

  const handleSelectVisible = () => {
    setTargetKeys((prev) => {
      const selected = new Set(prev)
      filteredTableKeys.forEach((key) => selected.add(key))
      return tables.filter((table) => selected.has(table.key)).map((table) => table.key)
    })
  }

  const handleInvertVisible = () => {
    setTargetKeys((prev) => {
      const selected = new Set(prev)
      filteredTableKeys.forEach((key) => {
        if (selected.has(key)) selected.delete(key)
        else selected.add(key)
      })
      return tables.filter((table) => selected.has(table.key)).map((table) => table.key)
    })
  }

  return (
    <Modal
      title={(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text strong>导出数据库</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            来源连接：{connectionName} · 数据库：{database}
          </Text>
        </div>
      )}
      open={open}
      width={980}
      onCancel={handleClose}
      maskClosable={false}
      footer={
        currentStep === 0 ? (
          <Space>
            <Button onClick={handleClose}>取消</Button>
            <Button type="primary" onClick={handleStart} loading={loading} disabled={targetKeys.length === 0}>
              开始导出
            </Button>
          </Space>
        ) : currentStep === 1 ? (
          <Space>
            {taskStatus === 'running' && <Button danger onClick={handleAbort}>中止导出</Button>}
            {taskStatus !== 'running' && <Button onClick={handleClose}>关闭</Button>}
          </Space>
        ) : (
          <Button type="primary" onClick={handleClose}>完成</Button>
        )
      }
    >
      <div style={{ padding: '8px 0' }}>
        {/* 顶部说明 */}
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="导出为 SQL/ZIP 文件，适用于查看、交付和兼容处理。导出文件不等同于标准备份包。"
        />

        <Steps
          size="small"
          current={currentStep}
          style={{ marginBottom: 24, padding: '0 40px' }}
          items={[
            { title: '导出选项', icon: <SettingOutlined /> },
            { title: '执行导出', icon: currentStep === 1 && taskStatus === 'running' ? <SyncOutlined spin /> : <DatabaseOutlined /> },
            { title: '导出结果', icon: <CheckCircleOutlined /> },
          ]}
        />

        {currentStep === 0 && (
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              exportContent: 'STRUCTURE_AND_DATA',
              exportFormat: 'SQL_ZIP',
              addDropTable: true
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 16 }}>
              <div
                style={{
                  minWidth: 0,
                  border: '1px solid var(--glass-border)',
                  borderRadius: token.borderRadiusLG,
                  background: 'var(--glass-panel)',
                  backdropFilter: 'var(--glass-blur-sm)',
                  padding: 16,
                }}
              >
                <div style={{ marginBottom: 16 }}>
                  <Text strong style={{ display: 'block', marginBottom: 4 }}>
                    选择要导出的表
                  </Text>
                  <Text type="secondary">
                    默认已全选全部 {tables.length} 张表，你可以搜索并取消不需要导出的对象。
                  </Text>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    alignItems: 'center',
                    marginBottom: 12,
                  }}
                >
                  <Input.Search
                    allowClear
                    placeholder="搜索表名或备注"
                    value={searchKeyword}
                    onChange={(event) => setSearchKeyword(event.target.value)}
                    style={{ flex: '1 1 260px', minWidth: 220 }}
                  />
                  <Select
                    value={tableFilter}
                    onChange={setTableFilter}
                    style={{ width: 140 }}
                    options={[
                      { label: '全部表', value: 'all' },
                      { label: '仅大表', value: 'large' },
                      { label: '有备注', value: 'commented' },
                    ]}
                  />
                  <Button size="small" onClick={handleSelectAll}>全选全部</Button>
                  <Button size="small" onClick={handleSelectVisible} disabled={filteredTableKeys.length === 0}>
                    选中可见项
                  </Button>
                  <Button size="small" onClick={handleInvertVisible} disabled={filteredTableKeys.length === 0}>
                    反选可见项
                  </Button>
                  <Button size="small" onClick={() => setTargetKeys([])} disabled={targetKeys.length === 0}>
                    清空
                  </Button>
                </div>

                <Space size={[8, 8]} wrap style={{ marginBottom: 12 }}>
                  <Tag color="blue">显示 {filteredTables.length} / {tables.length}</Tag>
                  <Tag color={selectedCount > 0 ? 'processing' : 'default'}>已选 {selectedCount} 张表</Tag>
                  <Tag>当前筛选中已选 {selectedVisibleCount} 张</Tag>
                  {selectedLargeTables.length > 0 && <Tag color="orange">大表 {selectedLargeTables.length} 张</Tag>}
                </Space>

                <Table<ExportTableItem>
                  rowKey="key"
                  size="small"
                  loading={loading}
                  dataSource={filteredTables}
                  columns={columns}
                  pagination={false}
                  scroll={{ y: 360 }}
                  rowSelection={{
                    selectedRowKeys: targetKeys,
                    onChange: (keys) => setTargetKeys(keys as string[]),
                    preserveSelectedRowKeys: true,
                  }}
                  locale={{
                    emptyText: (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={searchKeyword || tableFilter !== 'all' ? '没有匹配的表' : '暂无可导出表'}
                      />
                    ),
                  }}
                />
              </div>

              <Card
                title="导出摘要"
                size="small"
                loading={estimateLoading && selectedCount > 0}
                style={{
                  borderColor: 'var(--glass-border)',
                  background: 'var(--glass-panel)',
                  backdropFilter: 'var(--glass-blur-sm)',
                }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div
                    style={{
                      padding: 12,
                      borderRadius: token.borderRadius,
                      background: token.colorPrimaryBg,
                    }}
                  >
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>已选表数</Text>
                    <Text strong style={{ fontSize: 24, lineHeight: 1 }}>{selectedCount}</Text>
                  </div>
                  <div
                    style={{
                      padding: 12,
                      borderRadius: token.borderRadius,
                      background: token.colorFillAlter,
                    }}
                  >
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>预计体积</Text>
                    <Text strong style={{ fontSize: 24, lineHeight: 1 }}>{formatSize(estimatedSize)}</Text>
                  </div>
                  <div
                    style={{
                      padding: 12,
                      borderRadius: token.borderRadius,
                      background: token.colorFillAlter,
                    }}
                  >
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>预估行数</Text>
                    <Text strong style={{ fontSize: 20, lineHeight: 1 }}>
                      {estimatedRows > 0 ? estimatedRows.toLocaleString() : '-'}
                    </Text>
                  </div>
                  <div
                    style={{
                      padding: 12,
                      borderRadius: token.borderRadius,
                      background: token.colorFillAlter,
                    }}
                  >
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>高负载表</Text>
                    <Text strong style={{ fontSize: 20, lineHeight: 1 }}>{estimatedLargeTableCount}</Text>
                  </div>
                </div>

                <div style={{ marginTop: 12, marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text type="secondary">覆盖范围</Text>
                    <Text>{selectionRatio}%</Text>
                  </div>
                  <Progress
                    percent={selectionRatio}
                    size="small"
                    strokeColor={selectedCount === 0 ? token.colorBorder : token.colorPrimary}
                    showInfo={false}
                  />
                </div>

                <Space size={[8, 8]} wrap style={{ marginBottom: 12 }}>
                  <Tag color="blue">{exportContent === 'STRUCTURE_AND_DATA' ? '结构 + 数据' : exportContent === 'STRUCTURE_ONLY' ? '仅结构' : '仅数据'}</Tag>
                  <Tag>{exportFormat === 'SQL_ZIP' ? 'SQL ZIP' : 'CSV ZIP'}</Tag>
                  {includesData && <Tag color={riskLevel === 'high' ? 'error' : riskLevel === 'medium' ? 'warning' : 'success'}>数据导出</Tag>}
                </Space>

                <Divider style={{ margin: '16px 0' }} />

                <Form.Item name="exportContent" label="导出内容">
                  <Select
                    options={[
                      { label: '结构和数据', value: 'STRUCTURE_AND_DATA' },
                      { label: '仅结构', value: 'STRUCTURE_ONLY' },
                      { label: '仅数据', value: 'DATA_ONLY' },
                    ]}
                  />
                </Form.Item>

                <Form.Item name="exportFormat" label="导出格式">
                  <Select
                    options={[
                      { label: 'SQL 转储压缩包 (.sql.zip)', value: 'SQL_ZIP' },
                      { label: 'CSV 数据合集压缩包 (.csv.zip)', value: 'CSV_ZIP' },
                    ]}
                  />
                </Form.Item>

                <Form.Item noStyle dependencies={['exportFormat', 'exportContent']}>
                  {() => {
                    const format = form.getFieldValue('exportFormat')
                    const content = form.getFieldValue('exportContent')
                    if (format === 'SQL_ZIP' && content !== 'DATA_ONLY') {
                      return (
                        <Form.Item name="addDropTable" valuePropName="checked" style={{ marginBottom: 12 }}>
                          <Checkbox>添加 DROP TABLE IF EXISTS</Checkbox>
                        </Form.Item>
                      )
                    }
                    return null
                  }}
                </Form.Item>

                <Alert
                  type={riskAlertType}
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={estimateLoading ? '正在计算导出负载…' : includesData ? '导出负载评估' : '执行提示'}
                  description={riskMessage}
                />

                {topSelectedTables.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <Text strong style={{ display: 'block', marginBottom: 8 }}>
                      已选最大表
                    </Text>
                    <Space size={[8, 8]} wrap>
                      {topSelectedTables.map((table) => (
                        <Tag
                          key={table.tableName}
                          color={table.risk === 'high' ? 'error' : table.risk === 'medium' ? 'orange' : 'default'}
                        >
                          {table.tableName} · {formatSize(table.estimatedBytes)}
                          {table.estimatedRows > 0 ? ` · ${table.estimatedRows.toLocaleString()} 行` : ''}
                        </Tag>
                      ))}
                    </Space>
                  </div>
                )}

                <div
                  style={{
                    padding: 12,
                    borderRadius: token.borderRadius,
                    background: token.colorFillAlter,
                  }}
                >
                  <Text type=”secondary”>
                    导出适用于数据交换，不建议替代正式备份。
                  </Text>
                </div>
              </Card>
            </div>
          </Form>
        )}

        {currentStep === 1 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text strong>{taskStatus === 'running' ? '正在执行导出...' : taskStatus === 'failed' ? '导出失败' : taskStatus === 'cancelled' ? '导出已中止' : '即将完成'}</Text>
              <Text type="secondary">{progress}%</Text>
            </div>
            <Progress percent={progress} status={taskStatus === 'failed' ? 'exception' : taskStatus === 'cancelled' ? 'normal' : 'active'} />
            {durationText && (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">导出耗时：{durationText}</Text>
              </div>
            )}
            {stageMessage && (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">当前阶段：{stageMessage}</Text>
              </div>
            )}
            {(stageMeta || pollRetryCount > 0) && (
              <Space size={[8, 8]} wrap style={{ marginTop: 12 }}>
                {stageMeta && (
                  <>
                    <Tag color="blue">第 {stageMeta.currentIndex}/{stageMeta.total} 张表</Tag>
                    <Tag color="cyan">已完成 {stageMeta.completedCount} 张</Tag>
                    <Tag>{stageMeta.tableName}</Tag>
                    {stageMeta.rowCount != null && <Tag color="processing">已处理 {stageMeta.rowCount.toLocaleString()} 行</Tag>}
                  </>
                )}
                {pollRetryCount > 0 && (
                  <Tag color="warning">状态刷新重试中 × {pollRetryCount}</Tag>
                )}
              </Space>
            )}

            <div
              ref={logContainerRef}
              style={{
                marginTop: 24,
                height: 240,
                overflow: 'auto',
                background: token.colorFillAlter,
                borderRadius: token.borderRadius,
                padding: 12,
                fontFamily: token.fontFamilyCode || 'SFMono-Regular, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.6,
                border: '1px solid var(--glass-border)'
              }}
            >
              {logs.length === 0 && (
                <Text type="secondary" style={{ fontStyle: 'italic' }}>等待日志输出...</Text>
              )}
              {logs.map((log, i) => (
                <div key={i} style={{ whiteSpace: 'pre-wrap' }}>
                  <Text type="secondary" style={{ marginRight: 8 }}>[{log.timestamp}]</Text>
                  <Text type={log.level === 'ERROR' ? 'danger' : log.level === 'WARN' ? 'warning' : undefined}>
                    {log.message}
                  </Text>
                </div>
              ))}
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div>
            <Result
              status="success"
              title="导出完成"
              subTitle="导出文件已生成。"
              extra={[
                <Button type="primary" key="download" icon={<DownloadOutlined />} size="large" onClick={() => {
                  if (taskId) {
                    window.open(`http://localhost:18080/api/export/download/${taskId}`, '_blank')
                  }
                }}>
                  立即下载打包文件
                </Button>
              ]}
            />
            {logs.length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  height: 180,
                  overflow: 'auto',
                  background: token.colorFillAlter,
                  borderRadius: token.borderRadius,
                  padding: 12,
                  fontFamily: token.fontFamilyCode || 'SFMono-Regular, Consolas, monospace',
                  fontSize: 12,
                  lineHeight: 1.6,
                  border: '1px solid var(--glass-border)'
                }}
              >
                {logs.map((log, i) => (
                  <div key={i} style={{ whiteSpace: 'pre-wrap' }}>
                    <Text type="secondary" style={{ marginRight: 8 }}>[{log.timestamp}]</Text>
                    <Text type={log.level === 'ERROR' ? 'danger' : log.level === 'WARN' ? 'warning' : undefined}>
                      {log.message}
                    </Text>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
