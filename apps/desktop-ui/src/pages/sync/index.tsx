import React, { useState, useEffect } from 'react'
import {
  Typography, Select, Button, Card, Alert,
  theme,
} from 'antd'
import {
  SyncOutlined, PlayCircleOutlined,
  WarningOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import { StepBar } from '@/components/StepBar'
import { useConnectionStore } from '@/stores/connectionStore'
import { syncApi, metadataApi, connectionApi } from '@/services/api'
import { toast, handleApiError } from '@/utils/notification'
import { useNavigate } from 'react-router-dom'
import type { ConnectionConfig } from '@/types'

const { Title, Text } = Typography

const STEPS = [
  { title: '选择连接' },
  { title: '选择对象' },
  { title: '确认同步' },
]

export const SyncPage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const connections = useConnectionStore((s) => s.connections)
  const setConnections = useConnectionStore((s) => s.setConnections)
  const updateConnection = useConnectionStore((s) => s.updateConnection)

  // 刷新页面时自动加载连接列表
  useEffect(() => {
    if (connections.length === 0) {
      connectionApi.list().then((list) => setConnections(list as ConnectionConfig[])).catch(() => {})
    }
  }, [connections.length, setConnections])

  const [current, setCurrent] = useState(0)
  const [sourceId, setSourceId] = useState<string>()
  const [targetId, setTargetId] = useState<string>()
  const [sourceDb, setSourceDb] = useState<string>()
  const [targetDb, setTargetDb] = useState<string>()
  const [submitting, setSubmitting] = useState(false)

  const [sourceDbs, setSourceDbs] = useState<string[]>([])
  const [targetDbs, setTargetDbs] = useState<string[]>([])
  const [loadingSourceDbs, setLoadingSourceDbs] = useState(false)
  const [loadingTargetDbs, setLoadingTargetDbs] = useState(false)

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
    } else {
      setTargetId(connId)
      setTargetDb(undefined)
    }
  }

  const connOptions = connections.map((c) => ({
    value: c.id,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{c.name} ({c.host}:{c.port})</span>
        {c.status !== 'connected' && (
          <span style={{ fontSize: 12, color: token.colorTextQuaternary }}>未连接</span>
        )}
      </div>
    )
  }))

  useEffect(() => {
    if (sourceId) {
      setLoadingSourceDbs(true)
      metadataApi.databases(sourceId)
        .then((dbs) => setSourceDbs((dbs as Array<{name: string}>).map(d => d.name)))
        .catch((e) => handleApiError(e, '加载源数据库列表失败'))
        .finally(() => setLoadingSourceDbs(false))
    } else {
      setSourceDbs([])
      setSourceDb(undefined)
    }
  }, [sourceId])

  useEffect(() => {
    if (targetId) {
      setLoadingTargetDbs(true)
      metadataApi.databases(targetId)
        .then((dbs) => setTargetDbs((dbs as Array<{name: string}>).map(d => d.name)))
        .catch((e) => handleApiError(e, '加载目标数据库列表失败'))
        .finally(() => setLoadingTargetDbs(false))
    } else {
      setTargetDbs([])
      setTargetDb(undefined)
    }
  }, [targetId])

  const handleStart = async () => {
    setSubmitting(true)
    try {
      const result = await syncApi.start({
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
        sourceDatabase: sourceDb,
        targetDatabase: targetDb,
        tables: [],
      }) as { taskId: string }
      toast.success(`同步任务已创建：${result.taskId}`)
      navigate('/task-center')
    } catch (e) {
      handleApiError(e, '创建同步任务失败')
    } finally {
      setSubmitting(false)
    }
  }

  const canNext = () => {
    if (current === 0) return !!sourceId && !!targetId
    if (current === 1) return !!sourceDb && !!targetDb
    return true
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <StepBar steps={STEPS} current={current} />

      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {current === 0 && (
          <Card size="small">
            <Title level={5}><SyncOutlined style={{ marginRight: 8 }} />选择源和目标连接</Title>
            <div style={{ display: 'flex', gap: 24, marginTop: 16 }}>
              <div style={{ flex: 1 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>源连接</Text>
                <Select value={sourceId} onChange={(v) => handleConnectionSelect(v, 'source')} options={connOptions} placeholder="选择源连接" style={{ width: '100%' }} listHeight={320} />
              </div>
              <div style={{ flex: 1 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>目标连接</Text>
                <Select value={targetId} onChange={(v) => handleConnectionSelect(v, 'target')} options={connOptions} placeholder="选择目标连接" style={{ width: '100%' }} listHeight={320} />
              </div>
            </div>
          </Card>
        )}

        {current === 1 && (
          <Card size="small">
            <Title level={5}>选择同步数据库</Title>
            <div style={{ display: 'flex', gap: 24, marginTop: 16 }}>
              <div style={{ flex: 1 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>源数据库</Text>
                <Select
                  value={sourceDb} onChange={setSourceDb}
                  placeholder="选择数据库" style={{ width: '100%' }}
                  showSearch allowClear
                  loading={loadingSourceDbs}
                  options={sourceDbs.map((db) => ({ value: db, label: db }))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>目标数据库</Text>
                <Select
                  value={targetDb} onChange={setTargetDb}
                  placeholder="选择数据库" style={{ width: '100%' }}
                  showSearch allowClear
                  loading={loadingTargetDbs}
                  options={targetDbs.map((db) => ({ value: db, label: db }))}
                />
              </div>
            </div>
          </Card>
        )}

        {current === 2 && (
          <Card size="small">
            <Title level={5}><CheckCircleOutlined style={{ marginRight: 8, color: token.colorSuccess }} />同步摘要</Title>
            <div style={{ marginTop: 16 }}>
              <Text>源：{connections.find((c) => c.id === sourceId)?.name} / {sourceDb}</Text>
              <br />
              <Text>目标：{connections.find((c) => c.id === targetId)?.name} / {targetDb}</Text>
            </div>
            <Alert
              style={{ marginTop: 16 }} type="warning"
              message="操作确认"
              description="同步操作将覆盖目标表中已存在的同名数据行，请确认设置正确。"
              showIcon icon={<WarningOutlined />}
            />
          </Card>
        )}
      </div>

      <div style={{
        padding: '12px 24px',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        display: 'flex', justifyContent: 'flex-end', gap: 8,
      }}>
        {current > 0 && <Button onClick={() => setCurrent(current - 1)}>上一步</Button>}
        {current < STEPS.length - 1 ? (
          <Button type="primary" disabled={!canNext()} onClick={() => setCurrent(current + 1)}>下一步</Button>
        ) : (
          <Button type="primary" icon={<PlayCircleOutlined />} loading={submitting} onClick={handleStart}>开始同步</Button>
        )}
      </div>
    </div>
  )
}
