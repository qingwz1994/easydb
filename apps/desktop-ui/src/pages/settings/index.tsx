/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
import React, { useState, useEffect, useCallback } from 'react'
import { Typography, Card, Space, Switch, Button, Tag, Modal, Spin } from 'antd'
import {
  SettingOutlined, InfoCircleOutlined, SyncOutlined, CheckCircleOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons'
import {
  checkForUpdate, getAutoCheckEnabled, setAutoCheckEnabled, APP_VERSION,
  type UpdateInfo,
} from '@/utils/updater'

const { Title, Text, Paragraph } = Typography

export const SettingsPage: React.FC = () => {
  const [autoCheck, setAutoCheck] = useState(getAutoCheckEnabled)
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)

  const handleToggleAutoCheck = useCallback((checked: boolean) => {
    setAutoCheck(checked)
    setAutoCheckEnabled(checked)
  }, [])

  const handleCheckUpdate = useCallback(async () => {
    setChecking(true)
    try {
      const info = await checkForUpdate()
      setUpdateInfo(info)
      if (!info.hasUpdate) {
        Modal.info({
          title: '已是最新版本',
          content: `当前版本 v${info.currentVersion} 已经是最新的。`,
        })
      }
    } catch {
      Modal.error({
        title: '检查更新失败',
        content: '无法连接到更新服务器，请检查网络后重试。',
      })
    } finally {
      setChecking(false)
    }
  }, [])

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
            <Switch checked={autoCheck} onChange={handleToggleAutoCheck} />
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
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <InfoCircleOutlined style={{ marginRight: 4 }} />
              <Text>EasyDB</Text>
              <Tag color="blue" style={{ marginLeft: 8 }}>v{APP_VERSION}</Tag>
            </div>
            <Button
              size="small"
              icon={checking ? <SyncOutlined spin /> : <CloudDownloadOutlined />}
              onClick={handleCheckUpdate}
              loading={checking}
            >
              检查更新
            </Button>
          </div>

          {updateInfo?.hasUpdate && (
            <div style={{
              padding: '8px 12px',
              background: '#e6f4ff',
              borderRadius: 6,
              border: '1px solid #91caff',
            }}>
              <Space direction="vertical" size={4}>
                <Text strong>
                  <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 4 }} />
                  发现新版本 v{updateInfo.latestVersion}
                </Text>
                {updateInfo.releaseNotes && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {updateInfo.releaseNotes.slice(0, 200)}
                    {updateInfo.releaseNotes.length > 200 ? '...' : ''}
                  </Text>
                )}
                <Button
                  type="primary"
                  size="small"
                  onClick={() => window.open(updateInfo.downloadUrl, '_blank')}
                >
                  前往下载
                </Button>
              </Space>
            </div>
          )}

          <Paragraph type="secondary" style={{ margin: 0 }}>
            技术栈：Tauri + React + TypeScript + Kotlin/JVM
          </Paragraph>
        </Space>
      </Card>
    </div>
  )
}
