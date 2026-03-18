import React from 'react'
import { Modal } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'

interface ConfirmModalProps {
  /** 是否显示弹窗 */
  open: boolean
  /** 确认标题 */
  title?: string
  /** 确认内容 */
  content: React.ReactNode
  /** 确认按钮文案 */
  okText?: string
  /** 取消按钮文案 */
  cancelText?: string
  /** 是否为危险操作（按钮变红） */
  danger?: boolean
  /** 确认中状态 */
  confirmLoading?: boolean
  /** 确认回调 */
  onConfirm: () => void
  /** 取消回调 */
  onCancel: () => void
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title = '确认操作',
  content,
  okText = '确认',
  cancelText = '取消',
  danger = false,
  confirmLoading = false,
  onConfirm,
  onCancel,
}) => (
  <Modal
    open={open}
    title={
      <span>
        <ExclamationCircleOutlined style={{ color: danger ? '#ff4d4f' : '#faad14', marginRight: 8 }} />
        {title}
      </span>
    }
    okText={okText}
    cancelText={cancelText}
    okButtonProps={{ danger }}
    confirmLoading={confirmLoading}
    onOk={onConfirm}
    onCancel={onCancel}
    centered
  >
    {content}
  </Modal>
)
