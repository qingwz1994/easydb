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
  theme, Tag,
} from 'antd'
import {
  SwapOutlined, PlayCircleOutlined,
  WarningOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import { StepBar } from '@/components/StepBar'
import { useConnectionStore } from '@/stores/connectionStore'
import { migrationApi, metadataApi, connectionApi } from '@/services/api'
import { toast, handleApiError } from '@/utils/notification'
import { useNavigate } from 'react-router-dom'
import type { ConnectionConfig } from '@/types'

const { Title, Text } = Typography

const STEPS = [
  { title: '选择连接' },
  { title: '选择对象' },
  { title: '确认迁移' },
]

export const MigrationPage: React.FC = () => {
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
  const [mode, setMode] = useState<string>('structure_and_data')
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
      await migrationApi.start({
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
        sourceDatabase: sourceDb,
        targetDatabase: targetDb,
        tables: [],
        mode,
      })
      toast.success('迁移任务已创建，可在任务中心查看进度')
      navigate('/task-center')
    } catch (e) {
      handleApiError(e, '创建迁移任务失败')
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
        {/* 步骤 1: 选择连接 */}
        {current === 0 && (
          <Card size="small">
            <Title level={5}><SwapOutlined style={{ marginRight: 8 }} />选择源和目标连接</Title>
            <div style={{ display: 'flex', gap: 24, marginTop: 16 }}>
              <div style={{ flex: 1 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>源连接</Text>
                <Select
                  value={sourceId} onChange={(v) => handleConnectionSelect(v, 'source')}
                  options={connOptions} placeholder="选择源连接"
                  style={{ width: '100%' }}
                  listHeight={320}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>目标连接</Text>
                <Select
                  value={targetId} onChange={(v) => handleConnectionSelect(v, 'target')}
                  options={connOptions} placeholder="选择目标连接"
                  style={{ width: '100%' }}
                  listHeight={320}
                />
              </div>
            </div>
          </Card>
        )}

        {/* 步骤 2: 选择数据库和模式 */}
        {current === 1 && (
          <Card size="small">
            <Title level={5}>选择数据库和迁移模式</Title>
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
            <div style={{ marginTop: 16 }}>
              <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>迁移模式</Text>
              <Select value={mode} onChange={setMode} style={{ width: 240 }} options={[
                { value: 'structure_and_data', label: '结构 + 数据' },
                { value: 'structure_only', label: '仅结构' },
                { value: 'data_only', label: '仅数据' },
              ]} />
            </div>
          </Card>
        )}

        {/* 步骤 3: 确认 */}
        {current === 2 && (
          <Card size="small">
            <Title level={5}><CheckCircleOutlined style={{ marginRight: 8, color: token.colorSuccess }} />迁移摘要</Title>
            <div style={{ marginTop: 16 }}>
              <Text>源：{connections.find((c) => c.id === sourceId)?.name} / {sourceDb}</Text>
              <br />
              <Text>目标：{connections.find((c) => c.id === targetId)?.name} / {targetDb}</Text>
              <br />
              <Text>模式：<Tag>{mode === 'structure_and_data' ? '结构+数据' : mode === 'structure_only' ? '仅结构' : '仅数据'}</Tag></Text>
            </div>
            <Alert
              style={{ marginTop: 16 }}
              type="warning"
              message="操作确认"
              description="迁移操作可能覆盖目标数据库中的同名表，请确认目标数据库设置正确。"
              showIcon
              icon={<WarningOutlined />}
            />
          </Card>
        )}
      </div>

      {/* 底部导航 */}
      <div style={{
        padding: '12px 24px',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
      }}>
        {current > 0 && (
          <Button onClick={() => setCurrent(current - 1)}>上一步</Button>
        )}
        {current < STEPS.length - 1 ? (
          <Button type="primary" disabled={!canNext()} onClick={() => setCurrent(current + 1)}>
            下一步
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={submitting}
            onClick={handleStart}
          >
            开始迁移
          </Button>
        )}
      </div>
    </div>
  )
}
