import React from 'react'
import { Layout, Menu, theme, Typography, Space, Breadcrumb } from 'antd'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  ApiOutlined,
  DatabaseOutlined,
  CodeOutlined,
  SwapOutlined,
  SyncOutlined,
  DiffOutlined,
  UnorderedListOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from '@ant-design/icons'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { ConnectionStatusTag } from '@/components/StatusTag'

const { Sider, Content, Header } = Layout
const { Text } = Typography

const menuItems = [
  { key: '/connection', icon: <ApiOutlined />, label: '连接管理' },
  { key: '/workbench', icon: <DatabaseOutlined />, label: '工作台' },
  { key: '/sql-editor', icon: <CodeOutlined />, label: 'SQL 编辑器' },
  { key: '/migration', icon: <SwapOutlined />, label: '数据迁移' },
  { key: '/sync', icon: <SyncOutlined />, label: '数据同步' },
  { key: '/structure-compare', icon: <DiffOutlined />, label: '结构对比' },
  { key: '/task-center', icon: <UnorderedListOutlined />, label: '任务中心' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
]

const pageTitle: Record<string, string> = {
  '/connection': '连接管理',
  '/workbench': '工作台',
  '/sql-editor': 'SQL 编辑器',
  '/migration': '数据迁移',
  '/sync': '数据同步',
  '/structure-compare': '结构对比',
  '/task-center': '任务中心',
  '/settings': '设置',
}

interface MainLayoutProps {
  children: React.ReactNode
}

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()

  const activeConnectionName = useWorkbenchStore((s) => s.activeConnectionName)
  const activeDatabase = useWorkbenchStore((s) => s.activeDatabase)
  const siderCollapsed = useWorkbenchStore((s) => s.siderCollapsed)
  const setSiderCollapsed = useWorkbenchStore((s) => s.setSiderCollapsed)

  const currentTitle = pageTitle[location.pathname] ?? ''

  // 面包屑项
  const breadcrumbItems = [
    { title: currentTitle },
    ...(activeConnectionName ? [{ title: activeConnectionName }] : []),
    ...(activeDatabase ? [{ title: activeDatabase }] : []),
  ]

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      {/* 左侧导航 */}
      <Sider
        width={200}
        collapsedWidth={56}
        collapsed={siderCollapsed}
        style={{
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {/* Logo */}
        <div
          style={{
            height: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: siderCollapsed ? 'center' : 'flex-start',
            paddingLeft: siderCollapsed ? 0 : 24,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            fontWeight: 700,
            fontSize: siderCollapsed ? 14 : 16,
            color: token.colorPrimary,
            letterSpacing: 1,
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
          onClick={() => navigate('/connection')}
        >
          {siderCollapsed ? 'E' : 'EasyDB'}
        </div>

        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0, paddingTop: 8 }}
          inlineCollapsed={siderCollapsed}
        />

        {/* 折叠按钮 */}
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            width: '100%',
            display: 'flex',
            justifyContent: 'center',
            cursor: 'pointer',
            color: token.colorTextSecondary,
          }}
          onClick={() => setSiderCollapsed(!siderCollapsed)}
        >
          {siderCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </div>
      </Sider>

      <Layout>
        {/* 顶部上下文栏 */}
        <Header
          style={{
            height: 48,
            lineHeight: '48px',
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Breadcrumb items={breadcrumbItems} />

          {/* 右侧：当前连接状态 */}
          <Space size={12}>
            {activeConnectionName ? (
              <>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  <DatabaseOutlined style={{ marginRight: 4 }} />
                  {activeConnectionName}
                  {activeDatabase && ` / ${activeDatabase}`}
                </Text>
                <ConnectionStatusTag status="connected" />
              </>
            ) : (
              <Text type="secondary" style={{ fontSize: 13 }}>
                未连接
              </Text>
            )}
          </Space>
        </Header>

        {/* 主内容区 */}
        <Content
          style={{
            height: '100%',
            overflow: 'auto',
            background: token.colorBgLayout,
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  )
}
