import React from 'react'
import { Tag } from 'antd'
import type { ConnectionStatus, TaskStatus } from '@/types'

// ─── 连接状态配色 ──────────────────────────────────────────
const connectionStatusMap: Record<ConnectionStatus, { color: string; label: string }> = {
  connected: { color: 'success', label: '已连接' },
  disconnected: { color: 'default', label: '未连接' },
  connecting: { color: 'processing', label: '连接中' },
  error: { color: 'error', label: '连接失败' },
}

// ─── 任务状态配色 ──────────────────────────────────────────
const taskStatusMap: Record<TaskStatus, { color: string; label: string }> = {
  pending: { color: 'default', label: '等待中' },
  running: { color: 'processing', label: '运行中' },
  completed: { color: 'success', label: '已完成' },
  failed: { color: 'error', label: '失败' },
  cancelled: { color: 'warning', label: '已取消' },
}

// ─── 连接状态标签 ──────────────────────────────────────────
interface ConnectionStatusTagProps {
  status: ConnectionStatus
}

export const ConnectionStatusTag: React.FC<ConnectionStatusTagProps> = ({ status }) => {
  const config = connectionStatusMap[status] ?? connectionStatusMap.disconnected
  return <Tag color={config.color}>{config.label}</Tag>
}

// ─── 任务状态标签 ──────────────────────────────────────────
interface TaskStatusTagProps {
  status: TaskStatus
}

export const TaskStatusTag: React.FC<TaskStatusTagProps> = ({ status }) => {
  const config = taskStatusMap[status] ?? taskStatusMap.pending
  return <Tag color={config.color}>{config.label}</Tag>
}
