import React from 'react'
import { Empty, Typography, Button } from 'antd'
import { PlusOutlined } from '@ant-design/icons'

const { Text } = Typography

interface EmptyStateProps {
  /** 空状态描述文案或自定义组件 */
  description: string | React.ReactNode
  /** 可选的操作按钮文案 */
  actionText?: string
  /** 操作按钮点击回调 */
  onAction?: () => void
  /** 自定义图标 */
  icon?: React.ReactNode
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  description,
  actionText,
  onAction,
  icon,
}) => (
  <div style={{
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '64px 24px',
  }}>
    <Empty
      image={icon ?? Empty.PRESENTED_IMAGE_SIMPLE}
      description={typeof description === 'string' ? <Text type="secondary">{description}</Text> : description}
    >
      {actionText && onAction && (
        <Button type="primary" icon={<PlusOutlined />} onClick={onAction}>
          {actionText}
        </Button>
      )}
    </Empty>
  </div>
)
