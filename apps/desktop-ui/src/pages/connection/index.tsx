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
  Typography, Button, Space, Input, Dropdown, Menu, Layout, Card, Statistic, Row, Col, Select, Modal
} from 'antd'
import {
  ApiOutlined, PlusOutlined, SearchOutlined, FolderOutlined,
  ReloadOutlined, CheckCircleOutlined, ExclamationCircleOutlined,
  DisconnectOutlined, EllipsisOutlined
} from '@ant-design/icons'
import type { ConnectionConfig, ConnectionGroup } from '@/types'
import { useConnectionStore } from '@/stores/connectionStore'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { connectionApi, groupApi } from '@/services/api'
import { confirmDanger } from '@/components/confirmDanger'
import { toast, handleApiError } from '@/utils/notification'
import { ConnectionModal } from './ConnectionModal'
import { EmptyState } from '@/components/EmptyState'
import { useNavigate } from 'react-router-dom'
import { ConnectionCard } from './ConnectionCard'

const { Title, Text } = Typography

export const ConnectionPage: React.FC = () => {
  const navigate = useNavigate()

  // Store
  const connections = useConnectionStore((s) => s.connections)
  const setConnections = useConnectionStore((s) => s.setConnections)
  const addConnection = useConnectionStore((s) => s.addConnection)
  const updateConnection = useConnectionStore((s) => s.updateConnection)
  const removeConnection = useConnectionStore((s) => s.removeConnection)
  
  const groups = useConnectionStore((s) => s.groups)
  const setGroups = useConnectionStore((s) => s.setGroups)

  const addOpenConnection = useWorkbenchStore((s) => s.addOpenConnection)

  // Local state
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [selectedGroup, setSelectedGroup] = useState<string>('all')
  const [modalOpen, setModalOpen] = useState(false)
  const [editingConn, setEditingConn] = useState<ConnectionConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ connected: boolean; message: string } | null>(null)
  const [selectedConn, setSelectedConn] = useState<ConnectionConfig | null>(null)
  const [batchTesting, setBatchTesting] = useState(false)
  
  // Group Model State
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<ConnectionGroup | null>(null)
  const [groupNameInput, setGroupNameInput] = useState('')

  // 加载连接与分组列表
  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [connList, groupList] = await Promise.all([
        connectionApi.list(),
        groupApi.list()
      ])
      setConnections(connList as ConnectionConfig[])
      setGroups(groupList as ConnectionGroup[])
    } catch (e) {
      handleApiError(e, '加载列表失败')
    } finally {
      setLoading(false)
    }
  }, [setConnections, setGroups])

  useEffect(() => { loadAll() }, [loadAll])

  // 统计数据
  const stats = {
    total: connections.length,
    connected: connections.filter((c) => c.status === 'connected').length,
    disconnected: connections.filter((c) => c.status === 'disconnected').length,
    error: connections.filter((c) => c.status === 'error').length,
  }

  // 搜索 + 状态过滤 + 分组过滤
  const filteredConnections = connections.filter((c) => {
    const matchSearch = c.name.toLowerCase().includes(searchText.toLowerCase()) ||
      c.host.toLowerCase().includes(searchText.toLowerCase())
    const matchStatus = statusFilter === 'all' || c.status === statusFilter
    const matchGroup = selectedGroup === 'all' || (selectedGroup === 'ungrouped' ? !c.groupId : c.groupId === selectedGroup)
    
    return matchSearch && matchStatus && matchGroup
  })

  // 新建连接
  const handleCreate = () => {
    setEditingConn(null)
    setTestResult(null)
    setModalOpen(true)
  }

  // 编辑连接
  const handleEdit = (conn: ConnectionConfig) => {
    setEditingConn(conn)
    setTestResult(null)
    setModalOpen(true)
  }

  // 保存连接
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

  // 测试连接配置
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

  // 删除连接
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

  // ─── 分组操作 ───────────────────────────────────────────
  const handleGroupSave = async () => {
    if (!groupNameInput.trim()) return
    try {
      if (editingGroup) {
         await groupApi.update(editingGroup.id, { ...editingGroup, name: groupNameInput })
         toast.success('分组重命名成功')
      } else {
         await groupApi.create({ name: groupNameInput, sortOrder: groups.length })
         toast.success('分组创建成功')
      }
      loadAll()
      setGroupModalOpen(false)
    } catch(e) { handleApiError(e) }
  }

  const handleDeleteGroup = (g: ConnectionGroup) => {
    confirmDanger({
      title: '删除分组',
      content: `确定删除分组「${g.name}」吗？\n该操作仅删除分组本身，其包含的连接将被移至「未分组」。`,
      onOk: async () => {
        await groupApi.delete(g.id)
        if (selectedGroup === g.id) setSelectedGroup('all')
        
        // 当一个组被删除，后端仅删除了Group，此时前如果还挂载原id会导致显示异常
        // 我们可以在前端把包含该group的配置强制修改为 null 或者从后台重新全量拉取。
        loadAll()
        toast.success('分组删除成功')
      }
    })
  }

  // ─── END ───────────────────────────────────────────

  const handleOpen = async (conn: ConnectionConfig) => {
    try {
      await connectionApi.open(conn.id)
      updateConnection(conn.id, { status: 'connected' })
      toast.success(`已连接到「${conn.name}」`)
    } catch (e) {
      handleApiError(e, '打开连接失败')
    }
  }

  const handleClose = async (conn: ConnectionConfig) => {
    try {
      await connectionApi.close(conn.id)
      updateConnection(conn.id, { status: 'disconnected' })
      toast.success(`已断开「${conn.name}」`)
    } catch (e) {
      handleApiError(e, '关闭连接失败')
    }
  }

  const handleEnterWorkbench = (conn: ConnectionConfig) => {
    addOpenConnection(conn.id, conn.name)
    navigate('/workbench')
  }

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

  const handleBatchTest = async () => {
    const untested = connections.filter((c) => c.status === 'disconnected' || c.status === 'error')
    if (untested.length === 0) {
      toast.info('没有需要测试的连接')
      return
    }
    setBatchTesting(true)
    let successCount = 0
    let failCount = 0

    try {
      await Promise.allSettled(
        untested.map(async (conn) => {
          try {
            const result = await connectionApi.test(conn) as { connected: boolean; message: string }
            if (result.connected) {
              successCount++
              updateConnection(conn.id, { status: 'connected' })
            } else {
              failCount++
              updateConnection(conn.id, { status: 'error' })
            }
          } catch {
            failCount++
            updateConnection(conn.id, { status: 'error' })
          }
        })
      )
    } finally {
      setBatchTesting(false)
      toast.success(`批量测试完成：${successCount} 成功，${failCount} 失败`)
    }
  }

  return (
    <Layout style={{ height: '100%' }}>
      {/* 左侧分组导航 */}
      <Layout.Sider
        width={220}
        theme="light"
        style={{
          borderRight: '1px solid var(--color-border)',
          overflow: 'auto',
          background: 'var(--color-bg-container)'
        }}
      >
        <div style={{ padding: '24px 16px 8px 16px', fontWeight: 600, color: 'var(--color-text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>连接分组</span>
          <Button 
            type="text" 
            size="small" 
            icon={<PlusOutlined />} 
            onClick={() => { setEditingGroup(null); setGroupNameInput(''); setGroupModalOpen(true); }}
            style={{ color: 'var(--color-primary)' }}
          />
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedGroup]}
          style={{ borderRight: 'none', background: 'transparent' }}
          onClick={(e) => setSelectedGroup(e.key)}
          items={[
            { key: 'all', icon: <ApiOutlined />, label: '所有连接' },
            ...groups.map(g => ({
              key: g.id, 
              icon: <FolderOutlined />, 
              label: (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.name}</span>
                  <Dropdown menu={{
                    items: [
                      { key: 'edit', label: '重命名', onClick: (e) => { e.domEvent.stopPropagation(); setEditingGroup(g); setGroupNameInput(g.name); setGroupModalOpen(true); } },
                      { key: 'delete', danger: true, label: '删除', onClick: (e) => { e.domEvent.stopPropagation(); handleDeleteGroup(g); } }
                    ]
                  }} trigger={['hover', 'click']}>
                    <div onClick={e => e.stopPropagation()} style={{ padding: '0 4px', visibility: selectedGroup === g.id ? 'visible' : undefined }}>
                      <EllipsisOutlined style={{ color: 'var(--color-text-secondary)', fontSize: 16 }} />
                    </div>
                  </Dropdown>
                </div>
              )
            })),
            { key: 'ungrouped', icon: <FolderOutlined />, label: '未分组' }
          ]}
        />
      </Layout.Sider>

      {/* 右侧主内容区 */}
      <Layout.Content style={{ overflow: 'auto', padding: 24 }}>
        {/* 头部操作区 */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 24,
        }}>
          <Title level={4} style={{ margin: 0 }}>
            {selectedGroup === 'all' ? '所有连接' : selectedGroup === 'ungrouped' ? '未分组连接' : groups.find(g => g.id === selectedGroup)?.name || selectedGroup} 
            <Text type="secondary" style={{ fontSize: 16, marginLeft: 8 }}>({filteredConnections.length})</Text>
          </Title>
          <Space>
            <Input
              placeholder="搜索主机或名称..."
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
            <Button icon={<ReloadOutlined />} onClick={loadAll} />
            <Dropdown menu={{
              items: [
                { key: 'batch-test', label: '批量测试断开的连接', onClick: handleBatchTest, disabled: batchTesting }
              ]
            }}>
              <Button loading={batchTesting}>更多</Button>
            </Dropdown>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              新建连接
            </Button>
          </Space>
        </div>

        {/* 概览统计 */}
        {selectedGroup === 'all' && (
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={6}>
              <Card size="small" bordered={false} style={{ background: 'var(--color-bg-elevated)', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                <Statistic title="连接总数" value={stats.total} prefix={<ApiOutlined />} />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small" bordered={false} style={{ background: 'var(--color-bg-elevated)', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                <Statistic title="已连接" value={stats.connected} valueStyle={{ color: 'var(--color-success)' }} prefix={<CheckCircleOutlined />} />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small" bordered={false} style={{ background: 'var(--color-bg-elevated)', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                <Statistic title="未连接" value={stats.disconnected} valueStyle={{ color: 'var(--color-text-secondary)' }} prefix={<DisconnectOutlined />} />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small" bordered={false} style={{ background: 'var(--color-bg-elevated)', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                <Statistic title="异常" value={stats.error} valueStyle={{ color: 'var(--color-error)' }} prefix={<ExclamationCircleOutlined />} />
              </Card>
            </Col>
          </Row>
        )}

        {/* CSS Grid 连接卡片区 */}
        {filteredConnections.length === 0 && !loading ? (
          <EmptyState
            description={searchText || statusFilter !== 'all' ? '没有匹配的连接' : '暂无连接，点击「新建连接」开始'}
            actionText="新建连接"
            onAction={handleCreate}
          />
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 16
          }}>
            {filteredConnections.map((conn) => (
              <ConnectionCard
                key={conn.id}
                connection={conn}
                selected={selectedConn?.id === conn.id}
                onClick={() => setSelectedConn(conn)}
                onOpen={() => handleOpen(conn)}
                onClose={() => handleClose(conn)}
                onEnterWorkbench={() => handleEnterWorkbench(conn)}
                onEdit={() => handleEdit(conn)}
                onDelete={() => handleDelete(conn)}
                onTest={() => handleTestInline(conn)}
              />
            ))}
          </div>
        )}

        {/* 新建/编辑弹窗 */}
        <ConnectionModal
          open={modalOpen}
          editingConnection={editingConn}
          confirmLoading={saving}
          existingGroups={groups}
          onSave={handleSave}
          onCancel={() => setModalOpen(false)}
          onTest={handleTest}
          testResult={testResult}
          testing={testing}
        />
        
        {/* 新增/编辑 分组弹窗 */}
        <Modal
           title={editingGroup ? "重命名分组" : "新建分组"}
           open={groupModalOpen}
           onOk={handleGroupSave}
           onCancel={() => setGroupModalOpen(false)}
           okText="保存"
           cancelText="取消"
           destroyOnClose
           width={400}
        >
           <Input 
              value={groupNameInput} 
              onChange={e => setGroupNameInput(e.target.value)} 
              placeholder="请输入分组名称"
              onPressEnter={handleGroupSave}
              autoFocus
           />
        </Modal>
      </Layout.Content>
    </Layout>
  )
}
