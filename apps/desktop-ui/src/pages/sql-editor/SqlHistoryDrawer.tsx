/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
import React, { useState, useEffect, useMemo } from 'react'
import {
  Drawer, Input, List, Button, Space, Tag, Spin, Empty, Modal, Typography, Tooltip, theme,
} from 'antd'
import {
  SearchOutlined, DeleteOutlined, CopyOutlined, EnterOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { sqlApi } from '@/services/api'
import { toast } from '@/utils/notification'

const { Text } = Typography
const { useToken } = theme

// 与后端 SqlHistoryEntry 对齐（executedAt 是字符串，type 是 query|update|error）
interface SqlHistoryEntry {
  id: string
  connectionId: string
  database: string
  sql: string
  type: string        // "query" | "update" | "error"
  duration: number
  rowCount?: number
  error?: string
  executedAt: string  // ISO 字符串
}

interface SqlHistoryDrawerProps {
  open: boolean
  connectionId: string
  /** 传入当前选中的数据库名，不传则展示该连接全部历史 */
  database?: string
  onClose: () => void
  /** 点击"填入编辑器"时的回调，传入 sql 文本 */
  onApply: (sql: string) => void
}

export const SqlHistoryDrawer: React.FC<SqlHistoryDrawerProps> = ({
  open,
  connectionId,
  database,
  onClose,
  onApply,
}) => {
  const { token } = useToken()
  const [allItems, setAllItems] = useState<SqlHistoryEntry[]>([])
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)

  // 打开 或 database 变化时重新拉取
  // database 由外部按「按库过滤」开关决定是否传入
  useEffect(() => {
    if (!open || !connectionId) return
    setKeyword('')
    setLoading(true)
    ;(sqlApi.historyList(connectionId, database) as Promise<SqlHistoryEntry[]>)
      .then(items => setAllItems(items ?? []))
      .catch(() => setAllItems([]))
      .finally(() => setLoading(false))
  }, [open, connectionId, database])

  // 前端实时过滤，无防抖问题（数据量 ≤ 100 条，useMemo 足够）
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return allItems
    return allItems.filter(item => item.sql.toLowerCase().includes(kw))
  }, [allItems, keyword])

  /** 清空当前连接的历史（按 connectionId 过滤，不影响其他连接） */
  const handleClear = () => {
    Modal.confirm({
      title: '确认清空此连接的 SQL 历史？',
      content: '将清除当前连接下的全部历史记录，此操作不可恢复。',
      okType: 'danger',
      okText: '确认清空',
      cancelText: '取消',
      onOk: async () => {
        setClearing(true)
        try {
          await (sqlApi as any).historyClearByConnection(connectionId)
          setAllItems([])
          toast.success('历史记录已清空')
        } catch {
          toast.error('清空失败，请重试')
        } finally {
          setClearing(false)
        }
      },
    })
  }

  /** 类型标签 */
  const typeTag = (type: string) => {
    if (type === 'error') return <Tag color="error">❌ 错误</Tag>
    if (type === 'update') return <Tag color="warning">✏️ 修改</Tag>
    return <Tag color="success">✅ 查询</Tag>
  }

  const handleCopy = async (sql: string) => {
    try {
      await navigator.clipboard.writeText(sql)
      toast.success('SQL 已复制')
    } catch {
      toast.error('复制失败')
    }
  }

  const handleApply = (sql: string) => {
    onApply(sql)
    onClose()
    toast.success('SQL 已填入编辑器')
  }

  // 抽屉标题：明确告知用户当前是「全连接」还是「仅当前库」
  const drawerTitle = database
    ? `SQL 历史 · ${database}`
    : 'SQL 历史记录（全部数据库）'

  return (
    <Drawer
      title={drawerTitle}
      width={500}
      open={open}
      onClose={onClose}
      styles={{
        // colorBgElevated 是 Ant Design 弹层面板的标准背景 token，自动适配明暗主题
        header: {
          background: token.colorBgElevated,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          padding: '12px 16px',
        },
        body: {
          background: token.colorBgElevated,
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflowY: 'auto',
        },
      }}
      extra={
        <Button
          danger
          size="small"
          icon={<DeleteOutlined />}
          loading={clearing}
          onClick={handleClear}
          disabled={allItems.length === 0}
        >
          清空此连接
        </Button>
      }
    >
      {/* 搜索框 */}
      <Input
        placeholder="搜索 SQL..."
        allowClear
        prefix={<SearchOutlined />}
        value={keyword}
        onChange={e => setKeyword(e.target.value)}
      />

      {/* 历史列表 */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <Spin spinning={loading}>
          {!loading && filtered.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={keyword ? '未找到匹配的记录' : '暂无 SQL 执行历史'}
              style={{ marginTop: 48 }}
            />
          ) : (
            <List
              dataSource={filtered}
              split
              renderItem={item => (
                <List.Item
                  key={item.id}
                  style={{ flexDirection: 'column', alignItems: 'stretch', padding: '10px 0' }}
                >
                  {/* 时间 + 数据库 */}
                  <div style={{ color: 'var(--text-quaternary, #bbb)', fontSize: 11, marginBottom: 4 }}>
                    {dayjs(item.executedAt).format('MM-DD HH:mm:ss')}
                    &nbsp;·&nbsp;
                    <Text type="secondary" style={{ fontSize: 11 }}>{item.database}</Text>
                  </div>

                  {/* SQL 内容（最多 3 行展示） */}
                  <pre style={{
                    maxHeight: 72,
                    overflow: 'hidden',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontSize: 12,
                    margin: '0 0 6px',
                    background: token.colorFillTertiary,
                    padding: '6px 10px',
                    borderRadius: token.borderRadius,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                    lineHeight: 1.5,
                    color: token.colorText,
                  }}>
                    {item.sql}
                  </pre>

                  {/* 状态 + 操作 */}
                  <Space size={6} wrap>
                    {typeTag(item.type)}
                    <Text type="secondary" style={{ fontSize: 11 }}>{item.duration}ms</Text>
                    {item.rowCount != null && (
                      <Text type="secondary" style={{ fontSize: 11 }}>{item.rowCount} 行</Text>
                    )}
                    <div style={{ flex: 1 }} />
                    <Tooltip title="复制 SQL">
                      <Button
                        size="small"
                        icon={<CopyOutlined />}
                        onClick={() => handleCopy(item.sql)}
                      >
                        复制
                      </Button>
                    </Tooltip>
                    <Tooltip title="填入当前编辑器">
                      <Button
                        type="primary"
                        size="small"
                        icon={<EnterOutlined />}
                        onClick={() => handleApply(item.sql)}
                      >
                        填入编辑器
                      </Button>
                    </Tooltip>
                  </Space>

                  {/* 错误信息 */}
                  {item.type === 'error' && item.error && (
                    <div style={{
                      marginTop: 4, color: '#ff4d4f', fontSize: 11,
                      fontFamily: 'Menlo, Monaco, monospace',
                      borderLeft: '2px solid #ff4d4f', paddingLeft: 8,
                    }}>
                      {item.error}
                    </div>
                  )}
                </List.Item>
              )}
            />
          )}
        </Spin>
      </div>
    </Drawer>
  )
}
