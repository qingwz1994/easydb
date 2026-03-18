import React, { useEffect, useState, useCallback } from 'react'
import {
  Layout, Table, Typography, Space, Select, Button, Progress, Input,
  theme, Descriptions, Card, Tag,
} from 'antd'
import {
  UnorderedListOutlined, ReloadOutlined,
  ClockCircleOutlined, StopOutlined, SearchOutlined,
  DownloadOutlined,
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
      if (selectedTaskId) loadLogs(selectedTaskId)
      setTick((t) => t + 1)
    }, 2000)
    return () => clearInterval(timer)
  }, [tasks, loadTasks, selectedTaskId, loadLogs])

  // 搜索 + 类型过滤
  const filteredTasks = tasks.filter((t) => {
    const matchSearch = !searchText || t.name.toLowerCase().includes(searchText.toLowerCase())
    const matchType = !typeFilter || t.type === typeFilter
    return matchSearch && matchType
  })

  const handleSelectTask = (task: TaskInfo) => {
    setSelectedTask(task.id)
    loadLogs(task.id)
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

  // 日志导出
  const handleExportLogs = () => {
    if (!selectedTaskId || !selectedTask) return
    const logs = taskLogs[selectedTaskId] ?? []
    const content = [
      `任务名称: ${selectedTask.name}`,
      `任务类型: ${selectedTask.type === 'migration' ? '迁移' : '同步'}`,
      `状态: ${selectedTask.status}`,
      `创建时间: ${selectedTask.createdAt ? formatDateTime(selectedTask.createdAt) : '-'}`,
      '---',
      ...logs.map((l) => `[${l.timestamp ?? ''}] [${l.level ?? 'INFO'}] ${l.message}`),
    ].join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedTask.name}-log.txt`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('日志已导出')
  }

  const selectedTask = tasks.find((t) => t.id === selectedTaskId)
  const selectedLogs = selectedTaskId ? (taskLogs[selectedTaskId] ?? []) : []

  const columns: ColumnsType<TaskInfo> = [
    { title: '任务名称', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 80,
      render: (t: string) => <Tag>{t === 'migration' ? '迁移' : '同步'}</Tag>,
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
        record.status === 'running' ? (
          <Button type="text" size="small" danger icon={<StopOutlined />} onClick={() => handleCancel(record)} />
        ) : null
      ),
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 头部 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          <UnorderedListOutlined style={{ marginRight: 8 }} />
          任务中心
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
          <Button icon={<ReloadOutlined />} onClick={loadTasks} />
        </Space>
      </div>

      <Layout style={{ flex: 1, minHeight: 0, background: 'transparent' }}>
        {/* 左侧任务列表 */}
        <div style={{ flex: 1, marginRight: 16 }}>
          {tasks.length === 0 && !loading ? (
            <EmptyState description="暂无任务，在「数据迁移」或「数据同步」中创建任务" />
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

        {/* 右侧详情 */}
        {selectedTask && (
          <Sider
            width={380}
            style={{
              background: token.colorBgContainer,
              borderRadius: token.borderRadius,
              padding: 16,
              overflow: 'auto',
            }}
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Text strong style={{ fontSize: 14 }}>{selectedTask.name}</Text>

              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="类型">{selectedTask.type === 'migration' ? '迁移' : '同步'}</Descriptions.Item>
                <Descriptions.Item label="状态"><TaskStatusTag status={selectedTask.status} /></Descriptions.Item>
                <Descriptions.Item label="进度"><Progress percent={selectedTask.progress} size="small" style={{ marginBottom: 0 }} /></Descriptions.Item>
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

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Text strong style={{ fontSize: 13 }}>执行日志</Text>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={handleExportLogs}
                    disabled={selectedLogs.length === 0}
                  >
                    导出
                  </Button>
                </div>
                <LogPanel logs={selectedLogs} height={240} />
              </div>
            </Space>
          </Sider>
        )}
      </Layout>
    </div>
  )
}
