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
import React, { useState, useEffect } from 'react'
import {
  Typography, Select, Button, Alert, Card,
  theme, Row, Col, Table, Space, Tag
} from 'antd'
import {
  SwapRightOutlined, PlayCircleOutlined,
  WarningOutlined, DatabaseOutlined, ApiOutlined,
  TableOutlined, EyeOutlined, ThunderboltOutlined,
  FunctionOutlined, SettingOutlined
} from '@ant-design/icons'

const typeConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  table: { label: '表', color: 'blue', icon: <TableOutlined /> },
  view: { label: '视图', color: 'cyan', icon: <EyeOutlined /> },
  procedure: { label: '存储过程', color: 'purple', icon: <SettingOutlined /> },
  function: { label: '函数', color: 'orange', icon: <FunctionOutlined /> },
  trigger: { label: '触发器', color: 'magenta', icon: <ThunderboltOutlined /> },
}
import { useConnectionStore } from '@/stores/connectionStore'
import { syncApi, metadataApi, connectionApi } from '@/services/api'
import { toast, handleApiError } from '@/utils/notification'
import { useNavigate } from 'react-router-dom'
import type { ConnectionConfig } from '@/types'

const { Title, Text } = Typography

export const SyncPage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()
  
  const connections = useConnectionStore((s) => s.connections)
  const setConnections = useConnectionStore((s) => s.setConnections)
  const updateConnection = useConnectionStore((s) => s.updateConnection)

  // 状态变量
  const [sourceId, setSourceId] = useState<string>()
  const [targetId, setTargetId] = useState<string>()
  const [sourceDb, setSourceDb] = useState<string>()
  const [targetDb, setTargetDb] = useState<string>()
  
  const [submitting, setSubmitting] = useState(false)

  // 数据库拉取
  const [sourceDbs, setSourceDbs] = useState<string[]>([])
  const [targetDbs, setTargetDbs] = useState<string[]>([])
  const [loadingSourceDbs, setLoadingSourceDbs] = useState(false)
  const [loadingTargetDbs, setLoadingTargetDbs] = useState(false)

  // 表/对象拉取
  const [sourceObjects, setSourceObjects] = useState<Array<{name: string, type: string, comment?: string}>>([])
  const [loadingObjects, setLoadingObjects] = useState(false)
  const [selectedTables, setSelectedTables] = useState<React.Key[]>([])

  // 自动加载连接列表
  useEffect(() => {
    if (connections.length === 0) {
      connectionApi.list().then((list) => setConnections(list as ConnectionConfig[])).catch(() => {})
    }
  }, [connections.length, setConnections])

  // 处理连接选择事件并重连
  const handleConnectionSelect = async (connId: string, type: 'source' | 'target') => {
    const conn = connections.find((c) => c.id === connId)
    if (!conn) return

    if (conn.status !== 'connected') {
      try {
        await connectionApi.open(conn.id)
        updateConnection(conn.id, { status: 'connected' })
        toast.success(`已连接到「${conn.name}」`)
      } catch (e) {
        handleApiError(e, '连接失败')
        return
      }
    }
    
    if (type === 'source') {
      setSourceId(connId)
      setSourceDb(undefined)
      setSourceObjects([])
    } else {
      setTargetId(connId)
      setTargetDb(undefined)
    }
  }

  // 格式化连接下拉项
  const connOptions = connections.map((c) => ({
    value: c.id,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span><ApiOutlined style={{ marginRight: 8, color: c.status === 'connected' ? token.colorSuccess : undefined }} />{c.name} ({c.host}:{c.port})</span>
        {c.status !== 'connected' && (
          <span style={{ fontSize: 12, color: token.colorTextQuaternary }}>未连接</span>
        )}
      </div>
    )
  }))

  // 监听源连接以加载数据库
  useEffect(() => {
    if (sourceId) {
      setLoadingSourceDbs(true)
      metadataApi.databases(sourceId)
        .then((dbs) => setSourceDbs((dbs as Array<{name: string}>).map(d => d.name)))
        .catch((e) => handleApiError(e, '加载源数据库失败'))
        .finally(() => setLoadingSourceDbs(false))
    } else {
      setSourceDbs([])
      setSourceDb(undefined)
    }
  }, [sourceId])

  // 监听目标连接以加载数据库
  useEffect(() => {
    if (targetId) {
      setLoadingTargetDbs(true)
      metadataApi.databases(targetId)
        .then((dbs) => setTargetDbs((dbs as Array<{name: string}>).map(d => d.name)))
        .catch((e) => handleApiError(e, '加载目标数据库失败'))
        .finally(() => setLoadingTargetDbs(false))
    } else {
      setTargetDbs([])
      setTargetDb(undefined)
    }
  }, [targetId])

  // 监听源数据库选择以加载表/对象
  useEffect(() => {
    if (sourceId && sourceDb) {
      setLoadingObjects(true)
      metadataApi.objects(sourceId, sourceDb)
        .then((objs) => {
          const rawObjs = objs as Array<{name: string, type: string, comment?: string}>
          const list = rawObjs.map(o => ({
            name: o.name,
            type: o.type,
            comment: o.comment || ''
          }))
          setSourceObjects(list)
          // 默认全选
          setSelectedTables(list.map(o => o.name))
        })
        .catch(e => handleApiError(e, '加载数据对象失败'))
        .finally(() => setLoadingObjects(false))
    } else {
      setSourceObjects([])
      setSelectedTables([])
    }
  }, [sourceId, sourceDb])

  // 执行同步
  const handleStart = async () => {
    if (selectedTables.length === 0) {
      toast.error('请至少选择一个要同步的数据表/对象！')
      return
    }

    setSubmitting(true)
    try {
      await syncApi.start({
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
        sourceDatabase: sourceDb,
        targetDatabase: targetDb,
        tables: selectedTables as string[],
      })
      toast.success('同步任务已创建，可在任务中心查看进度')
      navigate('/task-center')
    } catch (e) {
      handleApiError(e, '创建同步任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  // 是否满足执行条件
  const canNext = !!sourceId && !!targetId && !!sourceDb && !!targetDb && selectedTables.length > 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-layout)' }}>
      {/* 核心双屏拓扑界面 */}
      <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
        
        <Title level={4} style={{ marginBottom: 24 }}>数据同步 (Data Sync)</Title>

        <Row gutter={48} align="stretch" style={{ position: 'relative' }}>
          {/* 左屏：数据源 */}
          <Col span={12}>
            <Card 
              hoverable
              bodyStyle={{ padding: 24, height: '100%' }}
              style={{ 
                height: '100%', 
                borderColor: sourceId ? token.colorPrimaryBorder : undefined,
                boxShadow: sourceId ? '0 4px 12px rgba(0,0,0,0.05)' : undefined 
              }}
            >
              <Title level={5} style={{ marginBottom: 24 }}><DatabaseOutlined style={{ color: token.colorPrimary, marginRight: 8 }}/>数据源 (Source)</Title>
              
              <Space direction="vertical" style={{ width: '100%' }} size="large">
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>选择源连接实例</Text>
                  <Select
                    value={sourceId} onChange={(v) => handleConnectionSelect(v, 'source')}
                    options={connOptions} placeholder="选择源连接"
                    style={{ width: '100%' }}
                    size="large"
                    listHeight={320}
                  />
                </div>

                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>选择源表空间 (Database)</Text>
                  <Select
                    value={sourceDb} onChange={setSourceDb}
                    placeholder="请先选择数据源连接" style={{ width: '100%' }}
                    showSearch allowClear
                    size="large"
                    disabled={!sourceId}
                    loading={loadingSourceDbs}
                    options={sourceDbs.map((db) => ({ value: db, label: db }))}
                  />
                </div>
              </Space>
            </Card>
          </Col>

          {/* 中央连接器 UI */}
          <div style={{
            position: 'absolute',
            left: '50%',
            top: 60,
            transform: 'translateX(-50%)',
            zIndex: 10,
            background: token.colorBgContainer,
            padding: '8px',
            borderRadius: '50%',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
          }}>
            <SwapRightOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
          </div>

          {/* 右屏：目标端 */}
          <Col span={12}>
            <Card 
              hoverable
              bodyStyle={{ padding: 24, height: '100%' }}
              style={{ 
                height: '100%', 
                borderColor: targetId ? token.colorSuccessBorder : undefined,
                boxShadow: targetId ? '0 4px 12px rgba(0,0,0,0.05)' : undefined 
              }}
            >
              <Title level={5} style={{ marginBottom: 24 }}><DatabaseOutlined style={{ color: token.colorSuccess, marginRight: 8 }}/>目标端 (Target)</Title>
              
              <Space direction="vertical" style={{ width: '100%' }} size="large">
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>选择目标连接实例</Text>
                  <Select
                    value={targetId} onChange={(v) => handleConnectionSelect(v, 'target')}
                    options={connOptions} placeholder="选择目标连接"
                    style={{ width: '100%' }}
                    size="large"
                    listHeight={320}
                  />
                </div>

                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>选择目标表空间 (Database)</Text>
                  <Select
                    value={targetDb} onChange={setTargetDb}
                    placeholder="请先选择目标连接" style={{ width: '100%' }}
                    showSearch allowClear
                    size="large"
                    disabled={!targetId}
                    loading={loadingTargetDbs}
                    options={targetDbs.map((db) => ({ value: db, label: db }))}
                  />
                </div>
              </Space>
            </Card>
          </Col>
        </Row>

        {/* 第2层：精细对象选取 (双库选中后才显示) */}
        {sourceDb && targetDb && (
          <Card 
            style={{ marginTop: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }} 
            bodyStyle={{ padding: 24 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
               <Title level={5} style={{ margin: 0 }}><TableOutlined style={{ marginRight: 8 }}/>选择要同步的表对象</Title>
               <Text type="secondary">已选择 {selectedTables.length} / {sourceObjects.length} 个对象</Text>
            </div>
            <Table
              size="small"
              loading={loadingObjects}
              dataSource={sourceObjects}
              rowKey="name"
              scroll={{ y: 300 }}
              pagination={false}
              rowSelection={{
                selectedRowKeys: selectedTables,
                onChange: (keys) => setSelectedTables(keys)
              }}
              columns={[
                { title: '对象名称', dataIndex: 'name', key: 'name', width: 250, render: (t: string) => <Text strong>{t}</Text> },
                { title: '类型', dataIndex: 'type', key: 'type', width: 140,
                  filters: Object.entries(typeConfig).map(([k, v]) => ({ text: v.label, value: k })),
                  onFilter: (value: unknown, record: {type: string}) => record.type === value,
                  render: (t: string) => {
                    const cfg = typeConfig[t] || { label: t, color: 'default', icon: null }
                    return <Tag icon={cfg.icon} color={cfg.color}>{cfg.label}</Tag>
                  }
                },
                { title: '注释', dataIndex: 'comment', key: 'comment', ellipsis: true },
              ]}
            />
          </Card>
        )}
      </div>

      {/* 底部吸附控制台 */}
      <div style={{
        padding: '16px 32px',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        boxShadow: '0 -2px 10px rgba(0,0,0,0.02)'
      }}>
        <Space size="large">
          <Alert
            message="操作确认提示"
            description="表数据将按主键覆盖更新 (Upsert)，视图/存储过程/函数/触发器将覆盖式同步定义 (DROP + CREATE)。"
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            style={{ border: 'none' }}
          />
        </Space>
        
        <Button
          type="primary"
          size="large"
          icon={<PlayCircleOutlined />}
          loading={submitting}
          disabled={!canNext}
          onClick={handleStart}
          style={{ paddingLeft: 32, paddingRight: 32 }}
        >
          开始执行数据同步 ({selectedTables.length})
        </Button>
      </div>
    </div>
  )
}
