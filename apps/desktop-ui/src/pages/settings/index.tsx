import React from 'react'
import { Typography, Card, Space, Switch } from 'antd'
import { SettingOutlined, InfoCircleOutlined } from '@ant-design/icons'

const { Title, Text, Paragraph } = Typography

export const SettingsPage: React.FC = () => {

  return (
    <div style={{ padding: 24, maxWidth: 640 }}>
      <Title level={4} style={{ marginBottom: 24 }}>
        <SettingOutlined style={{ marginRight: 8 }} />
        设置
      </Title>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Title level={5}>通用</Title>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text>启动时自动检查更新</Text>
            <Switch defaultChecked />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text>退出时确认</Text>
            <Switch defaultChecked />
          </div>
        </Space>
      </Card>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Title level={5}>SQL 编辑器</Title>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text>自动补全</Text>
            <Switch defaultChecked />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text>语法高亮</Text>
            <Switch defaultChecked />
          </div>
        </Space>
      </Card>

      <Card size="small">
        <Title level={5}>关于</Title>
        <Paragraph type="secondary">
          <InfoCircleOutlined style={{ marginRight: 4 }} />
          EasyDB v1.0.0 — 跨平台数据库管理工具
        </Paragraph>
        <Paragraph type="secondary">
          技术栈：Tauri + React + TypeScript + Kotlin/JVM
        </Paragraph>
      </Card>
    </div>
  )
}
