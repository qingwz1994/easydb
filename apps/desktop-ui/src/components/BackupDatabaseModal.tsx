import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Alert, Button, Card, Checkbox, Form, Input, Modal, Progress,
  Result, Select, Space, Steps, Table, Tag, Typography, theme,
  type TableColumnsType,
} from 'antd'
import {
  SettingOutlined, SyncOutlined, CheckCircleOutlined,
  DatabaseOutlined, SaveOutlined, SearchOutlined, FolderOutlined,
} from '@ant-design/icons'
import { metadataApi, backupApi, taskApi } from '@/services/api'
import type { TableInfo } from '@/types'
import { handleApiError, toast } from '@/utils/notification'
import { formatDuration, getElapsedMs } from '@/utils/format'

const { Text } = Typography

function hasTauriInvoke(): boolean {
  if (typeof window === 'undefined') return false
  const candidate = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: unknown
    }
  }
  return typeof candidate.__TAURI_INTERNALS__?.invoke === 'function'
}

function formatSize(bytes: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

interface BackupDatabaseModalProps {
  open: boolean
  onClose: () => void
  connectionId: string
  connectionName: string
  database: string
}

interface TableItem {
  key: string
  name: string
  comment?: string
  rowCount: number
  size: number
}

interface BackupEstimate {
  database: string
  selectedTables: number
  estimatedRows: number
  estimatedBytes: number
  largeTableCount: number
  warnings?: string[]
}

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

interface TaskLog {
  timestamp: string
  level: string
  message: string
}

interface TaskDetail {
  progress?: number
  status: TaskStatus
  progressMessage?: string
  startedAt?: string
  duration?: number
  result?: {
    payload?: {
      filePath?: string
      fileName?: string
    }
  }
}

const columns: TableColumnsType<TableItem> = [
  {
    title: '表名',
    dataIndex: 'name',
    key: 'name',
    ellipsis: true,
    render: (name: string, record) => (
      <div>
        <Text strong style={{ fontSize: 13 }}>{name}</Text>
        {record.size > 50 * 1024 * 1024 && <Tag color="orange" style={{ marginLeft: 6 }}>大表</Tag>}
        {record.comment && (
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{record.comment}</Text>
        )}
      </div>
    ),
  },
  {
    title: '行数 (估)',
    dataIndex: 'rowCount',
    key: 'rowCount',
    width: 100,
    align: 'right',
    sorter: (a, b) => a.rowCount - b.rowCount,
    render: (v: number) => <Text style={{ fontSize: 12 }}>{v > 0 ? v.toLocaleString() : '—'}</Text>,
  },
  {
    title: '大小',
    dataIndex: 'size',
    key: 'size',
    width: 90,
    align: 'right',
    sorter: (a, b) => a.size - b.size,
    defaultSortOrder: 'descend',
    render: (v: number) => <Text style={{ fontSize: 12 }}>{formatSize(v)}</Text>,
  },
]

export default function BackupDatabaseModal({
  open, onClose, connectionId, connectionName, database
}: BackupDatabaseModalProps) {
  const { token } = theme.useToken()
  const [form] = Form.useForm()

  const [step, setStep] = useState(0)
  const [tables, setTables] = useState<TableItem[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [tableSearch, setTableSearch] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [estimate, setEstimate] = useState<BackupEstimate | null>(null)
  const [estimateLoading, setEstimateLoading] = useState(false)
  const estimateSeqRef = useRef(0)

  // Task tracking
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskStatus, setTaskStatus] = useState<TaskStatus>('pending')
  const [progress, setProgress] = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [startedAt, setStartedAt] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [logs, setLogs] = useState<TaskLog[]>([])
  const [resultFilePath, setResultFilePath] = useState<string | null>(null)
  const [resultFileName, setResultFileName] = useState<string | null>(null)
  const [pollRetry, setPollRetry] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollingRef = useRef(false)
  const logRef = useRef<HTMLDivElement>(null)

  const durationText = taskStatus === 'running' && startedAt
    ? formatDuration(getElapsedMs(startedAt))
    : duration != null ? formatDuration(duration) : ''

  // Load tables on open
  useEffect(() => {
    if (open && step === 0) {
      loadTables()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, connectionId, database])

  useEffect(() => {
    if (!open) stopPolling()
    return () => stopPolling()
  }, [open])

  // Auto-estimate when selection changes
  useEffect(() => {
    if (!open || step !== 0 || tables.length === 0) return
    if (selectedKeys.length === 0) { setEstimate(null); return }
    const seq = ++estimateSeqRef.current
    const t = setTimeout(async () => {
      setEstimateLoading(true)
      try {
        const mode = form.getFieldValue('mode') ?? 'full'
        const res = await backupApi.estimate({ connectionId, database, tables: selectedKeys, mode }) as BackupEstimate
        if (seq === estimateSeqRef.current) setEstimate(res)
      } catch { /* silent */ } finally {
        if (seq === estimateSeqRef.current) setEstimateLoading(false)
      }
    }, 300)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKeys, open, step, tables.length])

  const loadTables = async () => {
    setLoading(true)
    try {
      const res = await metadataApi.objects(connectionId, database) as TableInfo[]
      const list = res
        .filter(t => t.type === 'table')
        .map(t => ({
          key: t.name,
          name: t.name,
          comment: t.comment,
          rowCount: t.rowCount ?? 0,
          size: (t.dataLength ?? 0) + (t.indexLength ?? 0),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      setTables(list)
      setSelectedKeys(list.map(t => t.key))
    } catch (e) {
      handleApiError(e, '获取表列表失败')
    } finally {
      setLoading(false)
    }
  }

  const handlePickFolder = async () => {
    if (!hasTauriInvoke()) {
      toast.warning('当前环境未注入 Tauri Runtime，请直接输入目录路径')
      return
    }
    try {
      const result = await invoke<string | null>('pick_backup_folder')
      if (result) {
        setOutputPath(result)
      }
    } catch (e) {
      console.error('选择文件夹失败:', e)
      toast.error('选择文件夹失败: ' + (e as Error).message)
    }
  }

  const handleStart = async () => {
    if (selectedKeys.length === 0) { toast.warning('请至少选择一张表'); return }
    try {
      const values = await form.validateFields()
      setLoading(true)
      const req = {
        connectionId,
        database,
        mode: values.mode ?? 'full',
        tables: selectedKeys.length === tables.length ? [] : selectedKeys, // empty = all
        includeRoutines: values.includeRoutines ?? true,
        includeViews: values.includeViews ?? true,
        includeTriggers: values.includeTriggers ?? true,
        compression: 'gzip',
        outputPath: outputPath.trim() || undefined,
      }
      const res = await backupApi.start(req) as { taskId: string }
      setTaskId(res.taskId)
      setStep(1)
      setTaskStatus('running')
      setProgress(0)
      setProgressMsg('')
      setStartedAt(null)
      setDuration(null)
      setPollRetry(0)
      setLogs([])
      setResultFilePath(null)
      startPolling(res.taskId)
    } catch (e) {
      handleApiError(e, '启动备份失败')
    } finally {
      setLoading(false)
    }
  }

  const pollOnce = async (tid: string) => {
    if (pollingRef.current) return
    pollingRef.current = true
    try {
      const [info, taskLogs] = await Promise.all([
        taskApi.detail(tid) as Promise<TaskDetail>,
        taskApi.logs(tid) as Promise<TaskLog[]>,
      ])
      setPollRetry(0)
      setProgress(info.progress ?? 0)
      setTaskStatus(info.status)
      setProgressMsg(info.progressMessage ?? '')
      setStartedAt(info.startedAt ?? null)
      setDuration(info.duration ?? null)
      setLogs(taskLogs || [])
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      if (['completed', 'failed', 'cancelled'].includes(info.status)) {
        stopPolling()
        if (info.status === 'completed') {
          setProgress(100)
          setStep(2)
          setResultFilePath(info.result?.payload?.filePath ?? null)
          setResultFileName(info.result?.payload?.fileName ?? null)
        }
      }
    } catch {
      setPollRetry(c => {
        if (c + 1 >= 20) stopPolling()
        return c + 1
      })
    } finally {
      pollingRef.current = false
    }
  }

  const startPolling = (tid: string) => {
    stopPolling()
    const poll = async () => {
      await pollOnce(tid)
      timerRef.current = setTimeout(() => void poll(), 1500)
    }
    void poll()
  }

  const stopPolling = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    pollingRef.current = false
  }

  const handleAbort = async () => {
    if (!taskId) return
    try {
      await taskApi.cancel(taskId)
      stopPolling()
      setTaskStatus('cancelled')
      toast.success('已发送中止信号')
    } catch (e) { handleApiError(e, '中止任务失败') }
  }

  const handleClose = () => {
    stopPolling()
    estimateSeqRef.current++
    form.resetFields()
    setStep(0); setTaskStatus('pending'); setProgress(0)
    setProgressMsg(''); setStartedAt(null); setDuration(null)
    setPollRetry(0); setTaskId(null); setLogs([])
    setResultFilePath(null); setResultFileName(null)
    setEstimate(null); setEstimateLoading(false)
    setSelectedKeys([]); setTableSearch(''); setOutputPath('')
    onClose()
  }

  const statCardStyle = {
    padding: '10px 14px',
    borderRadius: token.borderRadius,
    background: token.colorFillAlter,
    minHeight: 64,
  }

  return (
    <Modal
      title={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Space>
            <SaveOutlined style={{ color: token.colorPrimary }} />
            <Text strong>备份数据库</Text>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>来源连接：{connectionName} · 数据库：{database}</Text>
        </div>
      }
      open={open}
      width={940}
      onCancel={handleClose}
      maskClosable={false}
      footer={
        step === 0 ? (
          <Space>
            <Button onClick={handleClose}>取消</Button>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleStart}
              loading={loading} disabled={selectedKeys.length === 0}>
              开始备份
            </Button>
          </Space>
        ) : step === 1 ? (
          <Space>
            {taskStatus === 'running' && <Button danger onClick={handleAbort}>中止备份</Button>}
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
          message="创建标准备份包，用于长期留存、变更前保护和后续恢复。备份包包含数据库结构、数据和校验信息。"
        />

        <Steps size="small" current={step} style={{ marginBottom: 24, padding: '0 40px' }}
          items={[
            { title: '备份选项', icon: <SettingOutlined /> },
            { title: '执行备份', icon: step === 1 && taskStatus === 'running' ? <SyncOutlined spin /> : <DatabaseOutlined /> },
            { title: '备份结果', icon: <CheckCircleOutlined /> },
          ]}
        />

        {/* ───── Step 0: Config ───── */}
        {step === 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 260px', gap: 16 }}>
            {/* Left: table selector */}
            <div style={{
              border: '1px solid var(--glass-border)', borderRadius: token.borderRadiusLG,
              background: 'var(--glass-panel)', backdropFilter: 'var(--glass-blur-sm)', padding: 16,
            }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>选择备份表范围</Text>
              <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
                默认全选。留空等同于整库备份（推荐）。
              </Text>
              <Space style={{ marginBottom: 8 }}>
                <Input.Search
                  placeholder="搜索表名"
                  allowClear
                  size="small"
                  style={{ width: 180 }}
                  prefix={<SearchOutlined />}
                  value={tableSearch}
                  onChange={e => setTableSearch(e.target.value)}
                />
                <Button size="small" onClick={() => setSelectedKeys(tables.map(t => t.key))}>全选</Button>
                <Button size="small" onClick={() => setSelectedKeys([])} disabled={selectedKeys.length === 0}>清空</Button>
                <Tag>{selectedKeys.length} / {tables.length} 张表</Tag>
              </Space>
              <Table<TableItem>
                rowKey="key"
                size="small"
                loading={loading}
                dataSource={tables.filter(t => !tableSearch || t.name.toLowerCase().includes(tableSearch.toLowerCase()))}
                columns={columns}
                pagination={false}
                scroll={{ y: 320 }}
                rowSelection={{
                  selectedRowKeys: selectedKeys,
                  onChange: keys => setSelectedKeys(keys as string[]),
                  preserveSelectedRowKeys: true,
                }}
              />
            </div>

            {/* Right: options + summary */}
            <Card title="备份选项" size="small" style={{
              borderColor: 'var(--glass-border)', background: 'var(--glass-panel)',
              backdropFilter: 'var(--glass-blur-sm)',
            }}>
              <Form form={form} layout="vertical" initialValues={{
                mode: 'full', includeRoutines: true, includeViews: true, includeTriggers: true,
              }}>
                <Form.Item name="mode" label="备份模式">
                  <Select options={[
                    { label: '结构 + 数据（完整备份）', value: 'full' },
                    { label: '仅结构', value: 'structure_only' },
                    { label: '仅数据', value: 'data_only' },
                  ]} />
                </Form.Item>
                <Form.Item label="输出目录">
                  <Space.Compact style={{ width: '100%' }}>
                    <Input
                      placeholder="默认: ~/.easydb/backups/"
                      value={outputPath}
                      onChange={e => setOutputPath(e.target.value)}
                      style={{ fontFamily: 'monospace' }}
                    />
                    <Button icon={<FolderOutlined />} onClick={handlePickFolder}>选择</Button>
                  </Space.Compact>
                  <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                    留空使用默认目录
                  </Text>
                </Form.Item>
                <Form.Item name="includeRoutines" valuePropName="checked">
                  <Checkbox>包含存储过程 / 函数</Checkbox>
                </Form.Item>
                <Form.Item name="includeViews" valuePropName="checked">
                  <Checkbox>包含视图</Checkbox>
                </Form.Item>
                <Form.Item name="includeTriggers" valuePropName="checked">
                  <Checkbox>包含触发器</Checkbox>
                </Form.Item>
              </Form>

              {/* Estimate summary */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                <div style={statCardStyle}>
                  <Text type="secondary" style={{ display: 'block', fontSize: 11 }}>已选表数</Text>
                  <Text strong style={{ fontSize: 22 }}>{selectedKeys.length}</Text>
                </div>
                <div style={statCardStyle}>
                  <Text type="secondary" style={{ display: 'block', fontSize: 11 }}>预估体积</Text>
                  <Text strong style={{ fontSize: 22 }}>
                    {estimateLoading ? '...' : estimate ? formatSize(estimate.estimatedBytes) : '—'}
                  </Text>
                </div>
                <div style={statCardStyle}>
                  <Text type="secondary" style={{ display: 'block', fontSize: 11 }}>预估行数</Text>
                  <Text strong style={{ fontSize: 18 }}>
                    {estimate ? estimate.estimatedRows.toLocaleString() : '—'}
                  </Text>
                </div>
                <div style={statCardStyle}>
                  <Text type="secondary" style={{ display: 'block', fontSize: 11 }}>大表数量</Text>
                  <Text strong style={{ fontSize: 18, color: estimate && estimate.largeTableCount > 0 ? token.colorWarning : undefined }}>
                    {estimate ? estimate.largeTableCount : '—'}
                  </Text>
                </div>
              </div>

              <Alert
                style={{ marginTop: 12 }}
                type="warning"
                showIcon
                message="建议在结构调整、批量更新或迁移前先执行完整备份。"
              />
            </Card>
          </div>
        )}

        {/* ───── Step 1: Running ───── */}
        {step === 1 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text strong>
                {taskStatus === 'running' ? '正在执行备份...'
                  : taskStatus === 'failed' ? '备份失败'
                  : taskStatus === 'cancelled' ? '备份已中止'
                  : '即将完成'}
              </Text>
              <Text type="secondary">{progress}%</Text>
            </div>
            <Progress
              percent={progress}
              status={taskStatus === 'failed' ? 'exception' : taskStatus === 'cancelled' ? 'normal' : 'active'}
            />
            {durationText && (
              <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>耗时：{durationText}</Text>
            )}
            {progressMsg && (
              <Text type="secondary" style={{ display: 'block', marginTop: 4 }}>当前阶段：{progressMsg}</Text>
            )}
            {pollRetry > 0 && <Tag color="warning" style={{ marginTop: 8 }}>状态刷新重试中 × {pollRetry}</Tag>}

            <div ref={logRef} style={{
              marginTop: 16, height: 220, overflow: 'auto',
              background: token.colorFillAlter, borderRadius: token.borderRadius, padding: 12,
              fontFamily: 'var(--font-family-code, monospace)', fontSize: 12,
            }}>
              {logs.length === 0
                ? <Text type="secondary">等待日志输出...</Text>
                : logs.map((log, i) => (
                  <div key={i} style={{ marginBottom: 2, color: log.level === 'ERROR' ? token.colorError : undefined }}>
                    <Text type="secondary">[{log.level}]</Text> {log.message}
                  </div>
                ))
              }
            </div>
          </div>
        )}

        {/* ───── Step 2: Result ───── */}
        {step === 2 && (
          <Result
            status="success"
            title="备份完成"
            subTitle="标准备份包已生成。"
            extra={[
              resultFilePath && (
                <Button key="download" type="primary" icon={<SaveOutlined />}
                  href={backupApi.downloadUrl(resultFilePath)} target="_blank" download>
                  下载 .edbkp 文件
                </Button>
              ),
              <Button key="close" onClick={handleClose}>关闭</Button>,
            ].filter(Boolean)}
          >
            {resultFilePath && (
              <div style={{
                background: token.colorFillAlter, borderRadius: token.borderRadius,
                padding: '8px 12px', fontFamily: 'monospace', fontSize: 12,
                wordBreak: 'break-all', textAlign: 'left',
              }}>
                <Text type="secondary">文件路径：</Text>
                <Text copyable={{ text: resultFilePath }}>{resultFilePath}</Text>
              </div>
            )}
          </Result>
        )}
      </div>
    </Modal>
  )
}
