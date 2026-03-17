import React, { useState, useCallback, useRef, useEffect } from 'react'
import {
  Layout, Button, Space, Typography, Tabs, Table, Tag, Select,
  theme,
} from 'antd'
import {
  PlayCircleOutlined, ClearOutlined,
  DatabaseOutlined, ApiOutlined,
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
  const consumePendingSql = useSqlEditorStore((s) => s.consumePendingSql)

  const [sql, setSql] = useState('')
  const [executing, setExecuting] = useState(false)
  const [results, setResults] = useState<SqlResult[]>([])
  const [activeTab, setActiveTab] = useState<'results' | 'messages'>('results')
  const [databases, setDatabases] = useState<string[]>([])
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)

  // 自动加载连接列表
  useEffect(() => {
    if (connections.length === 0) {
      connectionApi.list().then((list) => {
        setConnections((list as ConnectionConfig[]).filter((c) => c.status === 'connected'))
      }).catch(() => {})
    }
  }, [])

  // 消费从其他页面传入的 SQL
  useEffect(() => {
    const pending = consumePendingSql()
    if (pending) {
      setSql(pending.sql)
      if (editorRef.current) {
        editorRef.current.setValue(pending.sql)
      }
      if (pending.connectionId) {
        const conn = connections.find((c) => c.id === pending.connectionId)
        setActiveConnection(pending.connectionId, conn?.name ?? null)
      }
      if (pending.database) {
        setActiveDatabase(pending.database)
      }
      toast.success('SQL 已加载，请审核后手动执行')
    }
  }, [])

  // 连接变化时加载数据库列表
  useEffect(() => {
    if (!activeConnectionId) { setDatabases([]); return }
    metadataApi.databases(activeConnectionId).then((dbs) => {
      setDatabases((dbs as Array<{name: string}>).map(d => d.name))
    }).catch(() => setDatabases([]))
  }, [activeConnectionId])

  // 切换连接
  const handleConnectionChange = (connId: string) => {
    const conn = connections.find((c) => c.id === connId)
    setActiveConnection(connId, conn?.name ?? null)
  }

  // 切换数据库
  const handleDatabaseChange = (db: string) => {
    setActiveDatabase(db)
    clearCompletionCache()
    // 重新注册补全
    if (activeConnectionId && monacoRef.current) {
      completionDisposableRef.current?.dispose()
      completionDisposableRef.current = monacoRef.current.languages.registerCompletionItemProvider(
        'sql',
        createSqlCompletionProvider(activeConnectionId, db, monacoRef.current)
      )
    }
  }



  const handleEditorMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance
    monacoRef.current = monaco
    // ⌘+Enter / Ctrl+Enter 执行 SQL
    editorInstance.addAction({
      id: 'execute-sql',
      label: '执行 SQL',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => handleExecute(),
    })

    // 注册 SQL 自动补全
    if (activeConnectionId && activeDatabase) {
      completionDisposableRef.current?.dispose()
      completionDisposableRef.current = monaco.languages.registerCompletionItemProvider(
        'sql',
        createSqlCompletionProvider(activeConnectionId, activeDatabase, monaco)
      )
    }

    editorInstance.focus()
  }

  // 切换数据库时刷新补全缓存
  useEffect(() => {
    clearCompletionCache()
  }, [activeDatabase])

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      completionDisposableRef.current?.dispose()
      clearCompletionCache()
    }
  }, [])

  const handleExecute = useCallback(async () => {
    // 获取选中文本或全部文本
    const editor = editorRef.current
    const selection = editor?.getSelection()
    let execSql = sql.trim()

    if (editor && selection && !selection.isEmpty()) {
      execSql = editor.getModel()?.getValueInRange(selection)?.trim() ?? execSql
    }

    if (!execSql || !activeConnectionId || !activeDatabase) return
    setExecuting(true)
    try {
      const resultList = await sqlApi.execute(activeConnectionId, activeDatabase, execSql) as SqlResult[]
      setResults((prev) => [...resultList.reverse(), ...prev])
      const hasError = resultList.some((r) => r.type === 'error')
      if (hasError) {
        const errorMsg = resultList.find((r) => r.type === 'error')?.error ?? 'SQL 执行失败'
        toast.error(errorMsg)
        setActiveTab('messages')
      } else {
        const hasQuery = resultList.some((r) => r.type === 'query')
        if (hasQuery) {
          setActiveTab('results')
        } else {
          // 多条 update 语句汇总
          const totalAffected = resultList.reduce((sum, r) => sum + (r.affectedRows ?? 0), 0)
          toast.success(`执行成功，共影响 ${totalAffected} 行`)
          setActiveTab('results')
        }
      }
    } catch (e) {
      handleApiError(e, 'SQL 执行失败')
    } finally {
      setExecuting(false)
    }
  }, [sql, activeConnectionId, activeDatabase])

  const handleClear = () => {
    setSql('')
    editorRef.current?.focus()
  }

  const latestResult = results[0] ?? null

  // 结果表格列
  const resultColumns = latestResult?.columns?.map((col) => ({
    title: col,
    dataIndex: col,
    key: col,
    width: 150,
    ellipsis: true,
    render: (v: unknown) => String(v ?? 'NULL'),
  })) ?? []

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
              value={activeConnectionId ?? undefined}
              onChange={handleConnectionChange}
              options={connections.filter((c) => c.status === 'connected').map((c) => ({ label: c.name, value: c.id }))}
            />
          </Space>
          <Space size={4}>
            <DatabaseOutlined />
            <Select
              size="small"
              style={{ width: 160 }}
              placeholder="选择数据库"
              value={activeDatabase ?? undefined}
              onChange={handleDatabaseChange}
              options={databases.map((db) => ({ label: db, value: db }))}
              disabled={!activeConnectionId}
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
            disabled={!sql.trim()}
          >
            执行
          </Button>
          <Button size="small" icon={<ClearOutlined />} onClick={handleClear}>
            清空
          </Button>
        </Space>
      </Header>

      {/* Monaco SQL 编辑器 */}
      <div style={{
        height: 240,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}>
        <Editor
          height="100%"
          language="sql"
          theme="vs-dark"
          value={sql}
          onChange={(value) => setSql(value ?? '')}
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
      <Content style={{ overflow: 'auto', background: token.colorBgContainer }}>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setActiveTab(key as 'results' | 'messages')}
          size="small"
          style={{ padding: '0 16px' }}
          tabBarExtraContent={
            latestResult && latestResult.type !== 'error' ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {latestResult.type === 'query'
                  ? `${latestResult.rows?.length ?? 0} 行 · ${latestResult.duration}ms`
                  : `影响 ${latestResult.affectedRows ?? 0} 行 · ${latestResult.duration}ms`
                }
              </Text>
            ) : null
          }
          items={[
            {
              key: 'results',
              label: '结果',
              children: latestResult?.type === 'query' ? (
                <Table
                  columns={resultColumns}
                  dataSource={latestResult.rows?.map((r, i) => ({ ...r, _key: i }))}
                  rowKey="_key"
                  pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], size: 'small' }}
                  size="small"
                  scroll={{ x: 'max-content' }}
                />
              ) : latestResult?.type === 'update' ? (
                <div style={{ padding: 24, textAlign: 'center' }}>
                  <Tag color="success">执行成功</Tag>
                  <Text type="secondary">
                    影响 {latestResult.affectedRows} 行，耗时 {latestResult.duration}ms
                  </Text>
                </div>
              ) : (
                <EmptyState description="执行 SQL 后在此查看结果" />
              ),
            },
            {
              key: 'messages',
              label: '消息',
              children: (
                <div style={{ padding: 12 }}>
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
    </Layout>
  )
}
