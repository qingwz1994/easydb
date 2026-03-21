import React, { useEffect, useState, useCallback } from 'react'
import { Modal, Form, Input, Select, Typography } from 'antd'
import { metadataApi } from '@/services/api'
import { handleApiError, toast } from '@/utils/notification'

const { Text } = Typography

interface CharsetInfo {
  charset: string
  defaultCollation: string
  collations: string[]
}

interface CreateDatabaseModalProps {
  open: boolean
  connectionId: string
  connectionName: string
  onClose: () => void
  onSuccess: () => void
}

export const CreateDatabaseModal: React.FC<CreateDatabaseModalProps> = ({
  open, connectionId, connectionName, onClose, onSuccess,
}) => {
  const [form] = Form.useForm()
  const [charsets, setCharsets] = useState<CharsetInfo[]>([])
  const [collations, setCollations] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [sqlPreview, setSqlPreview] = useState('')

  // 加载字符集列表
  useEffect(() => {
    if (open && connectionId) {
      metadataApi.charsets(connectionId).then((data) => {
        const list = data as CharsetInfo[]
        setCharsets(list)
        // 默认选中 utf8mb4
        const defaultCs = list.find((c) => c.charset === 'utf8mb4') || list[0]
        if (defaultCs) {
          form.setFieldsValue({ charset: defaultCs.charset, collation: defaultCs.defaultCollation })
          setCollations(defaultCs.collations)
        }
      }).catch((e) => handleApiError(e, '加载字符集失败'))
    }
  }, [open, connectionId, form])

  // 更新 SQL 预览
  const updatePreview = useCallback(() => {
    const { name, charset, collation } = form.getFieldsValue()
    if (name) {
      setSqlPreview(`CREATE DATABASE \`${name}\` CHARACTER SET ${charset || 'utf8mb4'} COLLATE ${collation || 'utf8mb4_general_ci'};`)
    } else {
      setSqlPreview('')
    }
  }, [form])

  const handleCharsetChange = (cs: string) => {
    const info = charsets.find((c) => c.charset === cs)
    if (info) {
      setCollations(info.collations)
      form.setFieldsValue({ collation: info.defaultCollation })
    }
    updatePreview()
  }

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)
      await metadataApi.createDatabase(connectionId, values.name, values.charset, values.collation)
      toast.success(`数据库「${values.name}」创建成功`)
      form.resetFields()
      onSuccess()
      onClose()
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'errorFields' in e) return // 表单校验失败
      handleApiError(e, '创建数据库失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    form.resetFields()
    setSqlPreview('')
    onClose()
  }

  return (
    <Modal
      title={`新建数据库 — ${connectionName}`}
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={loading}
      okText="创建"
      cancelText="取消"
      destroyOnClose
      width={480}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }}
        onValuesChange={updatePreview}
        style={{ marginTop: 16 }}
      >
        <Form.Item
          name="name"
          label="数据库名称"
          rules={[
            { required: true, message: '请输入数据库名称' },
            { pattern: /^[a-zA-Z0-9_\-\u4e00-\u9fa5]+$/, message: '名称只能包含字母、数字、下划线、连字符和中文' },
          ]}
        >
          <Input placeholder="请输入数据库名称" autoFocus />
        </Form.Item>

        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="charset" label="字符集" style={{ flex: 1 }}>
            <Select
              showSearch
              optionFilterProp="label"
              onChange={handleCharsetChange}
              options={charsets.map((c) => ({ label: c.charset, value: c.charset }))}
            />
          </Form.Item>

          <Form.Item name="collation" label="排序规则" style={{ flex: 1 }}>
            <Select
              showSearch
              optionFilterProp="label"
              options={collations.map((c) => ({ label: c, value: c }))}
            />
          </Form.Item>
        </div>

        {sqlPreview && (
          <div style={{ marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>SQL 预览</Text>
            <pre style={{
              background: '#1e1e1e',
              color: '#d4d4d4',
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'Menlo, Monaco, monospace',
              margin: 0,
              overflow: 'auto',
            }}>
              {sqlPreview}
            </pre>
          </div>
        )}
      </Form>
    </Modal>
  )
}
