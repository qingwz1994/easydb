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
import { Typography, Space, Switch, Button, Modal, Radio, Tabs, List, theme, Avatar, Progress, Spin, App, Select, Alert } from 'antd'
import {
  SettingOutlined, InfoCircleOutlined, SyncOutlined, CheckCircleOutlined,
  CloudDownloadOutlined, BulbOutlined, DesktopOutlined, SafetyCertificateOutlined,
  CodeOutlined, RetweetOutlined, AppstoreOutlined,
  DatabaseOutlined, FileZipOutlined, FileTextOutlined, SettingFilled,
  DeleteOutlined, ClearOutlined, ExclamationCircleOutlined
} from '@ant-design/icons'
import {
  checkForUpdate, getAutoCheckEnabled, setAutoCheckEnabled, APP_VERSION,
  type UpdateInfo,
} from '@/utils/updater'
import { useThemeStore, type ThemeMode } from '@/stores/themeStore'
import { storageApi } from '@/services/api'

const { Title, Text, Paragraph } = Typography

interface StorageCategoryInfo {
  size: number
  sizeText: string
  fileCount: number
}

interface StorageInfo {
  basePath: string
  exports: StorageCategoryInfo
  logs: StorageCategoryInfo
  config: StorageCategoryInfo
  totalSize: number
  totalSizeText: string
}

