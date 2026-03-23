/**
 * SQL 文件导入弹窗 — 选择 .sql 文件 → 确认目标连接/库 → 逐语句执行 → 实时日志
 */
import React, { useState, useRef, useCallback } from 'react'
import {
  Modal, Upload, Button, Space, Typography, Progress, Select, Tag, Alert,
  theme,
} from 'antd'
import {
  UploadOutlined, PlayCircleOutlined, CheckCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import { sqlApi } from '@/services/api'
import type { SqlResult } from '@/types'

const { Text } = Typography

interface ImportSqlDialogProps {
  open: boolean
  onClose: () => void
  /** 预设的连接 ID */
  connectionId?: string
  connectionName?: string
  /** 预设的数据库 */
  database?: string
  /** 可选的数据库列表 */
  databases?: string[]
}

interface LogEntry {
  time: string
  level: 'info' | 'success' | 'error' | 'warn'
  message: string
}

/** 将 SQL 文件内容拆分为独立语句（分号分割，跳过注释和字符串内的分号） */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]

    // 处理行注释
    if (!inSingleQuote && !inDoubleQuote && !inBacktick && !inBlockComment) {
      if (ch === '-' && next === '-') {
        inLineComment = true
        current += ch
        continue
      }
      if (ch === '#' && !inLineComment) {
        inLineComment = true
        current += ch
        continue
      }
    }
    if (inLineComment) {
      current += ch
      if (ch === '\n') inLineComment = false
      continue
    }

    // 处理块注释
    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (ch === '/' && next === '*' && !inBlockComment) {
        inBlockComment = true
        current += ch
        continue
      }
    }
    if (inBlockComment) {
      current += ch
      if (ch === '*' && next === '/') {
        current += next
        i++
        inBlockComment = false
      }
      continue
    }

    // 处理引号
    if (!inDoubleQuote && !inBacktick && ch === '\'' && !isEscaped(sql, i)) {
      inSingleQuote = !inSingleQuote
    } else if (!inSingleQuote && !inBacktick && ch === '"' && !isEscaped(sql, i)) {
      inDoubleQuote = !inDoubleQuote
    } else if (!inSingleQuote && !inDoubleQuote && ch === '`') {
      inBacktick = !inBacktick
    }

    // 分号分割
    if (ch === ';' && !inSingleQuote && !inDoubleQuote && !inBacktick) {
      const stmt = current.trim()
      if (stmt && !isCommentOnly(stmt)) {
        statements.push(stmt)
      }
      current = ''
      continue
    }

    current += ch
  }

  // 处理末尾没有分号的语句
  const last = current.trim()
  if (last && !isCommentOnly(last)) {
    statements.push(last)
  }

  return statements
}

function isEscaped(sql: string, pos: number): boolean {
  let count = 0
  for (let i = pos - 1; i >= 0 && sql[i] === '\\'; i--) {
    count++
  }
  return count % 2 === 1
}

function isCommentOnly(s: string): boolean {
  const lines = s.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.every(l => l.startsWith('--') || l.startsWith('#') || l.startsWith('/*'))
}

