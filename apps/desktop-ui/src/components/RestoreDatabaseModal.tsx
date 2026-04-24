import { useEffect, useRef, useState } from 'react'
import {
  Alert, Button, Card, Descriptions, Form, Input, List, Modal, Progress, Result,
  Select, Space, Steps, Table, Tag, Typography, Upload, theme,
  type TableColumnsType,
} from 'antd'
import {
  SyncOutlined, CheckCircleOutlined,
  InboxOutlined, DatabaseOutlined, ExclamationCircleOutlined, FileOutlined, FolderOpenOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { invoke } from '@tauri-apps/api/core'
import { backupApi, restoreApi, taskApi } from '@/services/api'
import { handleApiError, toast } from '@/utils/notification'
import { formatDuration, getElapsedMs } from '@/utils/format'

function hasTauriInvoke(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ === 'object'
}

const { Dragger } = Upload
const { Text } = Typography

function formatSize(bytes: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

interface BackupFileInfo {
  fileName: string
  filePath: string
  fileSizeBytes: string
  lastModified: string
}

interface RestoreDatabaseModalProps {
  open: boolean
  onClose: () => void
  targetConnectionId: string
  targetConnectionName: string
  defaultTargetDatabase?: string
}

interface BackupManifest {
  database: string
  dbType: string
  serverVersion: string
  mode: string
  charset?: string
  startedAt: string
  completedAt?: string
  consistency: string
  binlogFile?: string
  binlogPosition?: number
  tables: Array<{ tableName: string; rowEstimate: number; dataFiles: string[] }>
  objects: Array<{ name: string; type: string }>
}

interface InspectResult {
  manifest: BackupManifest
  fileValid: boolean
  checksumValid: boolean
  warnings: string[]
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
}

interface RestoreTableItem {
  key: string
  tableName: string
  rowEstimate: number
  dataFileCount: number
}

const restoreTableColumns: TableColumnsType<RestoreTableItem> = [
  {
    title: '表名',
    dataIndex: 'tableName',
    key: 'tableName',
    ellipsis: true,
    render: (name: string) => <Text strong style={{ fontSize: 13 }}>{name}</Text>,
  },
  {
    title: '预估行数',
    dataIndex: 'rowEstimate',
    key: 'rowEstimate',
    width: 100,
    align: 'right',
    sorter: (a, b) => a.rowEstimate - b.rowEstimate,
    render: (v: number) => <Text style={{ fontSize: 12 }}>{v > 0 ? v.toLocaleString() : '-'}</Text>,
  },
  {
    title: '数据文件',
    dataIndex: 'dataFileCount',
    key: 'dataFileCount',
    width: 80,
    align: 'right',
    render: (v: number) => <Text style={{ fontSize: 12 }}>{v}</Text>,
  },
]

export default function RestoreDatabaseModal({
  open, onClose, targetConnectionId, targetConnectionName, defaultTargetDatabase = ''
}: RestoreDatabaseModalProps) {
  const { token } = theme.useToken()
  const [form] = Form.useForm()

  const [step, setStep] = useState(0)            // 0:选文件 1:预检 2:配置 3:执行 4:结果
  const [filePath, setFilePath] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspectResult, setInspectResult] = useState<InspectResult | null>(null)
  const [loading, setLoading] = useState(false)

  // Backup file list
  const [backupFiles, setBackupFiles] = useState<BackupFileInfo[]>([])
  const [backupFilesLoading, setBackupFilesLoading] = useState(false)

  // Table selection
  const [tables, setTables] = useState<RestoreTableItem[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [tableSearch, setTableSearch] = useState('')

  // Task tracking
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskStatus, setTaskStatus] = useState<TaskStatus>('pending')
  const [progress, setProgress] = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [startedAt, setStartedAt] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [logs, setLogs] = useState<TaskLog[]>([])
  const [pollRetry, setPollRetry] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pollingRef = useRef(false)
  const logRef = useRef<HTMLDivElement>(null)

  const durationText = taskStatus === 'running' && startedAt
    ? formatDuration(getElapsedMs(startedAt))
    : duration != null ? formatDuration(duration) : ''

  useEffect(() => {
    if (!open) { stopPolling(); resetAll() }
    return () => stopPolling()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Load backup files when modal opens
  useEffect(() => {
    if (open && step === 0) {
      loadBackupFiles()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step])

  const loadBackupFiles = async () => {
    setBackupFilesLoading(true)
    try {
      const files = await backupApi.list() as BackupFileInfo[]
      setBackupFiles(files || [])
    } catch (e) {
      console.warn('加载备份文件列表失败', e)
      setBackupFiles([])
    } finally {
      setBackupFilesLoading(false)
    }
  }

  const resetAll = () => {
    form.resetFields()
    setStep(0); setFilePath(''); setInspectResult(null)
    setTaskId(null); setTaskStatus('pending'); setProgress(0)
    setProgressMsg(''); setStartedAt(null); setDuration(null)
    setPollRetry(0); setLogs([])
    setBackupFiles([])
    setTables([]); setSelectedKeys([]); setTableSearch('')
  }

  // Step 0→1: inspect the file
  const handleInspect = async () => {
    const path = filePath.trim()
    if (!path) { toast.warning('请先输入备份文件路径'); return }
    setInspecting(true)
    try {
      const result = await restoreApi.inspect({ filePath: path }) as InspectResult
      setInspectResult(result)
      // 初始化表列表，默认全选
      const tableItems: RestoreTableItem[] = result.manifest.tables.map(t => ({
        key: t.tableName,
        tableName: t.tableName,
        rowEstimate: t.rowEstimate,
        dataFileCount: t.dataFiles?.length ?? 0,
      }))
      setTables(tableItems)
      setSelectedKeys(tableItems.map(t => t.key))
      // 优先使用用户选择的默认库，否则用备份源库
      form.setFieldValue('targetDatabase', defaultTargetDatabase?.trim() || result.manifest.database)
      setStep(1)
    } catch (e) {
      handleApiError(e, '文件预检失败')
    } finally {
      setInspecting(false)
    }
  }

  // Step 2→3: start restore
  const handleStart = async () => {
    if (!inspectResult) return
    try {
      const values = await form.validateFields()
      if (!values.targetDatabase?.trim()) {
        toast.warning('请输入目标数据库名')
        return
      }
      if (selectedKeys.length === 0) {
        toast.warning('请至少选择一张表进行恢复')
        return
      }
      setLoading(true)
      // 全选时传空数组（后端约定），部分选择传具体表名
      const selectedTablesToSend = selectedKeys.length === tables.length
        ? []
        : selectedKeys
      const req = {
        targetConnectionId,
        backupFilePath: filePath,
        targetDatabase: values.targetDatabase.trim(),
        mode: values.mode ?? 'restore_all',
        strategy: values.strategy ?? 'restore_to_new',
        selectedTables: selectedTablesToSend,
      }
      const res = await restoreApi.start(req) as { taskId: string }
      setTaskId(res.taskId)
      setStep(2)
      setTaskStatus('running')
      setProgress(0)
      setProgressMsg(''); setStartedAt(null); setDuration(null)
      setPollRetry(0); setLogs([])
      startPolling(res.taskId)
    } catch (e) {
      handleApiError(e, '启动恢复失败')
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
        if (info.status === 'completed') { setProgress(100); setStep(3) }
      }
    } catch {
      setPollRetry(c => { if (c + 1 >= 20) stopPolling(); return c + 1 })
    } finally { pollingRef.current = false }
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
      stopPolling(); setTaskStatus('cancelled')
      toast.success('已发送中止信号')
    } catch (e) { handleApiError(e, '中止任务失败') }
  }

  const handleClose = () => {
    stopPolling(); resetAll(); onClose()
  }

  const handlePickBackupFile = async () => {
    if (!hasTauriInvoke()) {
      toast.warning('当前环境未注入 Tauri Runtime，请直接输入完整路径')
      return
    }
    try {
      const result = await invoke<string | null>('pick_backup_file')
      if (result) {
        setFilePath(result)
      }
    } catch (e) {
      console.error('选择备份文件失败:', e)
      toast.error('选择备份文件失败: ' + (e as Error).message)
    }
  }

  const manifest = inspectResult?.manifest
  const checksumOk = inspectResult?.checksumValid ?? false
  const fileValid = inspectResult?.fileValid ?? false

  const stepItems = [
    { title: '选择文件', icon: <InboxOutlined /> },
    { title: '文件预检', icon: <ExclamationCircleOutlined /> },
    { title: '执行恢复', icon: step === 2 && taskStatus === 'running' ? <SyncOutlined spin /> : <DatabaseOutlined /> },
    { title: '恢复结果', icon: <CheckCircleOutlined /> },
  ]

  return (
    <Modal
      title={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Space>
            <DatabaseOutlined style={{ color: token.colorWarning }} />
            <Text strong>恢复数据库</Text>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>目标连接：{targetConnectionName}</Text>
        </div>
      }
      open={open}
      width={760}
      onCancel={handleClose}
      maskClosable={false}
      footer={
        step === 0 ? (
          <Space>
            <Button onClick={handleClose}>取消</Button>
            <Button type="primary" onClick={handleInspect} loading={inspecting} disabled={!filePath.trim()}>
              校验并预检文件
            </Button>
          </Space>
        ) : step === 1 ? (
          <Space>
            <Button onClick={() => { setStep(0); setInspectResult(null); setTables([]); setSelectedKeys([]) }}>
              重新选择文件
            </Button>
            <Button type="primary" danger={!checksumOk || !fileValid}
              onClick={handleStart} loading={loading}
              disabled={!fileValid || selectedKeys.length === 0}>
              {!checksumOk ? '⚠️ 忽略警告并恢复'
                : tables.length === selectedKeys.length ? '开始恢复'
                : `恢复 ${selectedKeys.length} 张表`}
            </Button>
          </Space>
        ) : step === 2 ? (
          <Space>
            {taskStatus === 'running' && <Button danger onClick={handleAbort}>中止恢复</Button>}
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
          message="从标准备份包恢复数据库内容。恢复将写入目标数据库，可能覆盖现有内容，请确认后执行。"
        />

        <Steps size="small" current={step} style={{ marginBottom: 24, padding: '0 20px' }}
          items={stepItems}
        />

        {/* ───── Step 0: Select file ───── */}
        {step === 0 && (
          <div>
            {/* Backup file list from ~/.easydb/backups */}
            {backupFiles.length > 0 && (
              <Card
                size="small"
                title={<Space><FileOutlined /><Text>可用备份文件</Text></Space>}
                style={{ marginBottom: 16 }}
                loading={backupFilesLoading}
              >
                <List
                  size="small"
                  dataSource={backupFiles}
                  renderItem={(file) => (
                    <List.Item
                      style={{ cursor: 'pointer', padding: '8px 12px',
                        background: filePath === file.filePath ? token.colorPrimaryBg : undefined,
                        borderRadius: token.borderRadiusSM,
                      }}
                      onClick={() => setFilePath(file.filePath)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                        <Space>
                          <Text strong={filePath === file.filePath}>{file.fileName}</Text>
                          <Tag color="blue">{formatSize(parseInt(file.fileSizeBytes))}</Tag>
                        </Space>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {new Date(parseInt(file.lastModified)).toLocaleString()}
                        </Text>
                      </div>
                    </List.Item>
                  )}
                  style={{ maxHeight: 180, overflow: 'auto' }}
                />
              </Card>
            )}

            <Dragger
              name="file"
              multiple={false}
              accept=".edbkp"
              beforeUpload={file => {
                // Tauri drag-drop provides full path via .path property
                // Browser fallback uses .name (filename only)
                const tauriPath = (file as unknown as { path?: string }).path
                if (tauriPath) {
                  setFilePath(tauriPath)
                } else {
                  // Browser mode: only get filename, warn user
                  const filename = file.name
                  toast.warning(`拖拽仅获得文件名 "${filename}", 请手动输入完整路径或点击"选择文件"按钮`)
                }
                return false
              }}
              style={{ marginBottom: 16 }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">点击或将 .edbkp 文件拖拽到此处</p>
              <p className="ant-upload-hint">支持 EasyDB 标准备份包格式 (.edbkp)</p>
            </Dragger>

            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>或手动输入文件路径：</Text>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="例：/Users/user/.easydb/backups/backup_mydb_20260418.edbkp"
                value={filePath}
                onChange={e => setFilePath(e.target.value)}
                allowClear
                style={{ fontFamily: 'monospace' }}
              />
              <Button icon={<FolderOpenOutlined />} onClick={handlePickBackupFile}>选择文件</Button>
            </Space.Compact>
            <Alert
              style={{ marginTop: 16 }}
              type="warning"
              showIcon
              message="恢复会写入目标数据库，必要时请先备份当前数据。"
            />
          </div>
        )}

        {/* ───── Step 1: Inspect result + config ───── */}
        {step === 1 && manifest && (
          <div>
            {/* Integrity status */}
            <Space style={{ marginBottom: 16 }}>
              <Tag color={fileValid ? 'success' : 'error'}>{fileValid ? '✓ 文件结构完整' : '✗ 文件损坏'}</Tag>
              <Tag color={checksumOk ? 'success' : 'warning'}>{checksumOk ? '✓ SHA-256 校验通过' : '⚠ 校验失败（可能被篡改）'}</Tag>
              <Tag color={manifest.consistency === 'snapshot' ? 'processing' : 'default'}>
                {manifest.consistency === 'snapshot' ? '✓ 一致性快照' : '⚠ 最佳努力一致性'}
              </Tag>
            </Space>

            {inspectResult?.warnings && inspectResult.warnings.length > 0 && (
              <Alert type="warning" showIcon message="预检警告" style={{ marginBottom: 16 }}
                description={inspectResult.warnings.join('\n')} />
            )}

            {/* Backup info */}
            <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="源数据库">{manifest.database}</Descriptions.Item>
              <Descriptions.Item label="数据库类型">{manifest.dbType} {manifest.serverVersion}</Descriptions.Item>
              <Descriptions.Item label="备份模式">
                <Tag>{manifest.mode === 'full' ? '完整备份' : manifest.mode === 'structure_only' ? '仅结构' : '仅数据'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="字符集">{manifest.charset ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="备份时间">{manifest.startedAt}</Descriptions.Item>
              <Descriptions.Item label="Binlog 位点">
                {manifest.binlogFile ? `${manifest.binlogFile}:${manifest.binlogPosition}` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="表数量">{manifest.tables.length}</Descriptions.Item>
              <Descriptions.Item label="其他对象">{manifest.objects.length} 个（视图/过程/触发器）</Descriptions.Item>
            </Descriptions>

            {/* Table selector */}
            {tables.length > 0 && (
              <Card
                size="small"
                title={<Space><DatabaseOutlined /><Text>选择恢复表范围</Text></Space>}
                style={{ marginBottom: 16 }}
              >
                <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
                  默认全选。留空等同于恢复全部表（推荐）。
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
                  <Button size="small" onClick={() => setSelectedKeys(tables.map(t => t.key))}>
                    全选
                  </Button>
                  <Button size="small" onClick={() => setSelectedKeys([])} disabled={selectedKeys.length === 0}>
                    清空
                  </Button>
                  <Tag>{selectedKeys.length} / {tables.length} 张表</Tag>
                </Space>
                <Table<RestoreTableItem>
                  rowKey="key"
                  size="small"
                  dataSource={tables.filter(t =>
                    !tableSearch || t.tableName.toLowerCase().includes(tableSearch.toLowerCase())
                  )}
                  columns={restoreTableColumns}
                  pagination={false}
                  scroll={{ y: 200 }}
                  rowSelection={{
                    selectedRowKeys: selectedKeys,
                    onChange: keys => setSelectedKeys(keys as string[]),
                    preserveSelectedRowKeys: true,
                  }}
                />
              </Card>
            )}

            {/* Restore config form */}
            <Form form={form} layout="vertical" initialValues={{
              targetDatabase: defaultTargetDatabase || manifest.database,
              mode: 'restore_all',
              strategy: 'restore_to_new',
            }}>
              <Form.Item name="targetDatabase" label="目标数据库名" rules={[{ required: true, message: '请输入目标数据库名' }]}>
                <Input placeholder="将数据恢复到此数据库（不存在则自动创建）"
                  style={{ fontFamily: 'monospace' }} />
              </Form.Item>

              <Form.Item name="strategy" label="恢复策略">
                <Select options={[
                  { label: '恢复到新库（安全推荐）', value: 'restore_to_new' },
                  { label: '覆盖已有库（先删除再创建）', value: 'overwrite_existing' },
                ]} />
              </Form.Item>

              <Form.Item name="mode" label="恢复内容">
                <Select options={[
                  { label: '完整恢复（结构 + 数据）', value: 'restore_all' },
                  { label: '仅恢复结构', value: 'structure_only' },
                  { label: '仅恢复数据', value: 'data_only' },
                ]} />
              </Form.Item>
            </Form>
          </div>
        )}

        {/* ───── Step 2: Running ───── */}
        {step === 2 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text strong>
                {taskStatus === 'running' ? '正在执行恢复...'
                  : taskStatus === 'failed' ? '恢复失败'
                  : taskStatus === 'cancelled' ? '已中止'
                  : '即将完成'}
              </Text>
              <Text type="secondary">{progress}%</Text>
            </div>
            <Progress
              percent={progress}
              status={taskStatus === 'failed' ? 'exception' : taskStatus === 'cancelled' ? 'normal' : 'active'}
            />
            {durationText && <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>耗时：{durationText}</Text>}
            {progressMsg && <Text type="secondary" style={{ display: 'block', marginTop: 4 }}>当前阶段：{progressMsg}</Text>}
            {pollRetry > 0 && <Tag color="warning" style={{ marginTop: 8 }}>状态刷新重试中 × {pollRetry}</Tag>}

            <div ref={logRef} style={{
              marginTop: 16, height: 240, overflow: 'auto',
              background: token.colorFillAlter, borderRadius: token.borderRadius,
              padding: 12, fontFamily: 'var(--font-family-code, monospace)', fontSize: 12,
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

        {/* ───── Step 3: Result ───── */}
        {step === 3 && (
          <Result
            status="success"
            title="恢复完成"
            subTitle="数据库已恢复完成。"
            extra={[<Button key="close" type="primary" onClick={handleClose}>关闭</Button>]}
          />
        )}
      </div>
    </Modal>
  )
}
