import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Input,
  Modal,
  Progress,
  Result,
  Select,
  Space,
  Steps,
  Tag,
  Typography,
  theme,
} from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import { invoke } from '@tauri-apps/api/core'
import { sqlApi, taskApi } from '@/services/api'
import { handleApiError, toast } from '@/utils/notification'
import { formatDuration, getElapsedMs } from '@/utils/format'

const { Text } = Typography

interface ImportSqlDialogProps {
  open: boolean
  onClose: () => void
  connectionId?: string
  connectionName?: string
  database?: string
  databases?: string[]
}

interface SelectedSqlFile {
  path: string
  name: string
  size: number
}

type ImportTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

interface ImportTaskInfo {
  progress?: number
  status: ImportTaskStatus
  progressMessage?: string
  startedAt?: string
  duration?: number
  successCount?: number
  failureCount?: number
  skippedCount?: number
  errorMessage?: string
}

interface ImportTaskLog {
  timestamp: string
  level: string
  message: string
}

export const ImportSqlDialog: React.FC<ImportSqlDialogProps> = ({
  open, onClose, connectionId, connectionName, database, databases,
}) => {
  const { token } = theme.useToken()
  const nativePickerAvailable = hasTauriInvoke()
  const [currentStep, setCurrentStep] = useState(0)
  const [selectedDb, setSelectedDb] = useState(database ?? '')
  const [selectedFile, setSelectedFile] = useState<SelectedSqlFile | null>(null)
  const [manualFilePath, setManualFilePath] = useState('')
  const [loading, setLoading] = useState(false)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskStatus, setTaskStatus] = useState<ImportTaskStatus>('pending')
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [startedAt, setStartedAt] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [successCount, setSuccessCount] = useState(0)
  const [failureCount, setFailureCount] = useState(0)
  const [skippedCount, setSkippedCount] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [logs, setLogs] = useState<ImportTaskLog[]>([])
  const [pollRetryCount, setPollRetryCount] = useState(0)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollingRef = useRef(false)
  const logContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setSelectedDb(database ?? '')
    }
  }, [open, database])

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    pollingRef.current = false
  }, [])

  const resetState = useCallback(() => {
    stopPolling()
    setCurrentStep(0)
    setSelectedDb(database ?? '')
    setSelectedFile(null)
    setManualFilePath('')
    setLoading(false)
    setTaskId(null)
    setTaskStatus('pending')
    setProgress(0)
    setProgressMessage('')
    setStartedAt(null)
    setDuration(null)
    setSuccessCount(0)
    setFailureCount(0)
    setSkippedCount(0)
    setErrorMessage('')
    setLogs([])
    setPollRetryCount(0)
  }, [database, stopPolling])

  useEffect(() => {
    if (!open) {
      resetState()
    }
    return () => stopPolling()
  }, [open, resetState, stopPolling])

  const latestLogMessage = useMemo(() => (
    logs.length > 0 ? logs[logs.length - 1].message : ''
  ), [logs])

  const effectiveFile = useMemo<SelectedSqlFile | null>(() => {
    if (selectedFile) return selectedFile
    return buildFileFromPath(manualFilePath)
  }, [manualFilePath, selectedFile])

  const stageMessage = progressMessage || latestLogMessage
  const durationText = taskStatus === 'running' && startedAt
    ? formatDuration(getElapsedMs(startedAt))
    : duration != null
      ? formatDuration(duration)
      : ''

  const pollOnce = async (id: string) => {
    if (pollingRef.current) return
    pollingRef.current = true
    try {
      const [taskInfo, taskLogs] = await Promise.all([
        taskApi.detail(id) as Promise<ImportTaskInfo>,
        taskApi.logs(id) as Promise<ImportTaskLog[]>,
      ])
      setPollRetryCount(0)
      setTaskStatus(taskInfo.status)
      setProgress(taskInfo.progress ?? 0)
      setProgressMessage(taskInfo.progressMessage ?? '')
      setStartedAt(taskInfo.startedAt ?? null)
      setDuration(taskInfo.duration ?? null)
      setSuccessCount(taskInfo.successCount ?? 0)
      setFailureCount(taskInfo.failureCount ?? 0)
      setSkippedCount(taskInfo.skippedCount ?? 0)
      setErrorMessage(taskInfo.errorMessage ?? '')
      // A5: 使用增量追加，后端限制了 1000 条所以直接替换也可接受
      setLogs(taskLogs ?? [])

      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
      }

      if (taskInfo.status === 'completed' || taskInfo.status === 'failed' || taskInfo.status === 'cancelled') {
        stopPolling()
        setCurrentStep(2)
        if (taskInfo.status === 'completed') {
          setProgress(100)
        }
      }
    } catch (error) {
      setPollRetryCount((count) => {
        // A7: 超过 20 次连续失败则停止轮询，防止僵尸请求
        if (count + 1 >= 20) {
          stopPolling()
          console.error('Polling import task failed too many times, stopped.')
        }
        return count + 1
      })
      console.warn('Polling import task failed, will retry', error)
    } finally {
      pollingRef.current = false
    }
  }

  // A7: 串行轮询 —— 上一次请求完成后再等 1.5s 发下一次，避免慢响应积压
  const startPolling = (id: string) => {
    stopPolling()
    const poll = async () => {
      await pollOnce(id)
      // 如果任务还在跑就继续
      timerRef.current = setTimeout(() => void poll(), 1500) as unknown as ReturnType<typeof setInterval>
    }
    void poll()
  }

  const handlePickFile = useCallback(async () => {
    if (!nativePickerAvailable) {
      toast.warning('当前环境未注入 Tauri Runtime，请直接粘贴 SQL 文件绝对路径')
      return
    }

    try {
      const file = await invoke<SelectedSqlFile | null>('pick_sql_file')
      if (!file) return
      setSelectedFile(file)
      setManualFilePath(file.path)
      setLogs([])
      setCurrentStep(0)
      setTaskStatus('pending')
      setProgress(0)
      setProgressMessage('')
      setErrorMessage('')
    } catch (error) {
      handleApiError(error, '选择 SQL 文件失败')
    }
  }, [nativePickerAvailable])

  const handleStart = useCallback(async () => {
    if (!effectiveFile || !connectionId || !selectedDb) {
      toast.warning('请选择 SQL 文件和目标数据库')
      return
    }

    try {
      setLoading(true)
      const result = await sqlApi.importFileStart({
        connectionId,
        database: selectedDb,
        filePath: effectiveFile.path,
        fileName: effectiveFile.name,
      }) as { taskId: string }

      setTaskId(result.taskId)
      setCurrentStep(1)
      setTaskStatus('running')
      setProgress(1)
      setProgressMessage('初始化导入环境...')
      setStartedAt(null)
      setDuration(null)
      setSuccessCount(0)
      setFailureCount(0)
      setSkippedCount(0)
      setErrorMessage('')
      setPollRetryCount(0)
      setLogs([])
      startPolling(result.taskId)
    } catch (error) {
      handleApiError(error, '启动 SQL 导入失败')
    } finally {
      setLoading(false)
    }
  }, [connectionId, effectiveFile, selectedDb, startPolling])

  const handleAbort = useCallback(async () => {
    if (!taskId) return
    try {
      await taskApi.cancel(taskId)
      toast.success('已发送取消信号')
    } catch (error) {
      handleApiError(error, '取消导入失败')
    }
  }, [taskId])

  const handleClose = useCallback(() => {
    if (taskStatus === 'running') return
    resetState()
    onClose()
  }, [onClose, resetState, taskStatus])

  const resultStatus = taskStatus === 'completed'
    ? 'success'
    : taskStatus === 'cancelled'
      ? 'warning'
      : 'error'

  const resultTitle = taskStatus === 'completed'
    ? 'SQL 文件导入完成'
    : taskStatus === 'cancelled'
      ? 'SQL 文件导入已取消'
      : 'SQL 文件导入失败'

  const executionStepIcon = taskStatus === 'running'
    ? <SyncOutlined spin />
    : taskStatus === 'completed'
      ? <CheckCircleOutlined />
      : taskStatus === 'cancelled'
        ? <ExclamationCircleOutlined />
        : taskStatus === 'failed'
          ? <CloseCircleOutlined />
          : <PlayCircleOutlined />

  return (
    <Modal
      title="导入 SQL 文件"
      open={open}
      width={760}
      onCancel={handleClose}
      maskClosable={false}
      closable={taskStatus !== 'running'}
      footer={
        currentStep === 0 ? (
          <Space>
            <Button onClick={handleClose}>取消</Button>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleStart}
              loading={loading}
              disabled={!effectiveFile || !connectionId || !selectedDb}
            >
              开始导入
            </Button>
          </Space>
        ) : currentStep === 1 ? (
          <Space>
            <Button danger onClick={handleAbort}>中止导入</Button>
          </Space>
        ) : (
          <Button type="primary" onClick={handleClose}>关闭</Button>
        )
      }
    >
      <div style={{ padding: '8px 0' }}>
        <Steps
          size="small"
          current={currentStep}
          style={{ marginBottom: 24, padding: '0 40px' }}
          items={[
            { title: '导入选项', icon: <FileTextOutlined /> },
            { title: '执行导入', icon: executionStepIcon },
            { title: '导入结果', icon: <CheckCircleOutlined /> },
          ]}
        />

        {currentStep === 0 && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Text strong style={{ width: 90, flexShrink: 0 }}>SQL 文件：</Text>
              <Button icon={<FolderOpenOutlined />} onClick={handlePickFile}>
                选择本地文件
              </Button>
              {effectiveFile && (
                <Text type="secondary">
                  {effectiveFile.name}{effectiveFile.size > 0 ? `（${formatSize(effectiveFile.size)}）` : ''}
                </Text>
              )}
            </div>

            {!nativePickerAvailable && (
              <Alert
                type="warning"
                showIcon
                message="当前环境缺少 Tauri Runtime"
                description="无法调用桌面原生文件选择器。你可以直接粘贴 SQL 文件绝对路径继续导入。"
              />
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Text strong style={{ width: 90, flexShrink: 0 }}>绝对路径：</Text>
              <Input
                value={manualFilePath}
                onChange={(e) => {
                  const nextPath = e.target.value
                  setManualFilePath(nextPath)
                  if (selectedFile && nextPath !== selectedFile.path) {
                    setSelectedFile(null)
                  }
                }}
                placeholder="/Users/xxx/Downloads/demo.sql"
              />
            </div>

            {effectiveFile && (
              <Alert
                type="info"
                showIcon
                message="将由后端流式导入，不再把整个 SQL 文件读入前端内存"
                description={effectiveFile.path}
              />
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Text strong style={{ width: 90, flexShrink: 0 }}>目标连接：</Text>
              <Tag color="success">{connectionName ?? connectionId ?? '未选择'}</Tag>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Text strong style={{ width: 90, flexShrink: 0 }}>目标数据库：</Text>
              {databases && databases.length > 0 ? (
                <Select
                  value={selectedDb}
                  onChange={setSelectedDb}
                  style={{ width: 240 }}
                  placeholder="选择数据库"
                  options={databases.map((db) => ({ value: db, label: db }))}
                />
              ) : (
                <Tag>{selectedDb || '未选择'}</Tag>
              )}
            </div>
          </Space>
        )}

        {currentStep === 1 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text strong>正在执行导入...</Text>
              <Text type="secondary">{progress}%</Text>
            </div>

            <Progress percent={progress} status={taskStatus === 'failed' ? 'exception' : 'active'} />

            {durationText && (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">导入耗时：{durationText}</Text>
              </div>
            )}

            {stageMessage && (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">当前阶段：{stageMessage}</Text>
              </div>
            )}

            <Space size={[8, 8]} wrap style={{ marginTop: 12 }}>
              <Tag color="success">成功 {successCount}</Tag>
              {failureCount > 0 && <Tag color="error">失败 {failureCount}</Tag>}
              {skippedCount > 0 && <Tag>跳过 {skippedCount}</Tag>}
              {pollRetryCount > 0 && <Tag color="warning">状态刷新重试中 × {pollRetryCount}</Tag>}
            </Space>

            <div
              ref={logContainerRef}
              style={{
                marginTop: 24,
                height: 280,
                overflow: 'auto',
                background: 'transparent',
                borderRadius: token.borderRadius,
                padding: '8px 12px',
                fontFamily: 'monospace',
                fontSize: 12,
                lineHeight: 1.6,
                border: '1px solid var(--glass-border)',
              }}
            >
              {logs.length === 0 ? (
                <Text type="secondary">等待日志输出...</Text>
              ) : (
                logs.map((log, index) => (
                  <div key={`${log.timestamp}-${index}`} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    <Text type="secondary">[{log.timestamp}]</Text>{' '}
                    <Text style={{
                      color: log.level === 'ERROR' ? token.colorError
                        : log.level === 'WARN' ? token.colorWarning
                        : token.colorTextSecondary,
                    }}
                    >
                      {log.message}
                    </Text>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div>
            <Result
              status={resultStatus}
              title={resultTitle}
              subTitle={
                <>
                  {durationText ? `导入耗时：${durationText}` : '导入任务已结束'}
                  {(errorMessage || failureCount > 0) && (
                    <div style={{ marginTop: 8 }}>
                      {errorMessage || `共有 ${failureCount} 条 SQL 语句执行失败，请查看日志`}
                    </div>
                  )}
                </>
              }
              extra={[
                <Tag color="success" key="success">成功 {successCount}</Tag>,
                failureCount > 0 ? <Tag color="error" key="error">失败 {failureCount}</Tag> : null,
                skippedCount > 0 ? <Tag key="skip">跳过 {skippedCount}</Tag> : null,
              ].filter(Boolean)}
            />

            {taskStatus === 'failed' && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="导入过程中有失败语句"
                description="请结合下方日志定位第几条语句失败，以及对应的数据库报错。"
              />
            )}

            <div
              style={{
                height: 220,
                overflow: 'auto',
                background: 'transparent',
                borderRadius: token.borderRadius,
                padding: '8px 12px',
                fontFamily: 'monospace',
                fontSize: 12,
                lineHeight: 1.6,
                border: '1px solid var(--glass-border)',
              }}
            >
              {logs.length === 0 ? (
                <Text type="secondary">暂无日志</Text>
              ) : (
                logs.map((log, index) => (
                  <div key={`${log.timestamp}-${index}`} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    <Text type="secondary">[{log.timestamp}]</Text>{' '}
                    <Text style={{
                      color: log.level === 'ERROR' ? token.colorError
                        : log.level === 'WARN' ? token.colorWarning
                        : token.colorTextSecondary,
                    }}
                    >
                      {log.message}
                    </Text>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function hasTauriInvoke(): boolean {
  if (typeof window === 'undefined') return false
  const candidate = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: unknown
    }
  }
  return typeof candidate.__TAURI_INTERNALS__?.invoke === 'function'
}

function buildFileFromPath(filePath: string): SelectedSqlFile | null {
  const normalized = filePath.trim()
  if (!normalized) return null

  const segments = normalized.split(/[\\/]/).filter(Boolean)
  const name = segments[segments.length - 1] ?? normalized

  return {
    path: normalized,
    name,
    size: 0,
  }
}
