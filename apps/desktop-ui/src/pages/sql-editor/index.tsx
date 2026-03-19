import React, { useState, useCallback, useRef, useEffect } from 'react'
import {
  Layout, Button, Space, Typography, Tabs, Table, Tag, Select,
  theme,
} from 'antd'
import {
  PlayCircleOutlined, ClearOutlined,
  DatabaseOutlined, ApiOutlined, CodeOutlined, PlusOutlined,
} from '@ant-design/icons'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { SqlResult, ConnectionConfig } from '@/types'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSqlEditorStore } from '@/stores/sqlEditorStore'
import { sqlApi, metadataApi, connectionApi } from '@/services/api'
import { EmptyState } from '@/components/EmptyState'
import { handleApiError, toast } from '@/utils/notification'
import { createSqlCompletionProvider, clearCompletionCache } from './sqlCompletionProvider'

const { Content, Header } = Layout
const { Text } = Typography

// 标签页数据结构

// 尝试从整段 SQL 中提取所有出现的主表名（按顺序）
const extractAllTableNames = (sql: string): string[] => {
  if (!sql) return []
  // 匹配 FROM / UPDATE / INTO 后面的连续字符，忽略前面的内容，并去掉反引号或引号
  const regex = /(?:from|update|into)\s+([`'"]?[a-zA-Z0-9_$]+[`'"]?)/gi
  const matches = [...sql.matchAll(regex)]
  return matches.map(m => m[1].replace(/[`'"]/g, ''))
}

// 标签页数据结构已移至 sqlEditorStore，此处不再定义

export const SqlEditorPage: React.FC = () => {
  const { token } = theme.useToken()
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null)

  const activeConnectionId = useWorkbenchStore((s) => s.activeConnectionId)
  const activeDatabase = useWorkbenchStore((s) => s.activeDatabase)
  const setActiveConnection = useWorkbenchStore((s) => s.setActiveConnection)
  const setActiveDatabase = useWorkbenchStore((s) => s.setActiveDatabase)
  const connections = useConnectionStore((s) => s.connections)
  const setConnections = useConnectionStore((s) => s.setConnections)
  const updateConnection = useConnectionStore((s) => s.updateConnection)

  // --- 从 store 读取标签页状态（路由切换不丢失） ---
  const tabs = useSqlEditorStore((s) => s.tabs)
  const activeTabKey = useSqlEditorStore((s) => s.activeTabKey)
  const storeAddTab = useSqlEditorStore((s) => s.addTab)
  const storeRemoveTab = useSqlEditorStore((s) => s.removeTab)
  const storeUpdateTab = useSqlEditorStore((s) => s.updateTab)
  const storeSetActiveTabKey = useSqlEditorStore((s) => s.setActiveTabKey)
  const consumePendingSql = useSqlEditorStore((s) => s.consumePendingSql)

  const [executing, setExecuting] = useState(false)
  const [databases, setDatabases] = useState<string[]>([])
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)

  const activeEditorTab = tabs.find((t) => t.key === activeTabKey) ?? tabs[0]

  // 工具栏上下文：有 tab 严格读 tab（不穿透），无 tab fallback 到 workbenchStore
  const hasTabs = tabs.length > 0
  const currentConnId = hasTabs ? activeEditorTab?.connectionId : (activeConnectionId ?? undefined)
  const currentDatabase = hasTabs ? activeEditorTab?.database : (activeDatabase ?? undefined)

  const updateActiveTab = useCallback((updates: Partial<typeof activeEditorTab>) => {
    storeUpdateTab(activeTabKey, updates)
  }, [activeTabKey, storeUpdateTab])

  // 自动加载连接列表
  useEffect(() => {
    if (connections.length === 0) {
      connectionApi.list().then((list) => {
        const allConns = list as ConnectionConfig[]
        setConnections(allConns)
        if (!activeConnectionId) {
          const connected = allConns.find((c) => c.status === 'connected')
          if (connected) {
            setActiveConnection(connected.id, connected.name)
          }
        }
      }).catch(() => {})
    }
  }, [activeConnectionId, connections.length, setActiveConnection, setConnections])

  // 标签页操作
  const updateTabSql = useCallback((key: string, sql: string) => {
    storeUpdateTab(key, { sql })
  }, [storeUpdateTab])

  // 消费从其他页面传入的 SQL：始终新建标签页（不覆盖现有 tab）
  useEffect(() => {
    const pending = consumePendingSql()
    if (pending) {
      const newKey = storeAddTab(pending.connectionId, pending.database)
      if (pending.sql) {
        storeUpdateTab(newKey, { sql: pending.sql })
        toast.success('SQL 已加载，请审核后手动执行')
      }
    }
  // 仅在组件挂载时消费一次
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 连接变化时加载数据库列表（从工具栏上下文读取）
  useEffect(() => {
    if (!currentConnId) { setDatabases([]); return }
    metadataApi.databases(currentConnId).then((dbs) => {
      setDatabases((dbs as Array<{name: string}>).map(d => d.name))
    }).catch(() => setDatabases([]))
  }, [currentConnId])

  const addTab = () => {
    storeAddTab(currentConnId, currentDatabase)
  }

  const removeTab = (targetKey: string) => {
    storeRemoveTab(targetKey)
  }

  const handleTabChange = (key: string) => {
    // 保存当前标签页的 SQL
    if (editorRef.current) {
      updateActiveTab({ sql: editorRef.current.getValue() })
    }
    storeSetActiveTabKey(key)
  }

  const handleConnectionChange = async (connId: string) => {
    const conn = connections.find((c) => c.id === connId)
    if (!conn) return

    if (conn.status !== 'connected') {
      try {
        await connectionApi.open(conn.id)
        updateConnection(conn.id, { status: 'connected' })
        toast.success(`已连接到「${conn.name}」`)
      } catch (e) {
        handleApiError(e, '连接失败')
        return
      }
    }
    if (activeEditorTab) {
      updateActiveTab({ connectionId: connId, database: undefined })
    } else {
      setActiveConnection(connId, conn.name)
    }
  }

  const handleDatabaseChange = (db: string) => {
    if (activeEditorTab) {
      updateActiveTab({ database: db })
    } else {
      setActiveDatabase(db)
    }
    clearCompletionCache()
    if (activeEditorTab?.connectionId && monacoRef.current) {
      completionDisposableRef.current?.dispose()
      completionDisposableRef.current = monacoRef.current.languages.registerCompletionItemProvider(
        'sql',
        createSqlCompletionProvider(activeEditorTab.connectionId, db, monacoRef.current)
      )
    }
  }

  const handleEditorMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance
    monacoRef.current = monaco
    editorInstance.addAction({
      id: 'execute-sql',
      label: '执行 SQL',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => handleExecute(),
    })

    if (activeEditorTab?.connectionId && activeEditorTab?.database) {
      completionDisposableRef.current?.dispose()
      completionDisposableRef.current = monaco.languages.registerCompletionItemProvider(
        'sql',
        createSqlCompletionProvider(activeEditorTab.connectionId, activeEditorTab.database, monaco)
      )
    }

    editorInstance.focus()
  }

  const activeDbRefForCache = activeEditorTab?.database
  useEffect(() => { clearCompletionCache() }, [activeDbRefForCache])
  useEffect(() => {
    return () => {
      completionDisposableRef.current?.dispose()
      clearCompletionCache()
    }
  }, [])

  const handleExecute = useCallback(async () => {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    let execSql = activeEditorTab?.sql?.trim() ?? ''

    if (editor && selection && !selection.isEmpty()) {
      execSql = editor.getModel()?.getValueInRange(selection)?.trim() ?? execSql
    }

    if (!execSql || !activeEditorTab?.connectionId || !activeEditorTab?.database) return
    setExecuting(true)
    try {
      const resultList = await sqlApi.execute(activeEditorTab.connectionId, activeEditorTab.database, execSql) as SqlResult[]
      const newResults = [...[...resultList].reverse(), ...activeEditorTab.results]

      const hasError = resultList.some((r) => r.type === 'error')
      if (hasError) {
        const errorMsg = resultList.find((r) => r.type === 'error')?.error ?? 'SQL 执行失败'
        toast.error(errorMsg)
        updateActiveTab({ results: newResults, currentBatch: resultList, resultTab: 'messages' })
      } else {
        const hasQuery = resultList.some((r) => r.type === 'query')
        if (hasQuery) {
          updateActiveTab({ results: newResults, currentBatch: resultList, resultTab: 'result-0' })
        } else {
          const totalAffected = resultList.reduce((sum, r) => sum + (r.affectedRows ?? 0), 0)
          toast.success(`执行成功，共影响 ${totalAffected} 行`)
          updateActiveTab({ results: newResults, currentBatch: resultList, resultTab: 'messages' }) // 全是 update 的情况跳转到消息
        }
      }
    } catch (e) {
      handleApiError(e, 'SQL 执行失败')
    } finally {
      setExecuting(false)
    }
  }, [activeEditorTab, updateActiveTab])

  const handleClear = () => {
    updateTabSql(activeTabKey, '')
    editorRef.current?.setValue('')
    editorRef.current?.focus()
  }

  // 渲染时进行同名表统计
  const currentBatch = activeEditorTab?.currentBatch ?? []
  const results = activeEditorTab?.results ?? []
  const totalDuration = currentBatch.reduce((sum, r) => sum + (r.duration || 0), 0)
  const queryResults = currentBatch.filter((r) => r.type === 'query')
  const tableNameCounts: Record<string, number> = {}
  
  const allParsedNames = extractAllTableNames(currentBatch[0]?.sql || '')
  let queryIndex = 0

  return (
    <Layout style={{ height: '100%' }}>
      {/* 工具栏 */}
      <Header style={{
        height: 44,
        lineHeight: '44px',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        padding: '0 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <Space size={12}>
          <Space size={4}>
            <ApiOutlined />
            <Select
              size="small"
              style={{ width: 160 }}
              placeholder="选择连接"
              value={currentConnId}
              onChange={handleConnectionChange}
              options={connections.map((c) => ({
                label: (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>{c.name}</span>
                    {c.status !== 'connected' && (
                      <span style={{ fontSize: 12, color: token.colorTextQuaternary }}>未连接</span>
                    )}
                  </div>
                ),
                value: c.id
              }))}
              listHeight={320}
            />
          </Space>
          <Space size={4}>
            <DatabaseOutlined />
            <Select
              size="small"
              style={{ width: 160 }}
              placeholder="选择数据库"
              value={currentDatabase}
              onChange={handleDatabaseChange}
              options={databases.map((db) => ({ label: db, value: db }))}
              disabled={!currentConnId}
              showSearch
            />
          </Space>
        </Space>
        <Space>
          <Button
            type="primary"
            size="small"
            icon={<PlayCircleOutlined />}
            loading={executing}
            onClick={handleExecute}
            disabled={!activeEditorTab?.sql?.trim() || !currentConnId || !currentDatabase}
          >
            执行
          </Button>
          <Button size="small" icon={<ClearOutlined />} onClick={handleClear}>
            清空
          </Button>
        </Space>
      </Header>

      <Layout style={{ flex: 1 }}>
        <Layout.Content style={{ display: 'flex', flexDirection: 'column' }}>
          {tabs.length === 0 ? (
            /* 无标签页时的空状态引导 */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
              <div style={{ fontSize: 48, color: token.colorTextQuaternary }}>
                <CodeOutlined />
              </div>
              <Text type="secondary" style={{ fontSize: 14 }}>点击下方按钮新建一个查询标签页</Text>
              <Button type="primary" icon={<PlusOutlined />} onClick={addTab}>新建查询</Button>
            </div>
          ) : (
          <>
          {/* 编辑器标签页 */}
          <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
            <Tabs
              type="editable-card"
              size="small"
              activeKey={activeTabKey}
              onChange={handleTabChange}
              onEdit={(targetKey, action) => {
                if (action === 'add') addTab()
                if (action === 'remove') removeTab(targetKey as string)
              }}
              style={{ margin: '0 8px' }}
              tabBarStyle={{ marginBottom: 0 }}
              items={tabs.map((tab) => ({
                key: tab.key,
                label: tab.title,
                closable: true,
              }))}
            />
          </div>

          {/* 编辑器区域 */}
          {!activeEditorTab.connectionId ? (
            <div style={{ flex: 1 }}>
              <EmptyState
                description="请先在顶部下拉框中选择一个数据库连接"
                actionText="前往连接管理"
                onAction={() => { window.location.hash = '/connection' }}
              />
            </div>
          ) : !activeEditorTab.database ? (
            <div style={{ flex: 1 }}>
              <EmptyState description="请在工具栏中选择一个数据库" />
            </div>
          ) : (
            <>
              <div style={{
                height: 240,
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}>
                <Editor
                  key={activeTabKey}
                  height="100%"
                  language="sql"
                  theme="vs-dark"
                  defaultValue={activeEditorTab.sql}
                  onChange={(value) => updateTabSql(activeTabKey, value ?? '')}
                  onMount={handleEditorMount}
                  options={{
                    fontSize: 13,
                    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                    lineNumbers: 'on',
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    automaticLayout: true,
                    tabSize: 2,
                    suggestOnTriggerCharacters: true,
                    quickSuggestions: true,
                    folding: true,
                    renderLineHighlight: 'line',
                    selectionHighlight: true,
                    occurrencesHighlight: 'singleFile',
                    bracketPairColorization: { enabled: true },
                    padding: { top: 8, bottom: 8 },
                    placeholder: '输入 SQL 语句... (⌘+Enter 执行，支持选中部分执行)',
                  } as editor.IStandaloneEditorConstructionOptions}
                />
              </div>

              {/* 结果区 */}
              <Content style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', background: token.colorBgContainer, flex: 1 }}>
                <Tabs
                  activeKey={activeEditorTab.resultTab}
                  onChange={(key) => updateActiveTab({ resultTab: key })}
                  size="small"
                  style={{ padding: '0 16px', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
                  tabBarExtraContent={
                    currentBatch.length > 0 && !currentBatch.some(r => r.type === 'error') ? (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        共 {currentBatch.length} 条语句 · 耗时 {totalDuration}ms
                      </Text>
                    ) : null
                  }
                  items={[
                    // 为每一个查询类型的结果生成一个 Tab
                    ...currentBatch.map((r, idx) => {
                      if (r.type !== 'query') return null
                      const currentQueryIndex = queryIndex++

                      const cols = r.columns?.map(c => ({
                        title: c, dataIndex: c, key: c, width: 150, ellipsis: true,
                        render: (v: unknown) => String(v ?? 'NULL'),
                      })) ?? []
                      
                      const parsedName = allParsedNames[idx]
                      let displayLabel = `结果 ${currentQueryIndex + 1}`
                      if (parsedName) {
                        const count = (tableNameCounts[parsedName] || 0) + 1
                        tableNameCounts[parsedName] = count
                        displayLabel = count === 1 ? parsedName : `${parsedName} (${count})`
                      }

                      return {
                        key: `result-${currentQueryIndex}`,
                        label: displayLabel,
                        children: (
                          <div style={{ height: 'calc(100vh - 410px)', overflow: 'hidden' }}>
                            <Table
                              columns={cols}
                              dataSource={r.rows?.map((row, i) => ({ ...row, _key: i }))}
                              rowKey="_key"
                              pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], size: 'small' }}
                              size="small"
                              scroll={{ x: 'max-content', y: 'calc(100vh - 530px)' }}
                            />
                          </div>
                        )
                      }
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    }).filter(Boolean) as any[],
                    // 如果没有任何查询结果，提供一个基础的占位面板
                    ...(queryResults.length === 0 ? [{
                      key: 'results',
                      label: '结果',
                      children: currentBatch.some(r => r.type === 'update') ? (
                        <div style={{ padding: 24, textAlign: 'center' }}>
                          <Tag color="success">执行成功</Tag>
                          <Text type="secondary">
                            影响 {currentBatch.reduce((sum, r) => sum + (r.affectedRows ?? 0), 0)} 行
                          </Text>
                        </div>
                      ) : (
                        <EmptyState description="执行 SQL 后在此查看结果" />
                      ),
                    }] : []),
                    {
                      key: 'messages',
                      label: `消息${results.length > 0 ? ` (${results.length})` : ''}`,
                      children: (
                        <div style={{ padding: 12, overflow: 'auto', height: 'calc(100vh - 400px)' }}>
                          {results.map((r, i) => (
                            <div key={i} style={{
                              padding: '4px 0',
                              fontSize: 12,
                              fontFamily: 'Menlo, Monaco, monospace',
                              color: r.type === 'error' ? '#ff4d4f' : token.colorTextSecondary,
                            }}>
                              <Text type="secondary" style={{ fontSize: 11, marginRight: 8 }}>
                                {r.executedAt?.slice(11, 19)}
                              </Text>
                              {r.type === 'error'
                                ? `❌ ${r.error}`
                                : r.type === 'query'
                                  ? `✅ 查询返回 ${r.rows?.length ?? 0} 行 (${r.duration}ms)`
                                  : `✅ 影响 ${r.affectedRows} 行 (${r.duration}ms)`
                              }
                            </div>
                          ))}
                          {results.length === 0 && (
                            <Text type="secondary">暂无执行消息</Text>
                          )}
                        </div>
                      ),
                    },
                  ]}
                />
              </Content>
            </>
          )}
          </>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
