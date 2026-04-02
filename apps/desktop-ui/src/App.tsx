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
import React, { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme, Modal, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { MainLayout } from '@/layouts/MainLayout'
import { ConnectionPage } from '@/pages/connection'
import { WorkbenchPage } from '@/pages/workbench'
import { SqlEditorPage } from '@/pages/sql-editor'
import { MigrationPage } from '@/pages/migration'
import { SyncPage } from '@/pages/sync'
import { TaskCenterPage } from '@/pages/task-center'
import { SettingsPage } from '@/pages/settings'
import { StructureComparePage } from '@/pages/structure-compare'
import { DataTrackerPage } from '@/pages/data-tracker'
import { checkForUpdate, getAutoCheckEnabled } from '@/utils/updater'
import { useThemeStore } from '@/stores/themeStore'

const fontFamily = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
const fontFamilyCode = "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace"

const App: React.FC = () => {
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme)
  const isDark = effectiveTheme === 'dark'

  // 启动时自动检查更新
  useEffect(() => {
    if (!getAutoCheckEnabled()) return
    // 延迟 3 秒检查，避免阻塞启动
    const timer = setTimeout(async () => {
      try {
        const info = await checkForUpdate()
        if (info.hasUpdate) {
          Modal.confirm({
            title: `发现新版本 v${info.latestVersion}`,
            content: (
              <div>
                <p>当前版本：v{info.currentVersion}</p>
                {info.releaseNotes && (
                  <p style={{ fontSize: 12, color: '#666', maxHeight: 120, overflow: 'auto' }}>
                    {info.releaseNotes.slice(0, 300)}
                  </p>
                )}
              </div>
            ),
            okText: '前往下载',
            cancelText: '稍后再说',
            onOk: () => {
              window.open(info.downloadUrl, '_blank')
            },
          })
        }
      } catch {
        // 静默失败，不打扰用户
      }
    }, 3000)
    return () => clearTimeout(timer)
  }, [])

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: isDark ? '#22C55E' : '#22C55E',
          colorBgBase: isDark ? '#0F172A' : '#FFFFFF',
          colorBgContainer: isDark ? '#1E293B' : '#FFFFFF',
          colorBgElevated: isDark ? '#334155' : '#FFFFFF',
          colorBorder: isDark ? '#475569' : '#E2E8F0',
          colorBorderSecondary: isDark ? '#334155' : '#F1F5F9',
          borderRadius: 6,
          fontSize: 13,
          fontFamily,
          fontFamilyCode,
        },
      }}>
      <AntApp>
        <BrowserRouter>
          <MainLayout>
            <Routes>
              <Route path="/" element={<Navigate to="/connection" replace />} />
              <Route path="/connection" element={<ConnectionPage />} />
              <Route path="/workbench" element={<WorkbenchPage />} />
              <Route path="/sql-editor" element={<SqlEditorPage />} />
              <Route path="/migration" element={<MigrationPage />} />
              <Route path="/sync" element={<SyncPage />} />
              <Route path="/task-center" element={<TaskCenterPage />} />
              <Route path="/structure-compare" element={<StructureComparePage />} />
              <Route path="/data-tracker" element={<DataTrackerPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </MainLayout>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  )
}

export default App
