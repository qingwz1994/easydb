import React, { useState, useCallback, useRef } from 'react'
import {
  Layout, Button, Space, Typography, Tabs, Table, Tag,
  theme,
} from 'antd'
import {
  PlayCircleOutlined, ClearOutlined,
  CodeOutlined,
} from '@ant-design/icons'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { SqlResult } from '@/types'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { sqlApi } from '@/services/api'
import { EmptyState } from '@/components/EmptyState'
import { handleApiError, toast } from '@/utils/notification'
import { useNavigate } from 'react-router-dom'

const { Content, Header } = Layout
const { Text } = Typography

export const SqlEditorPage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  const activeConnectionId = useWorkbenchStore((s) => s.activeConnectionId)
  const activeConnectionName = useWorkbenchStore((s) => s.activeConnectionName)
  const activeDatabase = useWorkbenchStore((s) => s.activeDatabase)

  const [sql, setSql] = useState('')
  const [executing, setExecuting] = useState(false)
  const [results, setResults] = useState<SqlResult[]>([])
  const [activeTab, setActiveTab] = useState<'results' | 'messages'>('results')

  if (!activeConnectionId) {
    return (
      <EmptyState
        description="请先在「连接管理」中打开一个连接"
        actionText="前往连接管理"
        onAction={() => navigate('/connection')}
      />
    )
  }

  if (!activeDatabase) {
    return (
      <EmptyState
        description="请先在「数据库工作台」中选择一个数据库"
        actionText="前往工作台"
        onAction={() => navigate('/workbench')}
      />
    )
  }

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor

    // ⌘+Enter / Ctrl+Enter 执行 SQL
    editor.addAction({
      id: 'execute-sql',
      label: '执行 SQL',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => handleExecute(),
    })

    editor.focus()
  }

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
      const result = await sqlApi.execute(activeConnectionId, activeDatabase, execSql) as SqlResult
      setResults((prev) => [result, ...prev])
      if (result.type === 'error') {
        toast.error(result.error ?? 'SQL 执行失败')
        setActiveTab('messages')
      } else {
        setActiveTab('results')
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
        <Space>
          <CodeOutlined />
          <Text strong style={{ fontSize: 13 }}>SQL 编辑器</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {activeConnectionName} / {activeDatabase}
          </Text>
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
                  pagination={{ pageSize: 50, size: 'small' }}
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
