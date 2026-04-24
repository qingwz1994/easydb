import React from 'react'
import { Steps } from 'antd'

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
  return (
    <div style={{
      padding: '16px 24px',
      background: 'var(--glass-panel)',
      backdropFilter: 'var(--glass-blur-sm)',
      borderBottom: '1px solid var(--glass-border)',
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