export const SettingsPage: React.FC = () => {
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()
  const [autoCheck, setAutoCheck] = useState(getAutoCheckEnabled)
  const [checking, setChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)

  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)

  // 存储管理状态
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [cleaning, setCleaning] = useState<string | null>(null)
  const [exportDays, setExportDays] = useState(3)
  const [logDays, setLogDays] = useState(3)

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

  // 加载存储信息
  const loadStorageInfo = useCallback(async () => {
    setStorageLoading(true)
    try {
      const info = await storageApi.info() as StorageInfo
      setStorageInfo(info)
    } catch {
      // 静默失败
    } finally {
      setStorageLoading(false)
    }
  }, [])

  // 执行清理
  const handleCleanup = useCallback(async (target: string, mode: string, days?: number) => {
    const targetLabels: Record<string, string> = { exports: '导出文件', logs: '任务日志', tasks: '任务记录' }
    const label = targetLabels[target] || target

    const confirmMsg = mode === 'all'
      ? `确定要清理所有${label}吗？此操作不可恢复。`
      : `确定要清理超过 ${days} 天的${label}吗？`

    modal.confirm({
      title: `清理${label}`,
      icon: <ExclamationCircleOutlined />,
      content: confirmMsg,
      okText: '确认清理',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setCleaning(target)
        try {
          const result = await storageApi.cleanup(target, mode, days) as {
            deletedCount: number
            freedSize: number
            freedSizeText: string
          }
          message.success(`已清理 ${result.deletedCount} 项，释放 ${result.freedSizeText}`)
          loadStorageInfo() // 刷新信息
        } catch {
          message.error('清理失败')
        } finally {
          setCleaning(null)
        }
      },
    })
  }, [modal, message, loadStorageInfo])

  const calcPercent = (part: number, total: number) => {
    if (total === 0) return 0
    return Math.round((part / total) * 100)
  }

  const items = [
    {
      key: 'general',
      label: <span><SettingOutlined /> 通用设置</span>,
      children: (
        <div style={{ padding: '0 32px', maxWidth: 800 }}>
          <Title level={4} style={{ marginBottom: 24, fontWeight: 600 }}>通用设置</Title>
          <List
            itemLayout="horizontal"
            style={{ background: 'var(--glass-panel)', backdropFilter: 'var(--glass-blur-sm)', borderRadius: 8, border: '1px solid var(--glass-border)' }}
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
            style={{ background: 'var(--glass-panel)', backdropFilter: 'var(--glass-blur-sm)', borderRadius: 8, border: '1px solid var(--glass-border)' }}
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
      key: 'storage',
      label: <span><DatabaseOutlined /> 存储管理</span>,
      children: (
        <div style={{ padding: '0 32px', maxWidth: 800 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <Title level={4} style={{ margin: 0, fontWeight: 600 }}>存储管理</Title>
            <Button
              icon={<SyncOutlined spin={storageLoading} />}
              onClick={loadStorageInfo}
              loading={storageLoading}
              size="small"
            >
              刷新
            </Button>
          </div>

          {storageLoading && !storageInfo ? (
            <div style={{ textAlign: 'center', padding: 60 }}>
              <Spin size="large" />
              <div style={{ marginTop: 16 }}><Text type="secondary">正在扫描存储空间...</Text></div>
            </div>
          ) : storageInfo ? (
            <Space direction="vertical" size={20} style={{ width: '100%' }}>
              {/* 概览卡片 */}
              <div style={{
                background: 'var(--glass-panel)', backdropFilter: 'var(--glass-blur-sm)', borderRadius: 12,
                border: '1px solid var(--glass-border)',
                boxShadow: 'var(--glass-inner-glow)',
                padding: '24px 28px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
                  <Text strong style={{ fontSize: 15 }}>存储空间概览</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    📁 {storageInfo.basePath}
                  </Text>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12 }}>
                  <DatabaseOutlined style={{ fontSize: 28, color: token.colorPrimary }} />
                  <div style={{ flex: 1 }}>
                    <Text strong style={{ fontSize: 22 }}>{storageInfo.totalSizeText}</Text>
                    <Text type="secondary" style={{ marginLeft: 8 }}>总占用</Text>
                  </div>
                </div>
                <Progress
                  percent={100}
                  success={{ percent: calcPercent(storageInfo.exports.size, storageInfo.totalSize) }}
                  strokeColor={token.colorWarning}
                  trailColor={'var(--glass-border)'}
                  showInfo={false}
                  size={['100%', 12]}
                  style={{ marginBottom: 8 }}
                />
                <div style={{ display: 'flex', gap: 24, fontSize: 12 }}>
                  <Text type="secondary">
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: token.colorPrimary, marginRight: 6 }}/>
                    导出文件 {storageInfo.exports.sizeText}
                  </Text>
                  <Text type="secondary">
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: token.colorWarning, marginRight: 6 }}/>
                    日志 {storageInfo.logs.sizeText}
                  </Text>
                  <Text type="secondary">
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: 'var(--glass-border)', marginRight: 6 }}/>
                    配置 {storageInfo.config.sizeText}
                  </Text>
                </div>
              </div>

              {/* 影响提示 */}
              <Alert
                type="warning"
                showIcon
                style={{ borderRadius: 8 }}
                message="清理须知"
                description={
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: '20px' }}>
                    <li><b>导出文件</b>：清理后无法再从任务中心下载对应的 ZIP 压缩包</li>
                    <li><b>任务日志</b>：清理后任务中心的「导出日志」将无法下载历史物理日志文件，但在线查看不受影响</li>
                    <li><b>任务记录</b>：清理后任务中心中对应的历史条目将被移除</li>
                    <li>正在运行中的任务日志不会被清理</li>
                  </ul>
                }
              />

              {/* 分类管理 */}
              <div style={{
                background: 'var(--glass-panel)', backdropFilter: 'var(--glass-blur-sm)', borderRadius: 12,
                border: '1px solid var(--glass-border)',
                overflow: 'hidden',
              }}>
                {/* 导出文件 */}
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--glass-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                    <Avatar size="large" icon={<FileZipOutlined />} style={{ backgroundColor: '#e6f4ff', color: '#1677ff', flexShrink: 0 }}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        <Text strong>导出文件</Text>
                        <Text type="secondary" style={{ fontSize: 13, marginLeft: 6 }}>.zip</Text>
                      </div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {storageInfo.exports.sizeText} / {storageInfo.exports.fileCount} 个文件 — 历史导出的数据库压缩包
                      </Text>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <Space.Compact size="small">
                      <Select
                        value={exportDays}
                        onChange={setExportDays}
                        style={{ width: 90 }}
                        size="small"
                        options={[
                          { value: 1, label: '1 天前' },
                          { value: 3, label: '3 天前' },
                          { value: 7, label: '7 天前' },
                          { value: 30, label: '30 天前' },
                        ]}
                      />
                      <Button
                        size="small"
                        onClick={() => handleCleanup('exports', 'older_than_days', exportDays)}
                        loading={cleaning === 'exports'}
                        icon={<ClearOutlined />}
                      >
                        清理
                      </Button>
                    </Space.Compact>
                    <Button
                      size="small"
                      danger
                      onClick={() => handleCleanup('exports', 'all')}
                      loading={cleaning === 'exports'}
                      icon={<DeleteOutlined />}
                    >
                      全部清理
                    </Button>
                  </div>
                </div>

                {/* 任务日志 */}
                <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--glass-border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                    <Avatar size="large" icon={<FileTextOutlined />} style={{ backgroundColor: '#fff7e6', color: '#fa8c16', flexShrink: 0 }}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        <Text strong>任务日志</Text>
                        <Text type="secondary" style={{ fontSize: 13, marginLeft: 6 }}>.log</Text>
                      </div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {storageInfo.logs.sizeText} / {storageInfo.logs.fileCount} 个文件 — 导入/导出/迁移的运行日志
                      </Text>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <Space.Compact size="small">
                      <Select
                        value={logDays}
                        onChange={setLogDays}
                        style={{ width: 90 }}
                        size="small"
                        options={[
                          { value: 1, label: '1 天前' },
                          { value: 3, label: '3 天前' },
                          { value: 7, label: '7 天前' },
                          { value: 30, label: '30 天前' },
                        ]}
                      />
                      <Button
                        size="small"
                        onClick={() => handleCleanup('logs', 'older_than_days', logDays)}
                        loading={cleaning === 'logs'}
                        icon={<ClearOutlined />}
                      >
                        清理
                      </Button>
                    </Space.Compact>
                    <Button
                      size="small"
                      danger
                      onClick={() => handleCleanup('logs', 'all')}
                      loading={cleaning === 'logs'}
                      icon={<DeleteOutlined />}
                    >
                      全部清理
                    </Button>
                  </div>
                </div>

                {/* 任务记录 */}
                <div style={{ padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                    <Avatar size="large" icon={<SettingFilled />} style={{ backgroundColor: '#f6ffed', color: '#52c41a', flexShrink: 0 }}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        <Text strong>任务记录</Text>
                        <Text type="secondary" style={{ fontSize: 13, marginLeft: 6 }}>tasks.json</Text>
                      </div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {storageInfo.config.sizeText} — 已完成/失败/取消的历史任务元数据
                      </Text>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <Button
                      size="small"
                      onClick={() => handleCleanup('tasks', 'all')}
                      loading={cleaning === 'tasks'}
                      icon={<ClearOutlined />}
                    >
                      清理已完成任务
                    </Button>
                  </div>
                </div>
              </div>
            </Space>
          ) : (
            <div style={{
              textAlign: 'center', padding: 60,
              background: 'var(--glass-panel)', backdropFilter: 'var(--glass-blur-sm)', borderRadius: 12,
              border: '1px solid var(--glass-border)',
            }}>
              <DatabaseOutlined style={{ fontSize: 48, color: token.colorTextQuaternary, marginBottom: 16 }} />
              <div><Text type="secondary">点击「刷新」扫描存储空间</Text></div>
              <Button type="primary" onClick={loadStorageInfo} style={{ marginTop: 16 }}>
                扫描存储空间
              </Button>
            </div>
          )}
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
            background: 'var(--glass-panel)', backdropFilter: 'var(--glass-blur-sm)', borderRadius: 8, border: '1px solid var(--glass-border)',
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
                    <Text type="secondary" style={{ fontSize: 13, background: 'var(--glass-panel)', padding: 8, borderRadius: 4, display: 'block' }}>
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

  // 切换到存储管理 Tab 时自动加载
  const handleTabChange = useCallback((key: string) => {
    if (key === 'storage' && !storageInfo) {
      loadStorageInfo()
    }
  }, [storageInfo, loadStorageInfo])

  return (
    <div style={{ height: '100%', background: 'var(--edb-bg-base)' }}>
      <div style={{ padding: '16px 32px', margin: '16px 32px 0 32px', background: 'var(--glass-panel)', backdropFilter: 'var(--glass-blur-sm)', borderRadius: 8, border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow)' }}>
         <Tabs
            tabPosition="left"
            items={items}
            size="large"
            onChange={handleTabChange}
            style={{ minHeight: 'calc(100vh - 120px)' }}
          />
      </div>
    </div>
  )
}
