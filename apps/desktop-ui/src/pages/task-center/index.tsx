import React, { useEffect, useState, useCallback } from 'react'
import {
  Layout, Table, Typography, Space, Select, Button, Progress,
  theme,
} from 'antd'
import {
  UnorderedListOutlined, ReloadOutlined,
  ClockCircleOutlined, StopOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { TaskInfo, TaskLog } from '@/types'
import { useTaskStore } from '@/stores/taskStore'
import { taskApi } from '@/services/api'
import { TaskStatusTag } from '@/components/StatusTag'
import { LogPanel } from '@/components/LogPanel'
import { confirmDanger } from '@/components/ConfirmModal'
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
  const [, setTick] = useState(0) // 用于刷新实时耗时

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

  const selectedTask = tasks.find((t) => t.id === selectedTaskId)
  const selectedLogs = selectedTaskId ? (taskLogs[selectedTaskId] ?? []) : []

  const columns: ColumnsType<TaskInfo> = [
    { title: '任务名称', dataIndex: 'name', key: 'name', ellipsis: true },
    {
      title: '类型', dataIndex: 'type', key: 'type', width: 80,
      render: (t: string) => t === 'migration' ? '迁移' : '同步',
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
          <Select
            value={statusFilter} onChange={setStatusFilter}
            placeholder="状态筛选" allowClear
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
          <Table
            columns={columns}
            dataSource={tasks}
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
            locale={{ emptyText: '暂无任务' }}
          />
        </div>

        {/* 右侧详情 */}
        {selectedTask && (
          <Sider
            width={360}
            style={{
              background: token.colorBgContainer,
              borderRadius: token.borderRadius,
              padding: 16,
              overflow: 'auto',
            }}
          >
            <Text strong style={{ fontSize: 14 }}>{selectedTask.name}</Text>
            <div style={{ marginTop: 12 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <div><Text type="secondary">类型：</Text>{selectedTask.type === 'migration' ? '迁移' : '同步'}</div>
                <div><Text type="secondary">状态：</Text><TaskStatusTag status={selectedTask.status} /></div>
                <div><Text type="secondary">进度：</Text><Progress percent={selectedTask.progress} size="small" /></div>
                {selectedTask.startedAt && (
                  <div><Text type="secondary">开始时间：</Text>{formatDateTime(selectedTask.startedAt)}</div>
                )}
                {selectedTask.duration != null && (
                  <div><Text type="secondary">耗时：</Text>{formatDuration(selectedTask.duration)}</div>
                )}
                {selectedTask.status === 'running' && selectedTask.startedAt && selectedTask.duration == null && (
                  <div><Text type="secondary">已用时：</Text><ClockCircleOutlined style={{ marginRight: 4 }} />{formatDuration(getElapsedMs(selectedTask.startedAt))}</div>
                )}
                {selectedTask.errorMessage && (
                  <div><Text type="danger">错误：{selectedTask.errorMessage}</Text></div>
                )}
              </Space>
            </div>

            <div style={{ marginTop: 16 }}>
              <Text strong style={{ fontSize: 13 }}>执行日志</Text>
              <div style={{ marginTop: 8 }}>
                <LogPanel logs={selectedLogs} height={240} />
              </div>
            </div>
          </Sider>
        )}
      </Layout>
    </div>
  )
}
