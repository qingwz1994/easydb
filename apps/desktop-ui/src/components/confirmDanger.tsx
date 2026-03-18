import React from 'react'
import { Modal } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'

export function confirmDanger(config: {
  title?: string
  content: React.ReactNode
  okText?: string
  onOk: () => void | Promise<void>
}) {
  Modal.confirm({
    title: config.title ?? '确认删除',
    icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
    content: config.content,
    okText: config.okText ?? '删除',
    cancelText: '取消',
    okButtonProps: { danger: true },
    centered: true,
    onOk: config.onOk,
  })
}
