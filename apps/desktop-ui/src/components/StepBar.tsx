import React from 'react'
import { Steps, theme } from 'antd'

interface StepItem {
  /** 步骤标题 */
  title: string
  /** 步骤描述（可选） */
  description?: string
}

interface StepBarProps {
  /** 步骤列表 */
  steps: StepItem[]
  /** 当前步骤索引（0-based） */
  current: number
  /** 步骤变化回调（可选，用于可点击步骤条） */
  onChange?: (step: number) => void
}

export const StepBar: React.FC<StepBarProps> = ({
  steps,
  current,
  onChange,
}) => {
  const { token } = theme.useToken()

  return (
    <div style={{
      padding: '16px 24px',
      background: token.colorBgContainer,
      borderBottom: `1px solid ${token.colorBorderSecondary}`,
    }}>
      <Steps
        current={current}
        onChange={onChange}
        items={steps.map((step) => ({
          title: step.title,
          description: step.description,
        }))}
        size="small"
      />
    </div>
  )
}
