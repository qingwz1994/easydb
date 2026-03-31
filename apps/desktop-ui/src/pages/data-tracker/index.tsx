import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Card, Button, Select, Space, Tag, Table, Empty, Alert, Tooltip,
  Badge, Typography, Divider, Checkbox, Modal, Input,
  Segmented, message, theme, InputNumber, DatePicker,
} from 'antd'
import {
  ThunderboltOutlined, PauseCircleOutlined, PlayCircleOutlined,
  ReloadOutlined, RollbackOutlined, FileTextOutlined,
  CheckCircleOutlined, WarningOutlined,
  CopyOutlined, ExclamationCircleOutlined,
  HistoryOutlined, DatabaseOutlined,
  DownloadOutlined,
} from '@ant-design/icons'
import { connectionApi } from '@/services/api'
import { trackerApi } from '@/services/trackerApi'
import type {
  ConnectionConfig, ChangeEvent, TrackerSessionStatus,
  TrackerServerCheck, BinlogFileInfo, SseTick, HistoryStats,
} from '@/types'
import dayjs from 'dayjs'
import type { Dayjs } from 'dayjs'

const { Text } = Typography
const { RangePicker } = DatePicker

// 事件类型颜色映射
const eventTypeConfig: Record<string, { color: string; label: string }> = {
  INSERT: { color: '#52c41a', label: 'INSERT' },
  UPDATE: { color: '#1890ff', label: 'UPDATE' },
  DELETE: { color: '#ff4d4f', label: 'DELETE' },
}

