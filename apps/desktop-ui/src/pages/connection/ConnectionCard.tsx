import React from 'react'
import { Card, Space, Typography, Tag, Dropdown } from 'antd'
import {
  EllipsisOutlined, PlayCircleOutlined, DisconnectOutlined,
  EditOutlined, DeleteOutlined, ThunderboltOutlined,
  DesktopOutlined
} from '@ant-design/icons'
import type { ConnectionConfig } from '@/types'
import { ConnectionStatusTag } from '@/components/StatusTag'

const { Text } = Typography

interface ConnectionCardProps {
  connection: ConnectionConfig
  selected: boolean
  onClick: () => void
  onOpen: () => void
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onTest: () => void
  onEnterWorkbench: () => void
}

// Vendor color mapping for DB type icon
const VENDOR_COLORS: Record<string, string> = {
  mysql: '#E17E10',
  postgresql: '#336791',
  dm: '#C23531',
}

export const ConnectionCard: React.FC<ConnectionCardProps> = ({
  connection: c, selected, onClick, onOpen, onClose, onEdit, onDelete, onTest, onEnterWorkbench
}) => {
  const vendorColor = VENDOR_COLORS[c.dbType] ?? 'var(--edb-accent)'

  return (
    <Card
      size="small"
      style={{
        cursor: 'pointer',
        position: 'relative',
        background: 'var(--edb-bg-elevated)',
        border: '1px solid var(--edb-border-subtle)',
        borderRadius: 'var(--edb-radius-md)',
        overflow: 'hidden',
      }}
      styles={{ body: { padding: 16 } }}
      onClick={onClick}
      hoverable
      className={`connection-card${selected ? ' connection-card--selected' : ''}`}
    >
      {/* Top Section: Icon + Name */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <Space align="start">
          <div style={{
            width: 38, height: 38, borderRadius: 'var(--edb-radius-md)',
            background: 'var(--edb-bg-surface)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, color: vendorColor,
            border: '1px solid var(--edb-border-subtle)',
            transition: 'background var(--edb-transition-fast)',
          }}>
            <DesktopOutlined />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Text strong style={{ fontSize: 14, lineHeight: '1.3', color: 'var(--edb-text-primary)' }} ellipsis title={c.name}>
              {c.name}
            </Text>
            <Text style={{ fontSize: 12, color: 'var(--edb-text-muted)' }}>
              {c.host}:{c.port}
            </Text>
          </div>
        </Space>
      </div>

      {/* Status + DB Type */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Tag
          bordered={false}
          style={{
            background: 'var(--edb-bg-surface)',
            color: 'var(--edb-text-secondary)',
            border: '1px solid var(--edb-border-subtle)',
            borderRadius: 'var(--edb-radius-sm)',
            fontSize: 11,
            fontWeight: 500,
            lineHeight: '18px',
            padding: '0 6px',
          }}
        >
          {c.dbType.toUpperCase()}
        </Tag>
        <ConnectionStatusTag status={c.status} />
      </div>

      {/* Footer: User + Actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ fontSize: 12, color: 'var(--edb-text-muted)' }} ellipsis>
          {c.username}{c.database ? ` · ${c.database}` : ''}
        </Text>

        {/* Actions dropdown */}
        <div onClick={(e) => e.stopPropagation()}>
          <Dropdown menu={{
            items: [
              ...(c.status === 'connected' ? [
                { key: 'workbench', label: '进入工作台', icon: <DesktopOutlined /> },
                { key: 'close', label: '关闭连接', icon: <DisconnectOutlined /> },
              ] : [
                { key: 'open', label: '打开连接', icon: <PlayCircleOutlined /> },
              ]),
              { type: 'divider' as const },
              { key: 'edit', label: '编辑连接', icon: <EditOutlined /> },
              { key: 'test', label: '测试连接', icon: <ThunderboltOutlined /> },
              { type: 'divider' as const },
              { key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true },
            ],
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation()
              switch(key) {
                case 'open': onOpen(); break;
                case 'close': onClose(); break;
                case 'workbench': onEnterWorkbench(); break;
                case 'edit': onEdit(); break;
                case 'test': onTest(); break;
                case 'delete': onDelete(); break;
              }
            }
          }} trigger={['click']}>
            <div style={{
              padding: '4px 6px',
              borderRadius: 'var(--edb-radius-sm)',
              background: 'var(--edb-bg-surface)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              color: 'var(--edb-text-muted)',
              transition: 'background var(--edb-transition-fast), color var(--edb-transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--edb-bg-hover)'
              e.currentTarget.style.color = 'var(--edb-text-secondary)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--edb-bg-surface)'
              e.currentTarget.style.color = 'var(--edb-text-muted)'
            }}
            >
              <EllipsisOutlined />
            </div>
          </Dropdown>
        </div>
      </div>
    </Card>
  )
}