export const ImportSqlDialog: React.FC<ImportSqlDialogProps> = ({
  open, onClose, connectionId, connectionName, database, databases,
}) => {
  const { token } = theme.useToken()
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [fileSize, setFileSize] = useState(0)
  const [selectedDb, setSelectedDb] = useState<string>(database ?? '')
  const [executing, setExecuting] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [done, setDone] = useState(false)
  const [stats, setStats] = useState({ success: 0, errors: 0, skipped: 0 })
  const abortRef = useRef(false)
  const logContainerRef = useRef<HTMLDivElement>(null)

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setLogs(prev => {
      const next = [...prev, { time, level, message }]
      // 限制日志数量避免内存问题
      return next.length > 2000 ? next.slice(-1500) : next
    })
    // 自动滚动到底部
    setTimeout(() => {
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
      }
    }, 50)
  }, [])

  const handleFileSelect = useCallback((file: File) => {
    if (!file.name.endsWith('.sql')) {
      addLog('error', `文件 ${file.name} 不是 .sql 格式`)
      return false
    }

    setFileName(file.name)
    setFileSize(file.size)
    setDone(false)
    setLogs([])
    setStats({ success: 0, errors: 0, skipped: 0 })

    const reader = new FileReader()
    reader.onload = (e) => {
      const content = e.target?.result as string
      setFileContent(content)
      const stmtCount = splitSqlStatements(content).length
      addLog('info', `已加载文件 ${file.name}（${formatSize(file.size)}），包含 ${stmtCount} 条语句`)
    }
    reader.onerror = () => {
      addLog('error', `读取文件失败：${reader.error?.message ?? '未知错误'}`)
    }
    reader.readAsText(file, 'utf-8')

    return false // 阻止默认上传
  }, [addLog])

  const handleExecute = useCallback(async () => {
    if (!fileContent || !connectionId || !selectedDb) return

    const statements = splitSqlStatements(fileContent)
    if (statements.length === 0) {
      addLog('warn', '文件中没有可执行的 SQL 语句')
      return
    }

    setExecuting(true)
    setDone(false)
    abortRef.current = false
    setProgress({ current: 0, total: statements.length })
    setStats({ success: 0, errors: 0, skipped: 0 })

    addLog('info', `开始执行，共 ${statements.length} 条语句，目标库：${selectedDb}`)

    let successCount = 0
    let errorCount = 0

    for (let i = 0; i < statements.length; i++) {
      if (abortRef.current) {
        addLog('warn', `用户中止，已执行 ${i}/${statements.length}`)
        break
      }

      const stmt = statements[i]
      const preview = stmt.length > 80 ? stmt.slice(0, 80) + '...' : stmt

      try {
        const results = await sqlApi.execute(connectionId, selectedDb, stmt) as SqlResult[]
        const hasError = results.some(r => r.type === 'error')
        if (hasError) {
          const errMsg = results.find(r => r.type === 'error')?.error ?? '未知错误'
          addLog('error', `[${i + 1}/${statements.length}] 失败: ${errMsg}\n  → ${preview}`)
          errorCount++
        } else {
          const affected = results.reduce((sum, r) => sum + (r.affectedRows ?? 0), 0)
          if (affected > 0) {
            addLog('success', `[${i + 1}/${statements.length}] 成功: 影响 ${affected} 行  → ${preview}`)
          } else {
            addLog('success', `[${i + 1}/${statements.length}] 成功  → ${preview}`)
          }
          successCount++
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : '执行异常'
        addLog('error', `[${i + 1}/${statements.length}] 异常: ${errMsg}\n  → ${preview}`)
        errorCount++
      }

      setProgress({ current: i + 1, total: statements.length })
      setStats({ success: successCount, errors: errorCount, skipped: 0 })
    }

    const status = abortRef.current ? '已中止' : '执行完成'
    addLog('info', `${status}：成功 ${successCount}，失败 ${errorCount}，共 ${statements.length} 条`)

    setExecuting(false)
    setDone(true)
  }, [fileContent, connectionId, selectedDb, addLog])

  const handleAbort = useCallback(() => {
    abortRef.current = true
  }, [])

  const handleClose = useCallback(() => {
    if (executing) {
      abortRef.current = true
    }
    setFileContent(null)
    setFileName('')
    setFileSize(0)
    setLogs([])
    setDone(false)
    setStats({ success: 0, errors: 0, skipped: 0 })
    setProgress({ current: 0, total: 0 })
    onClose()
  }, [executing, onClose])

  const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0

  return (
    <Modal
      title="执行 SQL 文件"
      open={open}
      onCancel={handleClose}
      width={720}
      footer={
        <Space>
          {executing ? (
            <Button danger onClick={handleAbort}>中止执行</Button>
          ) : (
            <>
              <Button onClick={handleClose}>{done ? '关闭' : '取消'}</Button>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={handleExecute}
                disabled={!fileContent || !connectionId || !selectedDb || done}
              >
                开始执行
              </Button>
            </>
          )}
        </Space>
      }
    >
      {/* 文件选择 */}
      <div style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text strong style={{ flexShrink: 0, width: 80 }}>SQL 文件：</Text>
            <Upload
              accept=".sql"
              showUploadList={false}
              beforeUpload={handleFileSelect}
              disabled={executing}
            >
              <Button icon={<UploadOutlined />} disabled={executing}>选择文件</Button>
            </Upload>
            {fileName && (
              <Text type="secondary">{fileName}（{formatSize(fileSize)}）</Text>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text strong style={{ flexShrink: 0, width: 80 }}>目标连接：</Text>
            <Tag icon={<CheckCircleOutlined />} color="success">{connectionName ?? connectionId}</Tag>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Text strong style={{ flexShrink: 0, width: 80 }}>目标数据库：</Text>
            {databases && databases.length > 0 ? (
              <Select
                value={selectedDb}
                onChange={setSelectedDb}
                style={{ width: 200 }}
                placeholder="选择数据库"
                disabled={executing}
                options={databases.map(db => ({ value: db, label: db }))}
              />
            ) : (
              <Tag>{selectedDb || '未选择'}</Tag>
            )}
          </div>
        </Space>
      </div>

      {/* 进度条 */}
      {progress.total > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {executing ? (
                <><LoadingOutlined spin style={{ marginRight: 4 }} />执行中...</>
              ) : done ? (
                <><CheckCircleOutlined style={{ color: token.colorSuccess, marginRight: 4 }} />已完成</>
              ) : null}
            </Text>
            <Space size={12}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {progress.current}/{progress.total} 条
              </Text>
              <Tag color="success">成功 {stats.success}</Tag>
              {stats.errors > 0 && <Tag color="error">失败 {stats.errors}</Tag>}
            </Space>
          </div>
          <Progress percent={percent} size="small" status={stats.errors > 0 ? 'exception' : undefined} />
        </div>
      )}

      {/* 执行日志 */}
      <div
        ref={logContainerRef}
        style={{
          height: 280,
          overflow: 'auto',
          background: token.colorBgLayout,
          borderRadius: token.borderRadius,
          padding: '8px 12px',
          fontFamily: 'monospace',
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        {logs.length === 0 ? (
          <Text type="secondary">选择 SQL 文件后点击「开始执行」</Text>
        ) : (
          logs.map((log, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              <Text type="secondary">[{log.time}]</Text>{' '}
              <Text style={{
                color: log.level === 'error' ? token.colorError
                  : log.level === 'success' ? token.colorSuccess
                  : log.level === 'warn' ? token.colorWarning
                  : token.colorTextSecondary,
              }}>
                {log.message}
              </Text>
            </div>
          ))
        )}
      </div>

      {/* 完成后提示 */}
      {done && stats.errors > 0 && (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message={`执行完成，${stats.errors} 条语句失败`}
          description="请查看上方日志了解失败原因"
        />
      )}
    </Modal>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
