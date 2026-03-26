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
import React, { useState, useCallback } from 'react'
import { Typography, Space, Switch, Button, Modal, Radio, Tabs, List, theme, Avatar } from 'antd'
import {
  SettingOutlined, InfoCircleOutlined, SyncOutlined, CheckCircleOutlined,
  CloudDownloadOutlined, BulbOutlined, DesktopOutlined, SafetyCertificateOutlined,
  CodeOutlined, RetweetOutlined, AppstoreOutlined
} from '@ant-design/icons'
import {
  checkForUpdate, getAutoCheckEnabled, setAutoCheckEnabled, APP_VERSION,
  type UpdateInfo,
} from '@/utils/updater'
import { useThemeStore, type ThemeMode } from '@/stores/themeStore'

const { Title, Text, Paragraph } = Typography

export const SettingsPage: React.FC = () => {
  const { token } = theme.useToken()
  const [autoCheck, setAutoCheck] = useState(getAutoCheckEnabled)
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)

  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)

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
          content: `当前版本 v${info.currentVersion} 已经是最新的，无需更新。`,
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

  const items = [
    {
      key: 'general',
      label: <span><SettingOutlined /> 通用设置</span>,
      children: (
        <div style={{ padding: '0 32px', maxWidth: 800 }}>
          <Title level={4} style={{ marginBottom: 24, fontWeight: 600 }}>通用设置</Title>
          <List
            itemLayout="horizontal"
            style={{ background: token.colorBgContainer, borderRadius: 8, border: `1px solid ${token.colorBorderSecondary}` }}
          >
            <List.Item actions={[
              <Radio.Group
                value={themeMode}
                onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
                optionType="button"
                buttonStyle="solid"
                size="middle"
              >
                <Radio.Button value="light">浅色模式</Radio.Button>
                <Radio.Button value="dark">深色模式</Radio.Button>
                <Radio.Button value="system">跟随系统</Radio.Button>
              </Radio.Group>
            ]}>
              <List.Item.Meta 
                avatar={<Avatar size="large" icon={<BulbOutlined />} style={{ backgroundColor: token.colorWarningBg, color: token.colorWarning }}/>}
                title={<Text strong>外观与主题</Text>}
                description="切换应用界面的全局色彩风格"
              />
            </List.Item>

            <List.Item actions={[<Switch checked={autoCheck} onChange={handleToggleAutoCheck} />]}>
              <List.Item.Meta 
                avatar={<Avatar size="large" icon={<RetweetOutlined />} style={{ backgroundColor: token.colorPrimaryBg, color: token.colorPrimary }}/>}
                title={<Text strong>启动时自动检查更新</Text>}
                description="在后台静默轮询 GitHub 的 Release 发布渠道"
              />
            </List.Item>

            <List.Item actions={[<Switch defaultChecked />]}>
              <List.Item.Meta 
                avatar={<Avatar size="large" icon={<SafetyCertificateOutlined />} style={{ backgroundColor: token.colorSuccessBg, color: token.colorSuccess }}/>}
                title={<Text strong>退出前询问确认</Text>}
                description="关闭应用主窗口前弹出二次确认拦截框防误触"
              />
            </List.Item>
          </List>
        </div>
      )
    },
    {
      key: 'editor',
      label: <span><CodeOutlined /> 代码编辑器</span>,
      children: (
        <div style={{ padding: '0 32px', maxWidth: 800 }}>
          <Title level={4} style={{ marginBottom: 24, fontWeight: 600 }}>SQL 编辑器首选项</Title>
          <List
            itemLayout="horizontal"
            style={{ background: token.colorBgContainer, borderRadius: 8, border: `1px solid ${token.colorBorderSecondary}` }}
          >
            <List.Item actions={[<Switch defaultChecked />]}>
              <List.Item.Meta 
                avatar={<Avatar size="large" icon={<CodeOutlined />} style={{ backgroundColor: token.colorInfoBg, color: token.colorInfo }}/>}
                title={<Text strong>智能代码补全 (Auto-complete)</Text>}
                description="基于 Monaco Editor 引擎和当前表结构的上下文提示"
              />
            </List.Item>

            <List.Item actions={[<Switch defaultChecked />]}>
              <List.Item.Meta 
                avatar={<Avatar size="large" icon={<AppstoreOutlined />} style={{ backgroundColor: token.colorErrorBg, color: token.colorError }}/>}
                title={<Text strong>语法动态高亮</Text>}
                description="激活复杂的 SQL 语法着色以及关键字识别"
              />
            </List.Item>
          </List>
        </div>
      )
    },
    {
      key: 'about',
      label: <span><InfoCircleOutlined /> 关于 EasyDB</span>,
      children: (
        <div style={{ padding: '0 32px', maxWidth: 800 }}>
          <Title level={4} style={{ marginBottom: 24, fontWeight: 600 }}>关于及系统版本</Title>
          <div style={{ 
            background: token.colorBgContainer, borderRadius: 8, border: `1px solid ${token.colorBorderSecondary}`,
            padding: 32, display: 'flex', flexDirection: 'column', alignItems: 'center'
          }}>
            <DesktopOutlined style={{ fontSize: 64, color: token.colorPrimary, marginBottom: 16 }} />
            <Title level={3} style={{ margin: 0 }}>EasyDB Pro</Title>
            <Text type="secondary" style={{ marginTop: 8, marginBottom: 24 }}>版本号：v{APP_VERSION}-beta ✨</Text>

            <Button
              type="primary"
              size="large"
              shape="round"
              icon={checking ? <SyncOutlined spin /> : <CloudDownloadOutlined />}
              onClick={handleCheckUpdate}
              loading={checking}
              style={{ width: 240, marginBottom: 16 }}
            >
              在线检查系统更新
            </Button>

            {updateInfo?.hasUpdate && (
              <div style={{
                marginTop: 16, padding: '16px 24px', width: '100%',
                background: token.colorSuccessBg, borderRadius: 8,
                border: `1px solid ${token.colorSuccessBorder}`,
              }}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Text strong>
                    <CheckCircleOutlined style={{ color: token.colorSuccess, marginRight: 8 }} />
                    发现新版本：v{updateInfo.latestVersion}
                  </Text>
                  {updateInfo.releaseNotes && (
                    <Text type="secondary" style={{ fontSize: 13, background: token.colorBgContainer, padding: 8, borderRadius: 4, display: 'block' }}>
                      {updateInfo.releaseNotes.substring(0, 300)}...
                    </Text>
                  )}
                  <Button
                    type="default"
                    size="middle"
                    onClick={() => window.open(updateInfo.downloadUrl, '_blank')}
                  >
                    🚀 立即前往发布页下载
                  </Button>
                </Space>
              </div>
            )}

            <Paragraph type="secondary" style={{ marginTop: 40, textAlign: 'center', fontSize: 13, opacity: 0.6 }}>
              核心技术构建：Tauri · React · TypeScript · Kotlin JVM<br/>
              EasyDB Core Contributors © 2024-2026. All rights reserved.
            </Paragraph>
          </div>
        </div>
      )
    }
  ]

  return (
    <div style={{ height: '100%', background: 'var(--color-bg-layout)' }}>
      <div style={{ padding: '16px 32px', margin: '16px 32px 0 32px', background: token.colorBgContainer, borderRadius: 8, boxShadow: '0 2px 10px rgba(0,0,0,0.02)' }}>
         <Tabs
            tabPosition="left"
            items={items}
            size="large"
            style={{ minHeight: 'calc(100vh - 120px)' }}
          />
      </div>
    </div>
  )
}
