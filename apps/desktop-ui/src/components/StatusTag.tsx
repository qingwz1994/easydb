import React from 'react'
import type { ConnectionStatus, TaskStatus } from '@/types'

// ─── 连接状态配色 ──────────────────────────────────────────
const connectionStatusMap: Record<ConnectionStatus, { color: string; label: string; pulse?: boolean }> = {
  connected:    { color: 'var(--edb-success)',  label: '已连接' },
  disconnected: { color: 'var(--edb-text-muted)', label: '未连接' },
  connecting:   { color: 'var(--edb-warning)',  label: '连接中', pulse: true },
  error:        { color: 'var(--edb-error)',    label: '连接失败' },
}

// ─── 任务状态配色 ──────────────────────────────────────────
const taskStatusMap: Record<TaskStatus, { color: string; label: string; pulse?: boolean }> = {
  pending:   { color: 'var(--edb-text-muted)', label: '等待中' },
  running:   { color: 'var(--edb-info)',       label: '运行中', pulse: true },
  completed: { color: 'var(--edb-success)',    label: '已完成' },
  failed:    { color: 'var(--edb-error)',       label: '失败' },
  cancelled: { color: 'var(--edb-warning)',    label: '已取消' },
}

// ─── 通用状态指示器 ──────────────────────────────────────────
interface StatusDotProps {
  color: string
  label: string
  pulse?: boolean
}

const StatusDot: React.FC<StatusDotProps> = ({ color, label, pulse }) => (
  <span className="edb-status-tag">
    <span
      className={`edb-status-dot${pulse ? ' edb-status-dot--pulse' : ''}`}
      style={{ background: color }}
    />
    {label}
  </span>
)

// ─── 连接状态标签 ──────────────────────────────────────────
interface ConnectionStatusTagProps {
  status: ConnectionStatus
}

export const ConnectionStatusTag: React.FC<ConnectionStatusTagProps> = ({ status }) => {
  const config = connectionStatusMap[status] ?? connectionStatusMap.disconnected
  return <StatusDot color={config.color} label={config.label} pulse={config.pulse} />
}

// ─── 任务状态标签 ──────────────────────────────────────────
interface TaskStatusTagProps {
  status: TaskStatus
}

export const TaskStatusTag: React.FC<TaskStatusTagProps> = ({ status }) => {
  const config = taskStatusMap[status] ?? taskStatusMap.pending
  return <StatusDot color={config.color} label={config.label} pulse={config.pulse} />
}