export const DataTrackerPage: React.FC = () => {
  const { token } = theme.useToken()
  const isDark = token.colorBgBase === '#000000' || token.colorBgContainer === '#141414'
    || (token.colorBgBase ? parseInt(token.colorBgBase.replace('#', ''), 16) < 0x808080 : false)

  // 连接与会话状态
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [selectedConnId, setSelectedConnId] = useState<string>('')
  const [serverCheck, setServerCheck] = useState<TrackerServerCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionStatus, setSessionStatus] = useState<TrackerSessionStatus | null>(null)
  const [starting, setStarting] = useState(false)

  // SSE 轻量通知状态 (不再存储完整事件!)
  const [totalCount, setTotalCount] = useState(0)
  const [rate, setRate] = useState(0)
  const [sseStatus, setSseStatus] = useState<'idle' | 'receiving' | 'completed' | 'error'>('idle')

  // 服务端分页数据 — 只保存当前页
  const [currentPageData, setCurrentPageData] = useState<ChangeEvent[]>([])
  const [pageTotal, setPageTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [stats, setStats] = useState<HistoryStats | null>(null)
  const [loadingPage, setLoadingPage] = useState(false)

  // 选中事件（用于回滚）
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(new Set())

  // 筛选参数（发送给后端，不做客户端过滤）
  const [filterType, setFilterType] = useState<string>('ALL')
  const [filterTable, setFilterTable] = useState<string>('')

  const [timeRange, setTimeRange] = useState<[Dayjs, Dayjs] | null>(null)

  // 回滚 Modal
  const [rollbackModal, setRollbackModal] = useState(false)
  const [rollbackSql, setRollbackSql] = useState<string[]>([])
  const [rollbackSummary, setRollbackSummary] = useState<{ tables: number; rows: number; insertCount: number; updateCount: number; deleteCount: number } | null>(null)
  const [rollbackWarnings, setRollbackWarnings] = useState<string[]>([])

  // 事件详情面板
  const [selectedEvent, setSelectedEvent] = useState<ChangeEvent | null>(null)

  // 模式 & 回放配置
  const [mode, setMode] = useState<'realtime' | 'replay'>('realtime')
  const [binlogFiles, setBinlogFiles] = useState<BinlogFileInfo[]>([])
  const [startFile, setStartFile] = useState<string | undefined>()
  const [startPosition, setStartPosition] = useState<number>(4)
  const [endFile, setEndFile] = useState<string | undefined>()
  const [endPosition, setEndPosition] = useState<number | undefined>()
  const [loadingFiles, setLoadingFiles] = useState(false)

  const eventSourceRef = useRef<EventSource | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fetchPageRef = useRef<(page: number, size: number) => void>(() => {})
  const requestTrackerRef = useRef<number>(0)
  const abortControllerRef = useRef<AbortController | null>(null)

  // 加载连接列表
  useEffect(() => {
    connectionApi.list().then(data => setConnections(data as ConnectionConfig[])).catch(console.error)
  }, [])

  // 清理
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
      if (pollRef.current) clearInterval(pollRef.current)
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [])

  // 键盘导航（简化 — 不依赖 filteredEvents）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedEvent(null)
        return
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && currentPageData.length > 0) {
        e.preventDefault()
        setSelectedEvent(prev => {
          if (!prev) return currentPageData[0]
          const idx = currentPageData.findIndex(ev => ev.id === prev.id)
          if (idx === -1) return currentPageData[0]
          const nextIdx = e.key === 'ArrowDown'
            ? Math.min(idx + 1, currentPageData.length - 1)
            : Math.max(idx - 1, 0)
          return currentPageData[nextIdx]
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentPageData])

  // ─── 后端 API 调用 ─────────────────────────────────────────

  // 检查服务端兼容性
  const handleCheck = useCallback(async () => {
    if (!selectedConnId) return
    setChecking(true)
    setServerCheck(null)
    try {
      const result = await trackerApi.serverCheck(selectedConnId)
      setServerCheck(result)
    } catch (e: any) {
      message.error(`检查失败: ${e.message}`)
    } finally {
      setChecking(false)
    }
  }, [selectedConnId])

  // 选择连接时自动检查
  useEffect(() => {
    if (selectedConnId) handleCheck()
  }, [selectedConnId, handleCheck])

  // 加载 binlog 文件列表
  const loadBinlogFiles = useCallback(async () => {
    if (!selectedConnId) return
    setLoadingFiles(true)
    try {
      const files = await trackerApi.listBinlogFiles(selectedConnId)
      setBinlogFiles(files)
      if (files.length > 0 && !startFile) {
        setStartFile(files[0].file)
      }
    } catch (e: any) {
      message.error(`加载 binlog 文件失败: ${e.message}`)
    } finally {
      setLoadingFiles(false)
    }
  }, [selectedConnId, startFile])

  useEffect(() => {
    if (selectedConnId && mode === 'replay') loadBinlogFiles()
  }, [selectedConnId, mode, loadBinlogFiles])

  // ─── 分页数据获取（核心：从后端按需拉取） ─────────────────────

  const fetchPage = useCallback(async (page: number, size: number) => {
    if (!sessionId) return

    // Cancel any ongoing fetch requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    const currentReqId = ++requestTrackerRef.current
    setLoadingPage(true)
    try {
      const result = await trackerApi.history({
        sessionId,
        page: page - 1, // 后端 0-indexed
        pageSize: size,
        table: filterTable || undefined,
        type: filterType === 'ALL' ? undefined : filterType,

        startTime: timeRange ? timeRange[0].valueOf() : undefined,
        endTime: timeRange ? timeRange[1].valueOf() : undefined,
        signal: abortController.signal
      })
      
      // 如果有更新的请求发出了，忽略旧的响应
      if (currentReqId !== requestTrackerRef.current) return

      console.log(`[DEBUG] fetchPage(${page}, ${size}) type=${filterType}`, {
        total: result.total,
        itemCount: result.items.length,
        firstFewItems: result.items.slice(0, 5).map(i => ({ id: i.id, type: i.eventType })),
      })

      setCurrentPageData(result.items)
      setPageTotal(result.total)
      setStats(result.stats)
    } catch (e: any) {
      if (e.name === 'AbortError') return
      if (currentReqId === requestTrackerRef.current) {
        console.error('获取分页数据失败:', e)
      }
    } finally {
      if (currentReqId === requestTrackerRef.current) {
        setLoadingPage(false)
      }
    }
  }, [sessionId, filterType, filterTable, timeRange])

  // 同步最新 fetchPage 到 ref（解决闭包陷阱）
  useEffect(() => {
    fetchPageRef.current = fetchPage
  }, [fetchPage])

  // (定时刷新已依据用户要求移除，避免状态竞争导致数据错乱)
  // 当系统首次接收到数据且当前列表为空时，自动拉取第一页（仅触发一次，解决启动时看不到数据的问题）
  useEffect(() => {
    if (totalCount > 0 && currentPageData.length === 0 && currentPage === 1 && !loadingPage) {
      fetchPageRef.current(1, pageSize)
    }
  }, [totalCount]) // 仅监听 totalCount 变化

  // 当没有处于筛选状态时，实时同步总数，避免 SSE Ticking 增加而分页条没更新的问题
  useEffect(() => {
    if (filterType === 'ALL' && !filterTable && !timeRange) {
      setPageTotal(totalCount)
    }
  }, [totalCount, filterType, filterTable, timeRange])

  // 筛选条件或状态变化时重新加载第一页
  useEffect(() => {
    if (sessionId && (sseStatus === 'completed' || sseStatus === 'receiving')) {
      setCurrentPageData([]) // Explicitly clear arrays to prevent ghost DOM cache
      setCurrentPage(1)
      fetchPage(1, pageSize)
    }
  }, [filterType, filterTable, timeRange, sessionId, sseStatus, pageSize])

  // ─── 启动/停止追踪 ─────────────────────────────────────────

  const handleStart = async () => {
    if (!selectedConnId) return
    setStarting(true)
    try {
      const config: any = { connectionId: selectedConnId, mode }
      if (mode === 'replay') {
        config.startFile = startFile
        config.startPosition = startPosition
        if (endFile) config.endFile = endFile
        if (endPosition) config.endPosition = endPosition
      }
      const result = await trackerApi.start(config)
      setSessionId(result.sessionId)
      setCurrentPageData([])
      setSelectedEventIds(new Set())
      setTotalCount(0)
      setRate(0)
      setSseStatus('receiving')
      setStats(null)
      setPageTotal(0)
      setCurrentPage(1)
      message.success('追踪已启动')

      // 开启 SSE 接收轻量通知（只有计数，不再收完整事件）
      const es = trackerApi.createEventSource(result.sessionId)
      es.onmessage = (e) => {
        try {
          const tick: SseTick = JSON.parse(e.data)
          setTotalCount(tick.totalCount)
          setRate(tick.rate)

          if (tick.type === 'completed') {
            setSseStatus('completed')
            es.close()
            eventSourceRef.current = null
            message.success(tick.message || `回放完成，共 ${tick.totalCount.toLocaleString()} 条事件`)
            // 回放完成后自动加载第一页（通过 ref 调用最新版本）
            setTimeout(() => {
              fetchPageRef.current(1, pageSize)
            }, 300)
          } else if (tick.type === 'error') {
            setSseStatus('error')
            es.close()
            eventSourceRef.current = null
            message.error(tick.message || '追踪出错')
          }
        } catch { /* ignore parse errors */ }
      }
      es.onerror = () => {
        console.warn('SSE connection error')
      }
      eventSourceRef.current = es

      // 轮询状态（每 3 秒）
      pollRef.current = setInterval(async () => {
        try {
          const status = await trackerApi.status(result.sessionId) as TrackerSessionStatus
          setSessionStatus(status)
        } catch { /* ignore */ }
      }, 3000)

      // (实时刷新定时器已被彻底删除，由每次请求时的结果和SSE单次通知接管)
    } catch (e: any) {
      message.error(`启动失败: ${e.message}`)
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    if (!sessionId) return
    try {
      await trackerApi.stop(sessionId)
      eventSourceRef.current?.close()
      eventSourceRef.current = null
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      if (refreshTimerRef.current) { clearInterval(refreshTimerRef.current); refreshTimerRef.current = null }
      setSseStatus('completed')
      setSessionStatus(prev => prev ? { ...prev, status: 'stopped' } : null)
      message.success('追踪已停止')
      // 停止后刷新一页
      fetchPage(currentPage, pageSize)
    } catch (e: any) {
      message.error(`停止失败: ${e.message}`)
    }
  }

  // ─── 回滚 SQL ─────────────────────────────────────────────

  const escapeValue = (v: string | null | undefined): string => {
    if (v === null || v === undefined) return 'NULL'
    if (v.startsWith('0x')) return v
    if (!isNaN(Number(v)) && v.trim() !== '') return v
    const escaped = v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')
    return `'${escaped}'`
  }

  const handleGenerateRollback = () => {
    if (selectedEventIds.size === 0) {
      message.warning('请先选择要回滚的事件')
      return
    }
    doGenerateRollback()
  }

  const doGenerateRollback = () => {
    // 只对当前页选中的事件生成回滚 SQL（它们已经在 currentPageData 中）
    const selectedEvents = currentPageData
      .filter(e => selectedEventIds.has(e.id))
      .sort((a, b) => b.timestamp - a.timestamp)

    if (selectedEvents.length === 0) {
      message.warning('选中的事件不在当前页')
      return
    }

    const sqlStatements: string[] = []
    const warnings: string[] = []

    sqlStatements.push('-- ====== EasyDB 回滚 SQL ======')
    sqlStatements.push(`-- 生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
    sqlStatements.push(`-- 事件数量: ${selectedEvents.length}`)
    sqlStatements.push('-- 请仔细核对后在事务中执行')
    sqlStatements.push('')
    sqlStatements.push('BEGIN;')
    sqlStatements.push('')

    let insertCount = 0, updateCount = 0, deleteCount = 0
    const tableSet = new Set<string>()
    let totalRows = 0

    for (const event of selectedEvents) {
      const db = event.database
      const table = event.table
      tableSet.add(`${db}.${table}`)
      sqlStatements.push(`-- 回滚 ${event.eventType} ${db}.${table} (${new Date(event.timestamp).toLocaleString('zh-CN', { hour12: false })})`)

      if (event.eventType === 'INSERT') {
        const rows = event.rowsAfter || []
        for (const row of rows) {
          const where = Object.entries(row)
            .map(([k, v]) => v === null ? `\`${k}\` IS NULL` : `\`${k}\` = ${escapeValue(v)}`)
            .join(' AND ')
          if (where) {
            sqlStatements.push(`DELETE FROM \`${db}\`.\`${table}\` WHERE ${where} LIMIT 1;`)
            deleteCount++; totalRows++
          }
        }
      } else if (event.eventType === 'DELETE') {
        const rows = event.rowsBefore || []
        for (const row of rows) {
          const cols = Object.keys(row).map(k => `\`${k}\``).join(', ')
          const vals = Object.values(row).map(v => escapeValue(v)).join(', ')
          sqlStatements.push(`INSERT INTO \`${db}\`.\`${table}\` (${cols}) VALUES (${vals});`)
          insertCount++; totalRows++
        }
      } else if (event.eventType === 'UPDATE') {
        const beforeRows = event.rowsBefore || []
        const afterRows = event.rowsAfter || []
        for (let i = 0; i < Math.min(beforeRows.length, afterRows.length); i++) {
          const before = beforeRows[i]
          const after = afterRows[i]
          const changed = Object.entries(before).filter(([k, v]) => after[k] !== v)
          if (changed.length === 0) continue
          const setClause = changed.map(([k, v]) => `\`${k}\` = ${escapeValue(v)}`).join(', ')
          const where = Object.entries(after)
            .map(([k, v]) => v === null ? `\`${k}\` IS NULL` : `\`${k}\` = ${escapeValue(v)}`)
            .join(' AND ')
          if (where) {
            sqlStatements.push(`UPDATE \`${db}\`.\`${table}\` SET ${setClause} WHERE ${where} LIMIT 1;`)
            updateCount++; totalRows++
          }
        }
      }
      sqlStatements.push('')
    }
    sqlStatements.push('COMMIT;')

    setRollbackSql(sqlStatements)
    setRollbackSummary({ tables: tableSet.size, rows: totalRows, insertCount, updateCount, deleteCount })
    setRollbackWarnings(warnings)
    setRollbackModal(true)
    if (totalRows > 0) message.success(`已生成 ${totalRows} 条回滚 SQL`)
  }

  const handleCopySql = () => {
    navigator.clipboard.writeText(rollbackSql.join('\n')).then(() => {
      message.success('已复制到剪贴板')
    })
  }

  const handleDownloadSql = () => {
    const content = rollbackSql.join('\n')
    const blob = new Blob([content], { type: 'text/sql;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `rollback_${dayjs().format('YYYYMMDD_HHmmss')}.sql`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    message.success('SQL 文件已下载')
  }

  // ─── UI 辅助 ───────────────────────────────────────────────

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const copyCell = (value: string | null | undefined) => {
    if (value === null || value === undefined) return
    navigator.clipboard.writeText(String(value)).then(() => {
      message.success('已复制', 0.8)
    })
  }

  const isRunning = sessionStatus?.status === 'running'
  const isCompleted = sessionStatus?.status === 'completed' || sseStatus === 'completed'

  const diffColors = {
    deleteBg: isDark ? '#2a1215' : '#FFF1F0',
    deleteText: isDark ? '#F5222D' : '#CF1322',
    insertBg: isDark ? '#162312' : '#F6FFED',
    insertText: isDark ? '#52C41A' : '#389E0D',
    muted: isDark ? '#595959' : '#8c8c8c',
    border: isDark ? '#303030' : '#f0f0f0',
  }

  const typeStyles = {
    INSERT: { bg: diffColors.insertBg, border: '#52C41A', tag: 'success' as const, label: 'INSERT' },
    UPDATE: { bg: isDark ? '#111a2c' : '#E6F4FF', border: '#1677FF', tag: 'processing' as const, label: 'UPDATE' },
    DELETE: { bg: diffColors.deleteBg, border: '#FF4D4F', tag: 'error' as const, label: 'DELETE' },
  }

  // ─── 表格列定义 ─────────────────────────────────────────────

  const columns = [
    {
      title: '',
      width: 40,
      onCell: () => ({ onClick: (e: React.MouseEvent) => e.stopPropagation() }),
      render: (_: any, record: ChangeEvent) => (
        <Checkbox
          checked={selectedEventIds.has(record.id)}
          onChange={(e) => {
            setSelectedEventIds(prev => {
              const next = new Set(prev)
              if (e.target.checked) next.add(record.id)
              else next.delete(record.id)
              return next
            })
          }}
        />
      ),
    },
    {
      title: '时间',
      dataIndex: 'timestamp',
      width: 200,
      render: (ts: number) => {
        const d = new Date(ts)
        const year = d.getFullYear()
        const month = String(d.getMonth() + 1).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        const time = d.toLocaleTimeString('zh-CN', { hour12: false })
        const ms = String(d.getMilliseconds()).padStart(3, '0')
        return <Text style={{ fontSize: 12, fontFamily: 'monospace' }}>
          {year}-{month}-{day} {time}.{ms}
        </Text>
      },
    },
    {
      title: '操作',
      dataIndex: 'eventType',
      width: 90,
      render: (type: string) => {
        const config = eventTypeConfig[type]
        return <Tag color={config?.color} style={{ fontWeight: 600, fontSize: 11 }}>{config?.label || type}</Tag>
      },
    },
    {
      title: '数据库',
      dataIndex: 'database',
      width: 120,
      ellipsis: true,
    },
    {
      title: '表',
      dataIndex: 'table',
      width: 160,
      ellipsis: true,
      render: (name: string) => <Text strong style={{ fontSize: 13 }}>{name}</Text>,
    },
    {
      title: '行数',
      dataIndex: 'rowCount',
      width: 60,
      render: (n: number) => <Tag>{n}</Tag>,
    },
    {
      title: '位点',
      width: 200,
      render: (_: any, record: ChangeEvent) => (
        <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>
          {record.sourceInfo?.file}:{record.sourceInfo?.position}
        </Text>
      ),
    },
  ]

  // ─── 详情面板 ────────────────────────────────────────────────

  const renderDetailPanel = (record: ChangeEvent) => {
    const cols = record.columns || []
    const style = typeStyles[record.eventType as keyof typeof typeStyles] || typeStyles.UPDATE

    const thStyle: React.CSSProperties = {
      padding: '6px 10px', fontWeight: 600, fontSize: 11, color: diffColors.muted,
      textTransform: 'uppercase', letterSpacing: '0.03em',
      background: `${style.border}08`, borderBottom: `1px solid ${style.border}18`,
      whiteSpace: 'nowrap', textAlign: 'left',
    }
    const tdStyle: React.CSSProperties = {
      padding: '5px 10px', borderBottom: `1px solid ${diffColors.border}`,
      maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis',
      whiteSpace: 'nowrap', fontSize: 12,
      fontFamily: "'SFMono-Regular', Consolas, monospace",
      cursor: 'pointer',
    }

    const header = (
      <div style={{ padding: '10px 14px', borderBottom: `1px solid ${style.border}20`,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag color={style.tag} style={{ margin: 0, fontSize: 11, fontWeight: 600 }}>{style.label}</Tag>
        <Text strong style={{ fontSize: 13 }}>{record.database}.{record.table}</Text>
        <Text style={{ fontSize: 11, color: diffColors.muted }}>{record.rowCount} 行</Text>
        <Text style={{ fontSize: 11, color: isDark ? '#595959' : '#bfbfbf', marginLeft: 'auto', fontFamily: 'monospace' }}>
          {new Date(record.timestamp).toLocaleString('zh-CN', { hour12: false })}
        </Text>
      </div>
    )

    if (record.eventType === 'UPDATE' && record.rowsBefore?.length && record.rowsAfter?.length) {
      return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          {header}
          <div style={{ flex: 1, overflow: 'auto', padding: 0 }}>
            {record.rowsBefore.map((before, rowIdx) => {
              const after = record.rowsAfter?.[rowIdx] || {}
              return (
                <div key={rowIdx}>
                  {rowIdx > 0 && <Divider style={{ margin: 0 }} />}
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...thStyle, width: 120 }}>列名</th>
                        <th style={thStyle}>变更前</th>
                        <th style={thStyle}>变更后</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cols.map(col => {
                        const isChanged = before[col] !== after[col]
                        return (
                          <tr key={col} style={{ opacity: isChanged ? 1 : 0.5 }}>
                            <td style={{ ...tdStyle, fontWeight: isChanged ? 600 : 400,
                              color: isChanged ? (isDark ? '#d9d9d9' : '#262626') : diffColors.muted, width: 120,
                              fontFamily: 'inherit', cursor: 'default' }}>
                              {col}
                            </td>
                            <Tooltip title="点击复制" mouseEnterDelay={0.5}>
                              <td style={{ ...tdStyle,
                                background: isChanged ? diffColors.deleteBg : 'transparent',
                                color: isChanged ? diffColors.deleteText : diffColors.muted,
                              }}
                              onClick={() => copyCell(before[col])}>
                                {before[col] ?? <span style={{ color: '#d9d9d9', fontStyle: 'italic' }}>NULL</span>}
                              </td>
                            </Tooltip>
                            <Tooltip title="点击复制" mouseEnterDelay={0.5}>
                              <td style={{ ...tdStyle,
                                background: isChanged ? diffColors.insertBg : 'transparent',
                                color: isChanged ? diffColors.insertText : diffColors.muted,
                              }}
                              onClick={() => copyCell(after[col])}>
                                {after[col] ?? <span style={{ color: '#d9d9d9', fontStyle: 'italic' }}>NULL</span>}
                              </td>
                            </Tooltip>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            })}
          </div>
        </div>
      )
    }

    // INSERT / DELETE
    const rows = record.eventType === 'INSERT' ? record.rowsAfter : record.rowsBefore
    if (!rows?.length) return <div style={{ padding: 16 }}><Text type="secondary">无行数据</Text></div>

    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        {header}
        <div style={{ flex: 1, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {cols.map(col => <th key={col} style={thStyle}>{col}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {cols.map(col => (
                    <Tooltip key={col} title="点击复制" mouseEnterDelay={0.5}>
                      <td style={{ ...tdStyle,
                        color: record.eventType === 'INSERT' ? diffColors.insertText : diffColors.deleteText,
                      }}
                      onClick={() => copyCell(row[col])}>
                        {row[col] ?? <span style={{ color: '#d9d9d9', fontStyle: 'italic' }}>NULL</span>}
                      </td>
                    </Tooltip>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {record.rowCount > (rows?.length || 0) && (
            <div style={{ padding: '6px 12px', textAlign: 'center', color: diffColors.muted, fontSize: 11 }}>
              仅显示前 {rows.length} 行，共 {record.rowCount} 行
            </div>
          )}
        </div>
      </div>
    )
  }

  // ─── 渲染 ──────────────────────────────────────────────────

  return (
    <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column', gap: 16, overflow: 'hidden' }}>
      {/* 顶部工具栏 */}
      <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space size={12}>
            <ThunderboltOutlined style={{ fontSize: 18, color: token.colorWarning }} />
            <Text strong style={{ fontSize: 15 }}>数据追踪</Text>

            <Segmented
              value={mode}
              onChange={(v) => setMode(v as 'realtime' | 'replay')}
              options={[
                { value: 'realtime', label: '实时追踪', icon: <ThunderboltOutlined /> },
                { value: 'replay', label: '历史回放', icon: <HistoryOutlined /> },
              ]}
              size="small"
              disabled={isRunning}
            />

            <Select
              style={{ width: 220 }}
              placeholder="选择数据库连接"
              value={selectedConnId || undefined}
              onChange={setSelectedConnId}
              options={connections.map(c => ({
                value: c.id,
                label: `${c.name} (${c.host}:${c.port})`,
              }))}
              disabled={isRunning}
            />

            {!isRunning && !isCompleted ? (
              <Button
                type="primary"
                icon={mode === 'realtime' ? <PlayCircleOutlined /> : <HistoryOutlined />}
                onClick={handleStart}
                disabled={!selectedConnId || !serverCheck?.compatible || (mode === 'replay' && !startFile)}
                loading={starting}
              >
                {mode === 'realtime' ? '开始追踪' : '开始回放'}
              </Button>
            ) : (
              <Button
                danger
                icon={<PauseCircleOutlined />}
                onClick={handleStop}
                disabled={isCompleted}
              >
                {isCompleted ? '回放完成' : '停止追踪'}
              </Button>
            )}

            <Tooltip title="重新检查">
              <Button
                icon={<ReloadOutlined />}
                onClick={handleCheck}
                loading={checking}
                disabled={!selectedConnId}
                size="small"
              />
            </Tooltip>
          </Space>

          <Space>
            {(isRunning || sseStatus === 'receiving') && (
              <Space size={16}>
                <Badge status="processing" text={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {sseStatus === 'receiving' ? '接收中' : '监听中'}
                  </Text>
                } />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  事件: <Text strong>{totalCount.toLocaleString()}</Text>
                </Text>
                {rate > 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    速率: <Text strong>{rate.toLocaleString()}</Text>/s
                  </Text>
                )}
                {sessionStatus?.currentFile && (
                  <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>
                    {sessionStatus.currentFile}:{sessionStatus.currentPosition}
                  </Text>
                )}
              </Space>
            )}
            {isCompleted && (
              <Badge status="success" text={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  完成 · 共 <Text strong>{totalCount.toLocaleString()}</Text> 条
                </Text>
              } />
            )}
          </Space>
        </div>
      </Card>

      {/* 服务端检查结果 */}
      {serverCheck && !serverCheck.compatible && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="服务端配置不兼容"
          description={
            <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
              {serverCheck.issues.map((issue, i) => <li key={i}>{issue}</li>)}
            </ul>
          }
          closable
        />
      )}

      {serverCheck?.compatible && !sessionId && (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message={`服务端兼容 — Binlog: ${serverCheck.binlogFormat}, Row Image: ${serverCheck.binlogRowImage}, 当前位点: ${serverCheck.currentFile}:${serverCheck.currentPosition}`}
          closable
        />
      )}

      {/* 回放模式配置面板 */}
      {mode === 'replay' && serverCheck?.compatible && !isRunning && !isCompleted && (
        <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
          <Space size={16} wrap align="center">
            <DatabaseOutlined style={{ color: token.colorPrimary }} />
            <Text strong style={{ fontSize: 13 }}>Binlog 回放配置</Text>
            <Space size={8}>
              <Text type="secondary" style={{ fontSize: 12 }}>起始文件:</Text>
              <Select
                style={{ width: 220 }}
                value={startFile}
                onChange={(v) => { setStartFile(v); setStartPosition(4) }}
                loading={loadingFiles}
                options={binlogFiles.map(f => ({
                  value: f.file,
                  label: `${f.file}  (${formatSize(f.size)})`,
                }))}
                placeholder="选择 binlog 文件"
                size="small"
              />
            </Space>
            <Space size={8}>
              <Text type="secondary" style={{ fontSize: 12 }}>起始位置:</Text>
              <InputNumber value={startPosition} onChange={(v) => setStartPosition(v || 4)} min={4} size="small" style={{ width: 110 }} />
            </Space>
            <Divider type="vertical" style={{ margin: 0 }} />
            <Space size={8}>
              <Text type="secondary" style={{ fontSize: 12 }}>截止文件:</Text>
              <Select
                style={{ width: 220 }}
                value={endFile}
                onChange={setEndFile}
                allowClear
                options={binlogFiles.map(f => ({
                  value: f.file,
                  label: `${f.file}  (${formatSize(f.size)})`,
                }))}
                placeholder="到当前末尾"
                size="small"
              />
            </Space>
            <Space size={8}>
              <Text type="secondary" style={{ fontSize: 12 }}>截止位置:</Text>
              <InputNumber value={endPosition} onChange={(v) => setEndPosition(v || undefined)} min={4} size="small" style={{ width: 110 }} disabled={!endFile} placeholder="文件末尾" />
            </Space>
            <Tooltip title="刷新 Binlog 文件列表">
              <Button icon={<ReloadOutlined />} size="small" onClick={loadBinlogFiles} loading={loadingFiles} />
            </Tooltip>
          </Space>
        </Card>
      )}

      {/* 主体：筛选 + 事件列表 */}
      <div style={{ flex: 1, display: 'flex', gap: 16, overflow: 'hidden' }}>
        {/* 左侧筛选面板 */}
        <Card size="small" style={{ width: 200, flexShrink: 0, overflow: 'auto' }}
          styles={{ body: { padding: 12 } }}
        >
          <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>操作类型</Text>
          <Segmented
            value={filterType}
            onChange={(v) => setFilterType(v as string)}
            options={[
              { value: 'ALL', label: '全部' },
              { value: 'INSERT', label: 'INS' },
              { value: 'UPDATE', label: 'UPD' },
              { value: 'DELETE', label: 'DEL' },
            ]}
            size="small"
            block
            style={{ marginBottom: 16 }}
          />

          <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>表筛选</Text>
          <Select
            style={{ width: '100%' }}
            size="small"
            placeholder="所有表"
            value={filterTable || undefined}
            onChange={(v) => setFilterTable(v || '')}
            allowClear
            options={(stats?.tables || []).map(t => ({ value: t, label: t }))}
          />

          <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 8, marginTop: 16 }}>时间范围</Text>
          <RangePicker
            size="small"
            showTime
            style={{ width: '100%' }}
            format="MM-DD HH:mm"
            value={timeRange}
            onChange={(dates) => setTimeRange(dates as [Dayjs, Dayjs] | null)}
            allowClear
            placeholder={['开始', '结束']}
          />



          <Divider style={{ margin: '16px 0' }} />

          <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>操作</Text>
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Button
              icon={<RollbackOutlined />}
              size="small"
              block
              onClick={handleGenerateRollback}
              disabled={selectedEventIds.size === 0}
            >
              生成回滚 SQL ({selectedEventIds.size})
            </Button>
            <Button
              icon={<FileTextOutlined />}
              size="small"
              block
              onClick={() => {
                const allIds = new Set(currentPageData.map(e => e.id))
                setSelectedEventIds(prev => prev.size === allIds.size ? new Set() : allIds)
              }}
            >
              {selectedEventIds.size === currentPageData.length && currentPageData.length > 0 ? '取消全选' : '全选当前页'}
            </Button>
          </Space>

          {/* 统计信息 */}
          {stats && (
            <>
              <Divider style={{ margin: '16px 0' }} />

              <Text strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>类型分布</Text>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {Object.entries(eventTypeConfig).map(([type, cfg]) => {
                  const count = type === 'INSERT' ? stats.insertCount
                    : type === 'UPDATE' ? stats.updateCount
                    : stats.deleteCount
                  const total = stats.insertCount + stats.updateCount + stats.deleteCount
                  const barWidth = total > 0 ? (count / total) * 100 : 0
                  return (
                    <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <Tag color={cfg.color} style={{ fontSize: 10, margin: 0, padding: '0 4px', lineHeight: '18px', minWidth: 44, textAlign: 'center' }}>
                        {cfg.label}
                      </Tag>
                      <div style={{ flex: 1, height: 6, borderRadius: 3, background: diffColors.border, overflow: 'hidden' }}>
                        <div style={{
                          width: `${barWidth}%`, height: '100%', borderRadius: 3,
                          background: cfg.color, transition: 'width 0.3s ease',
                        }} />
                      </div>
                      <Text style={{ fontSize: 11, fontFamily: 'monospace', minWidth: 36, textAlign: 'right' }}>
                        {count.toLocaleString()}
                      </Text>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </Card>

        {/* 中间事件列表 */}
        <Card size="small" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}
          styles={{ body: { padding: 0, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' } }}
        >
          {currentPageData.length === 0 && !isRunning && !isCompleted && sseStatus !== 'receiving' ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Empty
                image={<ThunderboltOutlined style={{ fontSize: 48, color: token.colorTextQuaternary }} />}
                description={
                  <Space direction="vertical" size={4}>
                    <Text type="secondary">选择一个连接并开始追踪</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      实时捕获 INSERT / UPDATE / DELETE 操作
                    </Text>
                  </Space>
                }
              />
            </div>
          ) : sseStatus === 'receiving' && currentPageData.length === 0 ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Space direction="vertical" align="center" size={12}>
                <ThunderboltOutlined style={{ fontSize: 36, color: token.colorWarning }} />
                <Text strong style={{ fontSize: 16 }}>正在{mode === 'replay' ? '回放' : '追踪'}...</Text>
                <Text type="secondary" style={{ fontSize: 14 }}>
                  已接收 <Text strong style={{ fontSize: 18, color: token.colorPrimary }}>{totalCount.toLocaleString()}</Text> 条事件
                </Text>
                {rate > 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    速率: {rate.toLocaleString()} 条/秒
                  </Text>
                )}
                {mode === 'replay' && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    回放完成后将自动加载数据
                  </Text>
                )}
                {totalCount > 0 && (
                  <Button size="small" type="primary" onClick={() => fetchPage(1, pageSize)}>
                    加载数据
                  </Button>
                )}
              </Space>
            </div>
          ) : (
            <div style={{ position: 'relative', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <Table
                key={String(filterType) + String(filterTable)} // 强制彻底销毁与重建，根治底层复用导致的幻影DOM行
                dataSource={currentPageData}
                columns={columns}
                rowKey="id"
                size="small"
                loading={loadingPage}
                pagination={{
                  current: currentPage,
                  pageSize: pageSize,
                  total: pageTotal,
                  showSizeChanger: true,
                  pageSizeOptions: ['20', '50', '100'],
                  showTotal: (total) => `共 ${total.toLocaleString()} 条${totalCount > total ? ` · 总接收 ${totalCount.toLocaleString()}` : ''}`,
                  onChange: (page, size) => {
                    setCurrentPage(page)
                    setPageSize(size)
                    fetchPageRef.current(page, size)
                    setSelectedEventIds(new Set()) // 翻页清空选中
                  },
                }}
                scroll={{ y: 'calc(100vh - 380px)' }}
                onRow={(record) => ({
                  onClick: () => setSelectedEvent(record),
                  style: { cursor: 'pointer' },
                })}
                rowClassName={(record) => {
                  const classes: string[] = []
                  if (selectedEventIds.has(record.id)) classes.push('tracker-row-selected')
                  if (selectedEvent?.id === record.id) classes.push('tracker-row-active')
                  return classes.join(' ')
                }}
              />

              {/* 实时模式刷新提示 */}
              {isRunning && mode === 'realtime' && (
                <Tooltip title="刷新当前数据">
                  <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    size="small"
                    shape="circle"
                    onClick={() => fetchPage(currentPage, pageSize)}
                    style={{
                      position: 'absolute', bottom: 48, right: 16,
                      boxShadow: '0 2px 8px rgba(0,0,0,0.15)', zIndex: 10,
                    }}
                  />
                </Tooltip>
              )}
            </div>
          )}
        </Card>

        {/* 右侧详情面板 */}
        {selectedEvent && (
          <Card
            size="small"
            style={{
              width: 420, flexShrink: 0, overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
              borderLeft: `3px solid ${(typeStyles[selectedEvent.eventType as keyof typeof typeStyles] || typeStyles.UPDATE).border}`,
            }}
            styles={{ body: { padding: 0, flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' } }}
            extra={
              <Button type="text" size="small" onClick={() => setSelectedEvent(null)}
                style={{ fontSize: 12, color: diffColors.muted }}>✕</Button>
            }
            title={<Text style={{ fontSize: 12 }}>事件详情</Text>}
          >
            {renderDetailPanel(selectedEvent)}
          </Card>
        )}
      </div>

      {/* 回滚 SQL Modal */}
      <Modal
        title={<Space><RollbackOutlined /> 回滚 SQL 预览</Space>}
        open={rollbackModal}
        onCancel={() => setRollbackModal(false)}
        width={720}
        styles={{ body: { maxHeight: '65vh', overflow: 'auto' } }}
        footer={[
          <Button key="close" onClick={() => setRollbackModal(false)}>关闭</Button>,
          <Button key="download" icon={<DownloadOutlined />} onClick={handleDownloadSql}
            disabled={rollbackSql.length === 0}>
            下载 SQL
          </Button>,
          <Button key="copy" type="primary"
            icon={<CopyOutlined />} onClick={handleCopySql}
            disabled={rollbackSql.length === 0}>
            复制 SQL
          </Button>,
        ]}
      >
        {rollbackSql.length === 0 ? (
          <Empty description="无可生成的回滚 SQL" />
        ) : (
          <div>
            {rollbackSummary && (
              <div style={{
                display: 'flex', gap: 16, padding: '8px 12px', marginBottom: 12,
                background: isDark ? '#1a1a1a' : '#fafafa', borderRadius: 6, fontSize: 12,
                border: `1px solid ${diffColors.border}`, flexWrap: 'wrap', alignItems: 'center',
              }}>
                <span>涉及 <Text strong>{rollbackSummary.tables}</Text> 张表</span>
                <Divider type="vertical" />
                <span>共 <Text strong>{rollbackSummary.rows.toLocaleString()}</Text> 条语句</span>
                <Divider type="vertical" />
                {rollbackSummary.insertCount > 0 && <Tag color="green" style={{ fontSize: 11 }}>INSERT ×{rollbackSummary.insertCount}</Tag>}
                {rollbackSummary.updateCount > 0 && <Tag color="blue" style={{ fontSize: 11 }}>UPDATE ×{rollbackSummary.updateCount}</Tag>}
                {rollbackSummary.deleteCount > 0 && <Tag color="red" style={{ fontSize: 11 }}>DELETE ×{rollbackSummary.deleteCount}</Tag>}
              </div>
            )}

            {rollbackWarnings.length > 0 && (
              <Alert type="warning" showIcon icon={<ExclamationCircleOutlined />} message="注意事项"
                description={
                  <ul style={{ margin: '4px 0', paddingLeft: 20, fontSize: 12 }}>
                    {rollbackWarnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                }
                style={{ marginBottom: 12 }}
              />
            )}

            <Alert type="info" showIcon
              message="回滚 SQL 已包含 BEGIN/COMMIT 事务包装，请在目标数据库中执行"
              style={{ marginBottom: 12, fontSize: 12 }}
            />

            <Input.TextArea
              value={rollbackSql.join('\n')}
              readOnly
              rows={16}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          </div>
        )}
      </Modal>

      <style>{`
        .tracker-row-selected {
          background: ${token.colorPrimaryBg} !important;
        }
        .tracker-row-selected td {
          background: ${token.colorPrimaryBg} !important;
        }
        .tracker-row-active {
          background: ${token.colorPrimaryBgHover} !important;
        }
        .tracker-row-active td {
          background: ${token.colorPrimaryBgHover} !important;
        }
        .ant-table-tbody > tr:hover > td {
          background: ${token.colorBgTextHover} !important;
        }
      `}</style>
    </div>
  )
}
