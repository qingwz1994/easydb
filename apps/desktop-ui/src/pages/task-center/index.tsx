/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Layout, Table, Typography, Space, Select, Button, Progress, Input,
  theme, Descriptions, Card, Tag, Collapse,
} from 'antd'
import {
  UnorderedListOutlined, ReloadOutlined,
  ClockCircleOutlined, StopOutlined, SearchOutlined,
  DownloadOutlined, CheckCircleOutlined, WarningOutlined, CloseCircleOutlined,
  DeleteOutlined, ClearOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { TaskInfo, TaskLog } from '@/types'
import { useTaskStore } from '@/stores/taskStore'
import { taskApi } from '@/services/api'
import { TaskStatusTag } from '@/components/StatusTag'
import { LogPanel } from '@/components/LogPanel'
import { confirmDanger } from '@/components/confirmDanger'
import { EmptyState } from '@/components/EmptyState'
import { toast, handleApiError } from '@/utils/notification'
import { formatDateTime, formatDuration, getElapsedMs } from '@/utils/format'

const { Sider } = Layout
const { Title, Text } = Typography

const TASK_TYPE_LABELS: Record<string, string> = {
  migration: '迁移',
  sync: '同步',
  export: '导出',
  import: '导入',
}

export const TaskCenterPage: React.FC = () => {
  const { token } = theme.useToken()

  const tasks = useTaskStore((s) => s.tasks)
  const setTasks = useTaskStore((s) => s.setTasks)
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId)
  const setSelectedTask = useTaskStore((s) => s.setSelectedTask)
  const taskLogs = useTaskStore((s) => s.taskLogs)
  const setTaskLogs = useTaskStore((s) => s.setTaskLogs)

  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>()
  const [typeFilter, setTypeFilter] = useState<string>()
  const [searchText, setSearchText] = useState('')
  const [logExpanded, setLogExpanded] = useState(false)
  const [, setTick] = useState(0)

  const loadTasks = useCallback(async () => {
    setLoading(true)
    try {
      const list = await taskApi.list(statusFilter) as TaskInfo[]
      setTasks(list)
    } catch (e) {
      handleApiError(e, '加载任务列表失败')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, setTasks])

  useEffect(() => { loadTasks() }, [loadTasks])

  const loadLogs = useCallback(async (taskId: string) => {
    try {
      const logs = await taskApi.logs(taskId) as TaskLog[]
      setTaskLogs(taskId, logs)
    } catch (e) {
      handleApiError(e, '加载日志失败')
    }
  }, [setTaskLogs])

  useEffect(() => {
    const hasRunningTask = tasks.some((t) => t.status === 'running')
    if (!hasRunningTask) return

    const timer = setInterval(() => {
      loadTasks()
      if (selectedTaskId && logExpanded) loadLogs(selectedTaskId)
      setTick((t) => t + 1)
    }, 2000)
    return () => clearInterval(timer)
  }, [tasks, loadTasks, selectedTaskId, loadLogs, logExpanded])

  // 搜索 + 类型过滤
  const filteredTasks = tasks.filter((t) => {
    const matchSearch = !searchText || t.name.toLowerCase().includes(searchText.toLowerCase())
    const matchType = !typeFilter || t.type === typeFilter
    return matchSearch && matchType
  })

  const handleSelectTask = (task: TaskInfo) => {
    setSelectedTask(task.id)
    setLogExpanded(false) // 切换任务时折叠日志
  }

  const handleLogExpand = (keys: string | string[]) => {
    const expanded = Array.isArray(keys) ? keys.includes('logs') : keys === 'logs'
    setLogExpanded(expanded)
    if (expanded && selectedTaskId) {
      loadLogs(selectedTaskId)
    }
  }

  const handleCancel = (task: TaskInfo) => {
    confirmDanger({
      title: '取消任务',
      content: `确定要取消任务「${task.name}」吗？`,
      okText: '取消任务',
      onOk: async () => {
        await taskApi.cancel(task.id)
        toast.success('任务已取消')
        loadTasks()
      },
    })
  }

  const handleDelete = (task: TaskInfo) => {
    confirmDanger({
      title: '删除任务',
      content: `确定要删除任务「${task.name}」吗？删除后不可恢复。`,
      okText: '删除',
      onOk: async () => {
        await taskApi.delete(task.id)
        toast.success('任务已删除')
        if (selectedTaskId === task.id) setSelectedTask('')
        loadTasks()
      },
    })
  }

  const handleClearCompleted = () => {
    confirmDanger({
      title: '清空已完成任务',
      content: '确定要清空所有已完成、失败和已取消的任务吗？',
      okText: '清空',
      onOk: async () => {
        const res = await taskApi.clearCompleted() as { cleared: number }
        toast.success(`已清空 ${res.cleared} 条任务`)
        setSelectedTask('')
        loadTasks()
      },
    })
  }

  // 日志导出 (下载物理日志文件)
  const handleExportLogs = () => {
    if (!selectedTaskId || !selectedTask) return
    const url = `http://localhost:18080/api/task/${selectedTaskId}/download-log`
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedTask.name}-log.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    toast.success('物理日志下载已启动')
  }

  const selectedTask = tasks.find((t) => t.id === selectedTaskId)
  const selectedLogs = selectedTaskId ? (taskLogs[selectedTaskId] ?? []) : []

  const columns: ColumnsType<TaskInfo> = [
    { title: '任务名称', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 80,
      render: (t: string) => <Tag>{TASK_TYPE_LABELS[t] ?? t}</Tag>,
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 90,
      render: (status) => <TaskStatusTag status={status} />,
    },
    {
      title: '进度', dataIndex: 'progress', key: 'progress', width: 120,
      render: (p: number) => <Progress percent={p} size="small" />,
    },
    {
      title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 150,
      render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{formatDateTime(v)}</Text> : '-',
    },
    {
      title: '耗时', key: 'duration', width: 100,
      render: (_, record) => {
        if (record.status === 'running' && record.startedAt) {
          return <Text type="secondary"><ClockCircleOutlined style={{ marginRight: 4 }} />{formatDuration(getElapsedMs(record.startedAt))}</Text>
        }
        if (record.duration != null) {
          return <Text type="secondary">{formatDuration(record.duration)}</Text>
        }
        return <Text type="secondary">—</Text>
      },
    },
    {
      title: '操作', key: 'actions', width: 80,
      render: (_, record) => (
        <Space size={0}>
          {record.status === 'running' && (
            <Button type="text" size="small" danger icon={<StopOutlined />} onClick={(e) => { e.stopPropagation(); handleCancel(record) }} />
          )}
          {record.status !== 'running' && record.status !== 'pending' && (
            <Button type="text" size="small" icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); handleDelete(record) }} />
          )}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 头部 (Header) */}
      <div style={{ 
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
        marginBottom: 16, padding: '16px 24px', background: token.colorBgContainer, 
        borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.02)', border: `1px solid ${token.colorBorderSecondary}`
      }}>
        <Title level={5} style={{ margin: 0 }}>
          <UnorderedListOutlined style={{ marginRight: 8, color: token.colorPrimary }} />
          异步任务调度中心 (Task Center)
        </Title>
        <Space>
          <Input
            placeholder="搜索任务..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 180 }}
            allowClear
          />
          <Select
            value={typeFilter} onChange={setTypeFilter}
            placeholder="任务类型" allowClear
            style={{ width: 100 }}
            options={[
              { value: 'migration', label: '迁移' },
              { value: 'sync', label: '同步' },
              { value: 'export', label: '导出' },
              { value: 'import', label: '导入' },
            ]}
          />
          <Select
            value={statusFilter} onChange={setStatusFilter}
            placeholder="筛选状态" allowClear
            style={{ width: 120 }}
            options={[
              { value: 'running', label: '运行中' },
              { value: 'completed', label: '已完成' },
              { value: 'failed', label: '失败' },
              { value: 'cancelled', label: '已取消' },
            ]}
          />
          <Button icon={<ClearOutlined />} onClick={handleClearCompleted} disabled={tasks.length === 0} danger>清空历史痕迹</Button>
          <Button icon={<ReloadOutlined />} onClick={loadTasks} type="primary" ghost>刷新</Button>
        </Space>
      </div>

      <Layout style={{ flex: 1, minHeight: 0, background: 'transparent', gap: 16 }}>
        {/* 左侧主要任务列表面板 */}
        <div style={{ 
          flex: 1, background: token.colorBgContainer, borderRadius: 8, 
          boxShadow: '0 2px 8px rgba(0,0,0,0.02)', border: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden'
        }}>
          {tasks.length === 0 && !loading ? (
            <EmptyState description="暂无任务，在「迁移 / 同步 / 导出 / 导入」中创建任务" />
          ) : (
            <Table
              columns={columns}
              dataSource={filteredTasks}
              rowKey="id"
              loading={loading}
              pagination={false}
              size="small"
              onRow={(record) => ({
                onClick: () => handleSelectTask(record),
                style: {
                  cursor: 'pointer',
                  background: record.id === selectedTaskId ? token.colorPrimaryBg : undefined,
                },
              })}
              locale={{
                emptyText: searchText || statusFilter || typeFilter
                  ? '没有匹配的任务'
                  : '暂无任务',
              }}
            />
          )}
        </div>

        {/* 右侧详情侧边栏 */}
        {selectedTask && (
          <Sider
            width={400}
            style={{
              background: token.colorBgContainer,
              borderRadius: 8,
              border: `1px solid ${token.colorBorderSecondary}`,
              boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
              padding: 24,
              overflow: 'auto',
            }}
          >
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}`, paddingBottom: 16 }}>
                <Text strong style={{ fontSize: 16, display: 'block', marginBottom: 4 }}>{selectedTask.name}</Text>
                <Text type="secondary" style={{ fontSize: 13 }}>ID: {selectedTask.id}</Text>
              </div>

              <Descriptions column={1} size="small" labelStyle={{ color: token.colorTextSecondary }}>
                <Descriptions.Item label="类型">{TASK_TYPE_LABELS[selectedTask.type] ?? selectedTask.type}</Descriptions.Item>
                <Descriptions.Item label="状态"><TaskStatusTag status={selectedTask.status} /></Descriptions.Item>
                <Descriptions.Item label="进度"><Progress percent={selectedTask.progress} size="small" style={{ marginBottom: 0 }} /></Descriptions.Item>
                {(selectedTask.successCount != null || selectedTask.failureCount != null) && (
                  <Descriptions.Item label="表统计">
                    共 {(selectedTask.successCount ?? 0) + (selectedTask.failureCount ?? 0)} 张
                    <Text type="secondary" style={{ marginLeft: 4, fontSize: 12 }}>
                      （成功 {selectedTask.successCount ?? 0} · 失败 {selectedTask.failureCount ?? 0}）
                    </Text>
                  </Descriptions.Item>
                )}
                {selectedTask.createdAt && (
                  <Descriptions.Item label="创建时间">{formatDateTime(selectedTask.createdAt)}</Descriptions.Item>
                )}
                {selectedTask.startedAt && (
                  <Descriptions.Item label="开始时间">{formatDateTime(selectedTask.startedAt)}</Descriptions.Item>
                )}
                {selectedTask.duration != null && (
                  <Descriptions.Item label="耗时">{formatDuration(selectedTask.duration)}</Descriptions.Item>
                )}
                {selectedTask.status === 'running' && selectedTask.startedAt && selectedTask.duration == null && (
                  <Descriptions.Item label="已用时">
                    <ClockCircleOutlined style={{ marginRight: 4 }} />
                    {formatDuration(getElapsedMs(selectedTask.startedAt))}
                  </Descriptions.Item>
                )}
              </Descriptions>

              {selectedTask.errorMessage && (
                <Card size="small" title="错误信息" style={{ borderColor: token.colorError }}>
                  <Text type="danger" style={{ fontSize: 12 }}>{selectedTask.errorMessage}</Text>
                </Card>
              )}

              {selectedTask.progressMessage && (
                <Card size="small" title="当前步骤">
                  <Text type="secondary" style={{ fontSize: 12 }}>{selectedTask.progressMessage}</Text>
                </Card>
              )}

              {/* 数据验证报告 */}
              {selectedTask.verification && selectedTask.verification.length > 0 && (() => {
                const v = selectedTask.verification!
                const matchCount = v.filter(i => i.status === 'match').length
                const mismatchCount = v.filter(i => i.status === 'mismatch').length
                const failedCount = v.filter(i => i.status === 'failed').length
                const anomalies = v.filter(i => i.status !== 'match')
                const matched = v.filter(i => i.status === 'match')

                const renderItem = (item: typeof v[0]) => (
                  <div key={item.tableName} style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ fontSize: 12, fontFamily: 'monospace' }}>{item.tableName}</Text>
                      <Space size={8}>
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {item.sourceRows.toLocaleString()} → {item.targetRows.toLocaleString()}
                        </Text>
                        {item.status === 'match' && <Tag color="success" style={{ margin: 0 }}>匹配</Tag>}
                        {item.status === 'mismatch' && <Tag color="warning" style={{ margin: 0 }}>不匹配</Tag>}
                        {item.status === 'failed' && <Tag color="error" style={{ margin: 0 }}>失败</Tag>}
                      </Space>
                    </div>
                    {item.errorMessage && (
                      <Text type="danger" style={{ fontSize: 11, paddingLeft: 12 }}>{item.errorMessage}</Text>
                    )}
                  </div>
                )

                return (
                  <Card size="small" title={
                    <Space>
                      <span>📊 数据验证</span>
                      <Space size={12} style={{ fontSize: 12, fontWeight: 'normal' }}>
                        <span><CheckCircleOutlined style={{ color: token.colorSuccess }} /> {matchCount}</span>
                        {mismatchCount > 0 && <span><WarningOutlined style={{ color: token.colorWarning }} /> {mismatchCount}</span>}
                        {failedCount > 0 && <span><CloseCircleOutlined style={{ color: token.colorError }} /> {failedCount}</span>}
                      </Space>
                    </Space>
                  }>
                    <Collapse
                      size="small"
                      defaultActiveKey={anomalies.length > 0 ? ['anomalies'] : ['matched']}
                      items={[
                        ...(anomalies.length > 0 ? [{
                          key: 'anomalies',
                          label: <Text type="danger" style={{ fontSize: 12 }}>异常项（{anomalies.length}）</Text>,
                          children: <div>{anomalies.map(renderItem)}</div>,
                        }] : []),
                        ...(matched.length > 0 ? [{
                          key: 'matched',
                          label: <Text type="secondary" style={{ fontSize: 12 }}>已匹配（{matched.length}）</Text>,
                          children: <div style={{ maxHeight: 200, overflow: 'auto' }}>{matched.map(renderItem)}</div>,
                        }] : []),
                      ]}
                    />
                  </Card>
                )
              })()}

              <Collapse
                size="small"
                activeKey={logExpanded ? ['logs'] : []}
                onChange={handleLogExpand}
                items={[{
                  key: 'logs',
                  label: (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                      <Text strong style={{ fontSize: 13 }}>执行日志</Text>
                      <Button
                        size="small"
                        icon={<DownloadOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleExportLogs() }}
                        disabled={selectedLogs.length === 0}
                      >
                        导出
                      </Button>
                    </div>
                  ),
                  children: <LogPanel logs={selectedLogs} height={240} />,
                }]}
              />
            </Space>
          </Sider>
        )}
      </Layout>
    </div>
  )
}
