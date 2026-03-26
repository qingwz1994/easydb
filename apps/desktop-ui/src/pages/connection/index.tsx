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
  Typography, Button, Table, Space, Input, Tooltip, Dropdown,
  theme, Tag, Layout, Card, Statistic, Row, Col, Select, Descriptions,
} from 'antd'
import {
  ApiOutlined, PlusOutlined, SearchOutlined,
  PlayCircleOutlined, EditOutlined, DeleteOutlined,
  EllipsisOutlined, ReloadOutlined, DisconnectOutlined,
  CheckCircleOutlined, ExclamationCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { ConnectionConfig, ConnectionStatus } from '@/types'
import { useConnectionStore } from '@/stores/connectionStore'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { connectionApi } from '@/services/api'
import { ConnectionStatusTag } from '@/components/StatusTag'
import { confirmDanger } from '@/components/confirmDanger'
import { toast, handleApiError } from '@/utils/notification'
import { ConnectionModal } from './ConnectionModal'
import { EmptyState } from '@/components/EmptyState'
import { useNavigate } from 'react-router-dom'

const { Title, Text } = Typography

export const ConnectionPage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()

  // Store
  const connections = useConnectionStore((s) => s.connections)
  const setConnections = useConnectionStore((s) => s.setConnections)
  const addConnection = useConnectionStore((s) => s.addConnection)
  const updateConnection = useConnectionStore((s) => s.updateConnection)
  const removeConnection = useConnectionStore((s) => s.removeConnection)
  const addOpenConnection = useWorkbenchStore((s) => s.addOpenConnection)

  // Local state
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingConn, setEditingConn] = useState<ConnectionConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ connected: boolean; message: string } | null>(null)
  const [selectedConn, setSelectedConn] = useState<ConnectionConfig | null>(null)
  const [batchTesting, setBatchTesting] = useState(false)

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

  // 统计数据
  const stats = {
    total: connections.length,
    connected: connections.filter((c) => c.status === 'connected').length,
    disconnected: connections.filter((c) => c.status === 'disconnected').length,
    error: connections.filter((c) => c.status === 'error').length,
  }

  // 搜索 + 状态过滤
  const filteredConnections = connections.filter((c) => {
    const matchSearch = c.name.toLowerCase().includes(searchText.toLowerCase()) ||
      c.host.toLowerCase().includes(searchText.toLowerCase())
    const matchStatus = statusFilter === 'all' || c.status === statusFilter
    return matchSearch && matchStatus
  })

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
        if (selectedConn?.id === conn.id) setSelectedConn(null)
        toast.success('连接已删除')
      },
    })
  }

  // 打开连接 → 跳转工作台
  const handleOpen = async (conn: ConnectionConfig) => {
    try {
      await connectionApi.open(conn.id)
      updateConnection(conn.id, { status: 'connected' })
      addOpenConnection(conn.id, conn.name)
      toast.success(`已连接到「${conn.name}」`)
      navigate('/workbench')
    } catch (e) {
      handleApiError(e, '打开连接失败')
    }
  }

  // 关闭连接
  const handleClose = async (conn: ConnectionConfig) => {
    try {
      await connectionApi.close(conn.id)
      updateConnection(conn.id, { status: 'disconnected' })
      toast.success(`已断开「${conn.name}」`)
    } catch (e) {
      handleApiError(e, '关闭连接失败')
    }
  }

  // 行内测试连接
  const handleTestInline = async (conn: ConnectionConfig) => {
    try {
      const result = await connectionApi.test(conn) as { connected: boolean; message: string }
      if (result.connected) {
        toast.success(`「${conn.name}」连接测试成功`)
      } else {
        toast.error(`「${conn.name}」连接测试失败：${result.message}`)
      }
    } catch (e) {
      toast.error(`测试失败：${e instanceof Error ? e.message : '未知错误'}`)
    }
  }

  // 批量测试未测试的连接
  const handleBatchTest = async () => {
    const untested = connections.filter((c) => c.status === 'disconnected')
    if (untested.length === 0) {
      toast.info('没有需要测试的连接')
      return
    }
    setBatchTesting(true)
    let successCount = 0
    let failCount = 0
    for (const conn of untested) {
      try {
        const result = await connectionApi.test(conn) as { connected: boolean; message: string }
        if (result.connected) successCount++
        else failCount++
      } catch {
        failCount++
      }
    }
    setBatchTesting(false)
    toast.success(`批量测试完成：${successCount} 成功，${failCount} 失败`)
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
      title: '默认库',
      dataIndex: 'database',
      key: 'database',
      width: 120,
      render: (db: string) => db || <Text type="secondary">-</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: ConnectionStatus) => <ConnectionStatusTag status={status} />,
    },
    {
      title: '最近使用',
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      width: 140,
      render: (v: string) => v ? <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_, record) => (
        <Space size={4}>
          {record.status === 'connected' ? (
            <Tooltip title="关闭连接">
              <Button type="text" size="small" icon={<DisconnectOutlined />} onClick={() => handleClose(record)} />
            </Tooltip>
          ) : (
            <Tooltip title="打开连接">
              <Button type="text" size="small" icon={<PlayCircleOutlined />} onClick={() => handleOpen(record)} />
            </Tooltip>
          )}
          <Tooltip title="编辑">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Dropdown menu={{
            items: [
              { key: 'test', label: '测试连接', icon: <ThunderboltOutlined /> },
              { type: 'divider' },
              { key: 'delete', label: '删除', danger: true, icon: <DeleteOutlined /> },
            ],
            onClick: ({ key }) => {
              if (key === 'delete') handleDelete(record)
              if (key === 'test') handleTestInline(record)
            },
          }}>
            <Button type="text" size="small" icon={<EllipsisOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ]

  return (
    <Layout style={{ height: '100%' }}>
      <Layout.Content style={{ overflow: 'auto', padding: 24 }}>
        {/* 头部 */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 16,
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
              style={{ width: 200 }}
              allowClear
            />
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 120 }}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'connected', label: '已连接' },
                { value: 'disconnected', label: '未连接' },
                { value: 'error', label: '异常' },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={loadConnections} />
            <Button onClick={handleBatchTest} loading={batchTesting}>
              批量测试
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              新建连接
            </Button>
          </Space>
        </div>

        {/* 概览卡片 */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card size="small">
              <Statistic title="连接总数" value={stats.total} prefix={<ApiOutlined />} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="已连接"
                value={stats.connected}
                valueStyle={{ color: token.colorSuccess }}
                prefix={<CheckCircleOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="未连接"
                value={stats.disconnected}
                valueStyle={{ color: token.colorTextSecondary }}
                prefix={<DisconnectOutlined />}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="异常"
                value={stats.error}
                valueStyle={{ color: token.colorError }}
                prefix={<ExclamationCircleOutlined />}
              />
            </Card>
          </Col>
        </Row>

        {/* 连接表格 */}
        {connections.length === 0 && !loading ? (
          <EmptyState
            description="暂无连接，点击「新建连接」开始"
            actionText="新建连接"
            onAction={handleCreate}
          />
        ) : (
          <Table
            columns={columns}
            dataSource={filteredConnections}
            rowKey="id"
            loading={loading}
            pagination={false}
            size="middle"
            onRow={(record) => ({
              onClick: () => setSelectedConn(record),
              style: {
                cursor: 'pointer',
                background: selectedConn?.id === record.id ? token.colorPrimaryBg : undefined,
              },
            })}
            locale={{
              emptyText: searchText || statusFilter !== 'all'
                ? '没有匹配的连接'
                : '暂无连接',
            }}
            style={{
              background: token.colorBgContainer,
              borderRadius: token.borderRadius,
            }}
          />
        )}

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
      </Layout.Content>

      {/* 右侧摘要区 */}
      {selectedConn && (
        <Layout.Sider
          width={240}
          style={{
            background: token.colorBgContainer,
            borderLeft: `1px solid ${token.colorBorderSecondary}`,
            overflow: 'auto',
            padding: 16,
          }}
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text strong style={{ fontSize: 14 }}>
              <ApiOutlined style={{ marginRight: 4 }} />
              {selectedConn.name}
            </Text>

            <Descriptions column={1} size="small">
              <Descriptions.Item label="主机">{selectedConn.host}:{selectedConn.port}</Descriptions.Item>
              <Descriptions.Item label="用户名">{selectedConn.username}</Descriptions.Item>
              <Descriptions.Item label="数据库类型">{selectedConn.dbType.toUpperCase()}</Descriptions.Item>
              <Descriptions.Item label="默认库">{selectedConn.database || '-'}</Descriptions.Item>
              <Descriptions.Item label="状态"><ConnectionStatusTag status={selectedConn.status} /></Descriptions.Item>
              <Descriptions.Item label="最近使用">{selectedConn.lastUsedAt || '-'}</Descriptions.Item>
            </Descriptions>

            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text strong style={{ fontSize: 12 }}>推荐操作</Text>
              {selectedConn.status === 'connected' ? (
                <>
                  <Button block size="small" type="primary" onClick={() => {
                    addOpenConnection(selectedConn.id, selectedConn.name)
                    navigate('/workbench')
                  }}>
                    进入工作台
                  </Button>
                  <Button block size="small" onClick={() => handleClose(selectedConn)}>
                    关闭连接
                  </Button>
                </>
              ) : (
                <Button block size="small" type="primary" onClick={() => handleOpen(selectedConn)}>
                  打开连接
                </Button>
              )}
              <Button block size="small" onClick={() => handleEdit(selectedConn)}>
                编辑连接
              </Button>
              <Button block size="small" onClick={() => handleTestInline(selectedConn)}>
                测试连接
              </Button>
            </Space>
          </Space>
        </Layout.Sider>
      )}
    </Layout>
  )
}
