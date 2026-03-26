import React from 'react'
import { Card, Space, Typography, Tag, Dropdown, theme } from 'antd'
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

export const ConnectionCard: React.FC<ConnectionCardProps> = ({
  connection: c, selected, onClick, onOpen, onClose, onEdit, onDelete, onTest, onEnterWorkbench
}) => {
  const { token } = theme.useToken()

  // Generate an aesthetic background style based on theme
  const isDark = token.colorBgBase === '#0F172A'
  
  const cardStyle: React.CSSProperties = {
    cursor: 'pointer',
    position: 'relative',
    transition: 'all 0.2s ease',
    borderColor: selected ? token.colorPrimary : token.colorBorderSecondary,
    boxShadow: selected ? `0 0 0 1px ${token.colorPrimary}` : 'none',
    background: isDark 
      ? `linear-gradient(145deg, ${token.colorBgContainer}, rgba(255,255,255,0.02))`
      : token.colorBgContainer,
    overflow: 'hidden',
  }

  // Get vendor color indicator
  const vendorColor = c.dbType === 'mysql' ? '#E17E10' : 
                      c.dbType === 'postgresql' ? '#336791' : 
                      token.colorPrimary

  return (
    <Card
      size="small"
      style={cardStyle}
      bodyStyle={{ padding: 16 }}
      onClick={onClick}
      hoverable
      className="connection-card"
    >
      {/* Top Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <Space align="start">
          <div style={{
            width: 40, height: 40, borderRadius: 8,
            background: isDark ? 'rgba(255,255,255,0.05)' : token.colorBgLayout,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, color: vendorColor,
            border: `1px solid ${token.colorBorderSecondary}`
          }}>
            <DesktopOutlined />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <Text strong style={{ fontSize: 15, lineHeight: '1.2' }} ellipsis title={c.name}>
              {c.name}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {c.host}:{c.port}
            </Text>
          </div>
        </Space>
      </div>

      {/* Tags Section */}
      <Space size={4} style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <Tag color="processing" bordered={false}>{c.dbType.toUpperCase()}</Tag>
        <ConnectionStatusTag status={c.status} />
      </Space>

      {/* Footer Details */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
          {c.username} {c.database ? `• ${c.database}` : ''}
        </Text>
        
        {/* Actions triggering Dropdown on ellipsis */}
        <div onClick={(e) => e.stopPropagation()}>
          <Dropdown menu={{
            items: [
              ...(c.status === 'connected' ? [
                { key: 'workbench', label: '进入工作台', icon: <DesktopOutlined /> },
                { key: 'close', label: '关闭连接', icon: <DisconnectOutlined /> },
              ] : [
                { key: 'open', label: '打开连接', icon: <PlayCircleOutlined /> },
              ]),
              { type: 'divider' },
              { key: 'edit', label: '编辑连接', icon: <EditOutlined /> },
              { key: 'test', label: '测试连接', icon: <ThunderboltOutlined /> },
              { type: 'divider' },
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
              padding: '4px 8px', borderRadius: 4,
              background: token.colorBgLayout,
              cursor: 'pointer', display: 'flex', alignItems: 'center',
              color: token.colorTextSecondary
            }}>
              <EllipsisOutlined />
            </div>
          </Dropdown>
        </div>
      </div>
    </Card>
  )
}
