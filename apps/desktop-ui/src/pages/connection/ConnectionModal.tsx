import React, { useState } from 'react'
import {
  Modal, Form, Input, InputNumber, Select, Tabs, Switch, Typography,
} from 'antd'
import type { ConnectionConfig, ConnectionGroup } from '@/types'

const { Text } = Typography

interface ConnectionModalProps {
  open: boolean
  editingConnection: ConnectionConfig | null
  confirmLoading: boolean
  onSave: (values: Partial<ConnectionConfig>) => void
  onCancel: () => void
  onTest: (values: Partial<ConnectionConfig>) => void
  testResult: { success: boolean; message: string } | null
  testing: boolean
  existingGroups: ConnectionGroup[]
}



export const ConnectionModal: React.FC<ConnectionModalProps> = ({
  open, editingConnection, confirmLoading,
  onSave, onCancel, onTest,
  testResult, testing, existingGroups,
}) => {
  const [form] = Form.useForm()
  const [sshEnabled, setSshEnabled] = useState(false)
  const [sslEnabled, setSslEnabled] = useState(false)

  // 弹窗打开时重置表单
  React.useEffect(() => {
    if (open) {
      if (editingConnection) {
        form.setFieldsValue(editingConnection)
        setSshEnabled(!!editingConnection.ssh?.enabled)
        setSslEnabled(!!editingConnection.ssl?.enabled)
      } else {
        form.resetFields()
        form.setFieldsValue({
          dbType: 'mysql', host: '127.0.0.1', port: 3306, username: 'root',
        })
        setSshEnabled(false)
        setSslEnabled(false)
      }
    }
  }, [open, editingConnection, form])

  const handleSave = () => {
    form.validateFields().then((values) => {
      if (!sshEnabled) values.ssh = undefined
      if (!sslEnabled) values.ssl = undefined
      onSave(values)
    })
  }

  const handleTest = () => {
    form.validateFields().then((values) => {
      if (!sshEnabled) values.ssh = undefined
      if (!sslEnabled) values.ssl = undefined
      onTest(values)
    })
  }

  return (
    <Modal
      open={open}
      title={editingConnection ? '编辑连接' : '新建连接'}
      width={560}
      okText="保存"
      cancelText="取消"
      confirmLoading={confirmLoading}
      onOk={handleSave}
      onCancel={onCancel}
      centered
      footer={(_, { OkBtn, CancelBtn }) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <a onClick={handleTest} style={{ fontSize: 13, color: 'var(--edb-accent)' }}>
              {testing ? '测试中...' : '测试连接'}
            </a>
            {testResult && (
              <Text
                type={testResult.success ? 'success' : 'danger'}
                style={{ fontSize: 12 }}
              >
                {testResult.message}
              </Text>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <CancelBtn />
            <OkBtn />
          </div>
        </div>
      )}
    >
      <Form form={form} layout="vertical" requiredMark={false} size="middle">
        <Tabs
          size="small"
          items={[
            {
              key: 'basic',
              label: '基本',
              children: (
                <>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <Form.Item name="name" label="连接名称" style={{ flex: 1 }} rules={[{ required: true, message: '请输入连接名称' }]}>
                      <Input placeholder="我的 MySQL 连接" />
                    </Form.Item>
                    <Form.Item name="groupId" label="分组" style={{ flex: 1 }}>
                      <Select
                        options={existingGroups.map(g => ({ value: g.id, label: g.name }))}
                        placeholder="选择预置分组"
                        allowClear
                        showSearch
                        filterOption={(input, option) =>
                          (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                        }
                      />
                    </Form.Item>
                  </div>
                  <Form.Item name="dbType" label="数据库类型">
                    <Select
                      options={[
                        { value: 'mysql', label: 'MySQL' },
                        { value: 'postgresql', label: 'PostgreSQL', disabled: true },
                      ]}
                    />
                  </Form.Item>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <Form.Item name="host" label="主机" style={{ flex: 1 }} rules={[{ required: true }]}>
                      <Input placeholder="127.0.0.1" />
                    </Form.Item>
                    <Form.Item name="port" label="端口" style={{ width: 100 }} rules={[{ required: true }]}>
                      <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <Form.Item name="username" label="用户名" style={{ flex: 1 }} rules={[{ required: true }]}>
                      <Input placeholder="root" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" style={{ flex: 1 }}>
                      <Input.Password placeholder="密码" />
                    </Form.Item>
                  </div>
                  <Form.Item name="database" label="默认数据库">
                    <Input placeholder="可选，连接后自动切换" />
                  </Form.Item>
                </>
              ),
            },
            {
              key: 'ssh',
              label: 'SSH',
              children: (
                <>
                  <Form.Item label="启用 SSH 隧道">
                    <Switch checked={sshEnabled} onChange={setSshEnabled} />
                  </Form.Item>
                  {sshEnabled && (
                    <>
                      <div style={{ display: 'flex', gap: 12 }}>
                        <Form.Item name={['ssh', 'host']} label="SSH 主机" style={{ flex: 1 }} rules={[{ required: sshEnabled }]}>
                          <Input placeholder="ssh.example.com" />
                        </Form.Item>
                        <Form.Item name={['ssh', 'port']} label="SSH 端口" style={{ width: 100 }} initialValue={22}>
                          <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                        </Form.Item>
                      </div>
                      <Form.Item name={['ssh', 'username']} label="SSH 用户名" rules={[{ required: sshEnabled }]}>
                        <Input placeholder="ssh_user" />
                      </Form.Item>
                      <Form.Item name={['ssh', 'authType']} label="认证方式" initialValue="password">
                        <Select options={[
                          { value: 'password', label: '密码' },
                          { value: 'privateKey', label: '私钥' },
                        ]} />
                      </Form.Item>
                      <Form.Item name={['ssh', 'password']} label="SSH 密码">
                        <Input.Password placeholder="SSH 密码" />
                      </Form.Item>
                    </>
                  )}
                </>
              ),
            },
            {
              key: 'ssl',
              label: 'SSL',
              children: (
                <>
                  <Form.Item label="启用 SSL">
                    <Switch checked={sslEnabled} onChange={setSslEnabled} />
                  </Form.Item>
                  {sslEnabled && (
                    <>
                      <Form.Item name={['ssl', 'caPath']} label="CA 证书路径">
                        <Input placeholder="/path/to/ca.pem" />
                      </Form.Item>
                      <Form.Item name={['ssl', 'certPath']} label="客户端证书路径">
                        <Input placeholder="/path/to/client-cert.pem" />
                      </Form.Item>
                      <Form.Item name={['ssl', 'keyPath']} label="客户端密钥路径">
                        <Input placeholder="/path/to/client-key.pem" />
                      </Form.Item>
                    </>
                  )}
                </>
              ),
            },
          ]}
        />
      </Form>
    </Modal>
  )
}
