import React, { useEffect, useState, useCallback } from 'react'
import {
  Typography, Button, Table, Space, Input, Tooltip, Dropdown,
  theme, Tag,
} from 'antd'
import {
  ApiOutlined, PlusOutlined, SearchOutlined,
  PlayCircleOutlined, EditOutlined, DeleteOutlined,
  EllipsisOutlined, ReloadOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { ConnectionConfig } from '@/types'
import { useConnectionStore } from '@/stores/connectionStore'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { connectionApi } from '@/services/api'
import { ConnectionStatusTag } from '@/components/StatusTag'
import { confirmDanger } from '@/components/ConfirmModal'
import { toast, handleApiError } from '@/utils/notification'
import { ConnectionModal } from './ConnectionModal'
import { useNavigate } from 'react-router-dom'

const { Title } = Typography

export const ConnectionPage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()

  // Store
  const connections = useConnectionStore((s) => s.connections)
  const setConnections = useConnectionStore((s) => s.setConnections)
  const addConnection = useConnectionStore((s) => s.addConnection)
  const updateConnection = useConnectionStore((s) => s.updateConnection)
  const removeConnection = useConnectionStore((s) => s.removeConnection)
  const setActiveConnection = useWorkbenchStore((s) => s.setActiveConnection)

  // Local state
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingConn, setEditingConn] = useState<ConnectionConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ connected: boolean; message: string } | null>(null)

  // 加载连接列表
  const loadConnections = useCallback(async () => {
    setLoading(true)
    try {
      const list = await connectionApi.list() as ConnectionConfig[]
      setConnections(list)
    } catch (e) {
      handleApiError(e, '加载连接列表失败')
    } finally {
      setLoading(false)
    }
  }, [setConnections])

  useEffect(() => { loadConnections() }, [loadConnections])

  // 搜索过滤
  const filteredConnections = connections.filter((c) =>
    c.name.toLowerCase().includes(searchText.toLowerCase()) ||
    c.host.toLowerCase().includes(searchText.toLowerCase())
  )

  // 新建
  const handleCreate = () => {
    setEditingConn(null)
    setTestResult(null)
    setModalOpen(true)
  }

  // 编辑
  const handleEdit = (conn: ConnectionConfig) => {
    setEditingConn(conn)
    setTestResult(null)
    setModalOpen(true)
  }

  // 保存
  const handleSave = async (values: Partial<ConnectionConfig>) => {
    setSaving(true)
    try {
      if (editingConn) {
        const updated = await connectionApi.update(editingConn.id, values) as ConnectionConfig
        updateConnection(editingConn.id, updated)
        toast.success('连接已更新')
      } else {
        const created = await connectionApi.create(values) as ConnectionConfig
        addConnection(created)
        toast.success('连接已创建')
      }
      setModalOpen(false)
    } catch (e) {
      handleApiError(e, '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // 测试连接
  const handleTest = async (values: Partial<ConnectionConfig>) => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await connectionApi.test(values) as { connected: boolean; message: string }
      setTestResult(result)
    } catch (e) {
      setTestResult({ connected: false, message: e instanceof Error ? e.message : '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  // 删除
  const handleDelete = (conn: ConnectionConfig) => {
    confirmDanger({
      title: '确认删除',
      content: <>确定要删除连接「{conn.name}」吗？此操作无法撤销。</>,
      onOk: async () => {
        await connectionApi.delete(conn.id)
        removeConnection(conn.id)
        toast.success('连接已删除')
      },
    })
  }

  // 打开连接 → 跳转工作台
  const handleOpen = async (conn: ConnectionConfig) => {
    try {
      await connectionApi.open(conn.id)
      updateConnection(conn.id, { status: 'connected' })
      setActiveConnection(conn.id, conn.name)
      toast.success(`已连接到「${conn.name}」`)
      navigate('/workbench')
    } catch (e) {
      handleApiError(e, '打开连接失败')
    }
  }

  // 表格列
  const columns: ColumnsType<ConnectionConfig> = [
    {
      title: '连接名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record) => (
        <Space>
          <ApiOutlined style={{ color: token.colorPrimary }} />
          <a onClick={() => handleOpen(record)}>{name}</a>
        </Space>
      ),
    },
    {
      title: '主机',
      key: 'host',
      render: (_, r) => `${r.host}:${r.port}`,
      width: 200,
    },
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      width: 120,
    },
    {
      title: '数据库类型',
      dataIndex: 'dbType',
      key: 'dbType',
      width: 100,
      render: (type: string) => <Tag>{type.toUpperCase()}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => <ConnectionStatusTag status={status} />,
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title="打开连接">
            <Button type="text" size="small" icon={<PlayCircleOutlined />} onClick={() => handleOpen(record)} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Dropdown menu={{
            items: [
              { key: 'delete', label: '删除', danger: true, icon: <DeleteOutlined /> },
            ],
            onClick: ({ key }) => { if (key === 'delete') handleDelete(record) },
          }}>
            <Button type="text" size="small" icon={<EllipsisOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, height: '100%' }}>
      {/* 头部 */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 20,
      }}>
        <Title level={4} style={{ margin: 0 }}>
          <ApiOutlined style={{ marginRight: 8 }} />
          连接管理
        </Title>
        <Space>
          <Input
            placeholder="搜索连接..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 220 }}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={loadConnections} />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
            新建连接
          </Button>
        </Space>
      </div>

      {/* 连接表格 */}
      <Table
        columns={columns}
        dataSource={filteredConnections}
        rowKey="id"
        loading={loading}
        pagination={false}
        size="middle"
        locale={{ emptyText: '暂无连接，点击「新建连接」开始' }}
        style={{
          background: token.colorBgContainer,
          borderRadius: token.borderRadius,
        }}
      />

      {/* 新建/编辑弹窗 */}
      <ConnectionModal
        open={modalOpen}
        editingConnection={editingConn}
        confirmLoading={saving}
        onSave={handleSave}
        onCancel={() => setModalOpen(false)}
        onTest={handleTest}
        testResult={testResult}
        testing={testing}
      />
    </div>
  )
}
