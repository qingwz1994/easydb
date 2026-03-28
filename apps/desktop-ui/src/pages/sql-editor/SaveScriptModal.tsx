import React, { useState, useEffect } from 'react'
import { Modal, Form, Input, theme } from 'antd'
import { StarFilled } from '@ant-design/icons'
import { scriptApi } from '@/services/api'
import { toast, handleApiError } from '@/utils/notification'
import type { SavedScript } from '@/types'

interface SaveScriptModalProps {
  open: boolean
  onCancel: () => void
  onSuccess: (saved: SavedScript) => void
  initialSql: string
  connectionId?: string
  database?: string
}

export const SaveScriptModal: React.FC<SaveScriptModalProps> = ({
  open,
  onCancel,
  onSuccess,
  initialSql,
  database,
}) => {
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      // 预填一个默认名字
      const lines = initialSql.split('\n').map(l => l.trim()).filter(l => l)
      let defaultName = '未命名查询'
      if (lines.length > 0) {
        // 如果第一行是注释，用注释做名字
        if (lines[0].startsWith('-- ')) {
          defaultName = lines[0].substring(3).substring(0, 30)
        } else if (lines[0].startsWith('/*')) {
          defaultName = lines[0].replace(/\/\*|\*\//g, '').trim().substring(0, 30)
        }
      }
      form.setFieldsValue({ name: defaultName })
    } else {
      form.resetFields()
    }
  }, [open, initialSql, form])

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      setSubmitting(true)
      const res = await scriptApi.save({
        name: values.name,
        content: initialSql,
        database: database,
      })
      toast.success('脚本已收藏')
      onSuccess(res as SavedScript)
    } catch (e: any) {
      if (e.errorFields) return // 表单验证失败
      handleApiError(e, '保存脚本失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={
        <span>
          <StarFilled style={{ color: token.colorWarning, marginRight: 8 }} />
          收藏当前 SQL 脚本
        </span>
      }
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      confirmLoading={submitting}
      okText="收藏"
      cancelText="取消"
      width={400}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 24 }}>
        <Form.Item
          name="name"
          label="脚本名称"
          rules={[{ required: true, message: '请给脚本起个名字，方便日后查找' }]}
        >
          <Input placeholder="例如：统计当月活跃用户" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  )
}
