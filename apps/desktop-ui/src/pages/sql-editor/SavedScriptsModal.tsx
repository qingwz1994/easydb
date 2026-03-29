import React, { useEffect, useState } from 'react'
import { Modal, Table, Button, Space, Typography, Popconfirm, Tag } from 'antd'
import { DeleteOutlined, FolderOpenOutlined, CodeOutlined } from '@ant-design/icons'
import type { SavedScript } from '@/types'
import { scriptApi } from '@/services/api'
import { handleApiError, toast } from '@/utils/notification'

const { Text } = Typography

export interface SavedScriptsModalProps {
  open: boolean
  onCancel: () => void
  onSelect: (script: SavedScript) => void
}

export const SavedScriptsModal: React.FC<SavedScriptsModalProps> = ({ open, onCancel, onSelect }) => {
  const [scripts, setScripts] = useState<SavedScript[]>([])
  const [loading, setLoading] = useState(false)

  const loadScripts = async () => {
    setLoading(true)
    try {
      const res = await scriptApi.list()
      setScripts(res as SavedScript[])
    } catch (e) {
      handleApiError(e, '获取收藏列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) {
      loadScripts()
    }
  }, [open])

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await scriptApi.delete(id)
      toast.success('已删除收藏')
      loadScripts()
    } catch (err) {
      handleApiError(err, '删除收藏失败')
    }
  }

  const columns = [
    {
      title: '脚本名称',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: SavedScript) => (
        <Space>
          <CodeOutlined style={{ color: '#22c55e' }} />
          <Text strong>{text}</Text>
          {record.database && <Tag color="blue" bordered={false}>{record.database}</Tag>}
        </Space>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (text: string) => <Text type="secondary" style={{ fontSize: 13 }}>{new Date(text).toLocaleString()}</Text>
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      align: 'right' as const,
      render: (_: unknown, record: SavedScript) => (
        <Space onClick={(e) => e.stopPropagation()}>
          <Popconfirm
            title="确定要删除此收藏吗？"
            onConfirm={(e) => handleDelete(record.id, e as React.MouseEvent)}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" danger icon={<DeleteOutlined />} size="small" />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Modal
      title={
        <Space>
          <FolderOpenOutlined style={{ color: '#22c55e' }} />
          打开收藏的 SQL
        </Space>
      }
      open={open}
      onCancel={onCancel}
      footer={null}
      width={700}
      styles={{ body: { padding: '8px 0' } }}
    >
      <Table
        dataSource={scripts}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
        onRow={(record) => ({
          onClick: () => {
            onSelect(record)
            onCancel()
          },
          style: { cursor: 'pointer' },
          onMouseEnter: (e) => (e.currentTarget.style.background = 'var(--ant-color-bg-text-hover)'),
          onMouseLeave: (e) => (e.currentTarget.style.background = 'transparent'),
        })}
      />
    </Modal>
  )
}
