import React, { useRef, useEffect } from 'react'
import { Typography, Tag, theme } from 'antd'
import type { TaskLog } from '@/types'

const { Text } = Typography

const levelColorMap: Record<string, string> = {
  info: 'blue',
  warn: 'orange',
  error: 'red',
}

const levelLabelMap: Record<string, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
}

interface LogPanelProps {
  /** 日志列表 */
  logs: TaskLog[]
  /** 面板高度 */
  height?: number | string
  /** 是否自动滚动到底部 */
  autoScroll?: boolean
}

export const LogPanel: React.FC<LogPanelProps> = ({
  logs,
  height = 300,
  autoScroll = true,
}) => {
  const { token } = theme.useToken()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs.length, autoScroll])

  return (
    <div
      style={{
        height,
        overflow: 'auto',
        background: '#1e1e1e',
        borderRadius: token.borderRadius,
        padding: '12px 16px',
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 12,
        lineHeight: '20px',
      }}
    >
      {logs.length === 0 ? (
        <Text style={{ color: '#6a6a6a' }}>暂无日志</Text>
      ) : (
        logs.map((log) => (
          <div key={log.id} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
            <Text style={{ color: '#6a6a6a', flexShrink: 0 }}>
              {log.timestamp.slice(11, 19)}
            </Text>
            <Tag
              color={levelColorMap[log.level] ?? 'default'}
              style={{ margin: 0, fontSize: 11, lineHeight: '18px', padding: '0 4px' }}
            >
              {levelLabelMap[log.level] ?? log.level.toUpperCase()}
            </Tag>
            <Text style={{ color: log.level === 'error' ? '#ff6b6b' : '#d4d4d4' }}>
              {log.message}
            </Text>
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  )
}
