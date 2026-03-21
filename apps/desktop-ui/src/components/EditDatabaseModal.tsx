import React, { useEffect, useState } from 'react'
import { Modal, Form, Select, Typography } from 'antd'
import { metadataApi } from '@/services/api'
import { handleApiError, toast } from '@/utils/notification'

const { Text } = Typography

interface CharsetInfo {
  charset: string
  defaultCollation: string
  collations: string[]
}

interface EditDatabaseModalProps {
  open: boolean
  connectionId: string
  databaseName: string
  onClose: () => void
  onSuccess: () => void
}

export const EditDatabaseModal: React.FC<EditDatabaseModalProps> = ({
  open, connectionId, databaseName, onClose, onSuccess,
}) => {
  const [form] = Form.useForm()
  const [charsets, setCharsets] = useState<CharsetInfo[]>([])
  const [collations, setCollations] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open && connectionId) {
      metadataApi.charsets(connectionId).then((data) => {
        const list = data as CharsetInfo[]
        setCharsets(list)
        const defaultCs = list.find((c) => c.charset === 'utf8mb4') || list[0]
        if (defaultCs) {
          form.setFieldsValue({ charset: defaultCs.charset, collation: defaultCs.defaultCollation })
          setCollations(defaultCs.collations)
        }
      }).catch((e) => handleApiError(e, '加载字符集失败'))
    }
  }, [open, connectionId, form])

  const handleCharsetChange = (cs: string) => {
    const info = charsets.find((c) => c.charset === cs)
    if (info) {
      setCollations(info.collations)
      form.setFieldsValue({ collation: info.defaultCollation })
    }
  }

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)
      await metadataApi.alterDatabase(connectionId, databaseName, values.charset, values.collation)
      toast.success(`数据库「${databaseName}」已修改`)
      onSuccess()
      onClose()
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'errorFields' in e) return
      handleApiError(e, '修改数据库失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={`编辑数据库 — ${databaseName}`}
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={loading}
      okText="保存"
      cancelText="取消"
      destroyOnClose
      width={420}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
          修改数据库的字符集和排序规则，仅影响新建对象的默认值，不会改变已有表的字符集。
        </Text>
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
      </Form>
    </Modal>
  )
}
