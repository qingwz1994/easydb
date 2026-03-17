import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ConfigProvider, theme } from 'antd'
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

const App: React.FC = () => {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 6,
        },
      }}
    >
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
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </MainLayout>
      </BrowserRouter>
    </ConfigProvider>
  )
}

export default App
