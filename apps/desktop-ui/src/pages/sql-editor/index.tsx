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
import React, { useState, useCallback, useRef, useEffect } from 'react'
import {
  Layout, Button, Space, Typography, Tabs, Tag, Select,
  theme, Tooltip,
} from 'antd'
import {
  PlayCircleOutlined, ClearOutlined,
  CodeOutlined, PlusOutlined, StarOutlined, FolderOpenOutlined
} from '@ant-design/icons'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { SqlResult, ConnectionConfig } from '@/types'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSqlEditorStore } from '@/stores/sqlEditorStore'
import { sqlApi, metadataApi, connectionApi } from '@/services/api'
import { EmptyState } from '@/components/EmptyState'
import { SqlResultPanel } from '@/components/SqlResultPanel'
import { handleApiError, toast } from '@/utils/notification'
import { createSqlCompletionProvider, clearCompletionCache } from './sqlCompletionProvider'
import {
  DEFAULT_SQL_PREVIEW_PAGE_SIZE,
  isPreviewableSql,
  MAX_SQL_PREVIEW_CELL_CHARS,
  mergeSqlPreviewResult,
  normalizeExecutableSql,
} from './queryPreview'
import { SaveScriptModal } from './SaveScriptModal'
import { SavedScriptsModal } from './SavedScriptsModal'
import { formatHotkey } from '@/utils/osUtils'

const { Content } = Layout
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
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null)
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [listModalOpen, setListModalOpen] = useState(false)
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
      }).catch(() => {})
    }
  }, [connections.length, setConnections])

  // --- 手写拖拽分割线 Hook ---
  const [editorHeight, setEditorHeight] = useState(300)
  const isDraggingRef = useRef(false)

  useEffect(() => {
    const handleMouseMove = (e: globalThis.MouseEvent) => {
      if (!isDraggingRef.current) return
      // 头部导航 + Tab高度 大约扣除 90px
      const newHeight = e.clientY - 90
      setEditorHeight(Math.max(100, Math.min(newHeight, window.innerHeight - 200)))
    }
    const handleMouseUp = () => {
      isDraggingRef.current = false
      document.body.style.cursor = 'default'
      document.body.style.userSelect = 'auto'
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

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
      clearCompletionCache()
    }
  }

  const handleDatabaseChange = (db: string) => {
    if (activeEditorTab) {
      updateActiveTab({ database: db })
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

  // --- 连接/数据库变化时自动重新注册 CompletionProvider ---
  useEffect(() => {
    if (currentConnId && currentDatabase && monacoRef.current) {
      completionDisposableRef.current?.dispose()
      completionDisposableRef.current = monacoRef.current.languages.registerCompletionItemProvider(
        'sql',
        createSqlCompletionProvider(currentConnId, currentDatabase, monacoRef.current)
      )
    }
    return () => {
      completionDisposableRef.current?.dispose()
    }
  }, [currentConnId, currentDatabase])

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
    const normalizedSql = normalizeExecutableSql(execSql)
    setExecuting(true)
    try {
      const resultList = isPreviewableSql(normalizedSql)
        ? [await sqlApi.queryPreview({
          connectionId: activeEditorTab.connectionId,
          database: activeEditorTab.database,
          sql: normalizedSql,
          offset: 0,
          pageSize: DEFAULT_SQL_PREVIEW_PAGE_SIZE,
          maxCellChars: MAX_SQL_PREVIEW_CELL_CHARS,
        }) as SqlResult]
        : await sqlApi.execute(activeEditorTab.connectionId, activeEditorTab.database, execSql) as SqlResult[]

      // 为预览结果添加 connectionId 和 database，用于后续加载更多
      const enrichedResultList = resultList.map((r) => ({
        ...r,
        connectionId: activeEditorTab.connectionId,
        database: activeEditorTab.database,
      }))

      const newResults = [...[...enrichedResultList].reverse(), ...activeEditorTab.results]

      const hasError = enrichedResultList.some((r) => r.type === 'error')
      if (hasError) {
        const errorMsg = enrichedResultList.find((r) => r.type === 'error')?.error ?? 'SQL 执行失败'
        toast.error(errorMsg)
        updateActiveTab({ results: newResults, currentBatch: enrichedResultList, resultTab: 'messages' })
      } else {
        const hasQuery = enrichedResultList.some((r) => r.type === 'query')
        if (hasQuery) {
          updateActiveTab({ results: newResults, currentBatch: enrichedResultList, resultTab: 'result-0' })
        } else {
          const totalAffected = enrichedResultList.reduce((sum, r) => sum + (r.affectedRows ?? 0), 0)
          toast.success(`执行成功，共影响 ${totalAffected} 行`)
          updateActiveTab({ results: newResults, currentBatch: enrichedResultList, resultTab: 'messages' }) // 全是 update 的情况跳转到消息
        }
      }
    } catch (e) {
      handleApiError(e, 'SQL 执行失败')
    } finally {
      setExecuting(false)
    }
  }, [activeEditorTab, updateActiveTab])

  const handleLoadMore = useCallback(async (batchIndex: number) => {
    if (!activeEditorTab) return
    const target = activeEditorTab.currentBatch?.[batchIndex]
    if (!target || target.type !== 'query' || !target.preview || !target.hasMore) return
    if (!target.connectionId || !target.database) return

    const loadKey = `${activeEditorTab.key}-${batchIndex}`
    setLoadingMoreKey(loadKey)
    try {
      // 用 rows.length 作为新的 offset
      const offset = target.rows?.length ?? 0

      const next = await sqlApi.queryPreview({
        connectionId: target.connectionId,
        database: target.database,
        sql: target.sql,
        offset,
        pageSize: target.pageSize ?? DEFAULT_SQL_PREVIEW_PAGE_SIZE,
        maxCellChars: MAX_SQL_PREVIEW_CELL_CHARS,
      }) as SqlResult

      if (next.type === 'error') {
        toast.error(next.error ?? '加载更多失败')
        return
      }

      // 为新结果添加 connectionId 和 database
      const enrichedNext = {
        ...next,
        connectionId: target.connectionId,
        database: target.database,
      }

      updateActiveTab({
        currentBatch: (activeEditorTab.currentBatch ?? []).map((result, idx) => {
          if (idx !== batchIndex) return result
          return mergeSqlPreviewResult(result, enrichedNext)
        }),
      })
    } catch (error) {
      handleApiError(error, '加载更多失败')
    } finally {
      setLoadingMoreKey(null)
    }
  }, [activeEditorTab, updateActiveTab])

  const handleResultMetaChange = useCallback((batchIndex: number, patch: Partial<SqlResult>) => {
    updateActiveTab({
      currentBatch: (activeEditorTab?.currentBatch ?? []).map((result, idx) => (
        idx === batchIndex ? { ...result, ...patch } : result
      )),
    })
  }, [activeEditorTab?.currentBatch, updateActiveTab])

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
  const resultTableHeight = Math.max(240, (typeof window !== 'undefined' ? window.innerHeight : 900) - editorHeight - 250)
  const tableNameCounts: Record<string, number> = {}
  
  const allParsedNames = extractAllTableNames(currentBatch[0]?.sql || '')
  let queryIndex = 0

  return (
    <Layout style={{ height: '100%', background: 'transparent' }}>
      <Layout style={{ flex: 1, background: 'transparent' }}>
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
          <div style={{ borderBottom: '1px solid var(--glass-border)' }}>
            <Tabs
              className="sql-editor-tabs"
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

          {/* 编辑器上下文悬浮栏 */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 16px', borderBottom: '1px solid var(--glass-border)', background: 'var(--glass-panel)', backdropFilter: 'var(--glass-blur-sm)'
          }}>
            <Space size={12}>
              <Select
                size="small"
                variant="filled"
                style={{ width: 160 }}
                placeholder="选择连接"
                value={activeEditorTab.connectionId}
                onChange={handleConnectionChange}
                options={connections.map((c) => ({
                  label: (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>{c.name}</span>
                      {c.status !== 'connected' && (
                        <span style={{ fontSize: 12, color: token.colorTextQuaternary }}>未连</span>
                      )}
                    </div>
                  ),
                  value: c.id
                }))}
                listHeight={320}
              />
              <Select
                size="small"
                variant="filled"
                style={{ width: 160 }}
                placeholder="选择数据库"
                value={activeEditorTab.database}
                onChange={handleDatabaseChange}
                options={databases.map((db) => ({ label: db, value: db }))}
                disabled={!activeEditorTab.connectionId}
                showSearch
              />
            </Space>
            <Space>
              <Button size="small" icon={<FolderOpenOutlined />} onClick={() => setListModalOpen(true)}>
                打开收藏
              </Button>
              <Button size="small" icon={<StarOutlined />} onClick={() => setSaveModalOpen(true)} disabled={!activeEditorTab?.sql?.trim()}>
                收藏
              </Button>
              <Tooltip title={`执行当前/已选 SQL (${formatHotkey(['Cmd', 'Enter'])})`}>
                <Button type="primary" size="small" icon={<PlayCircleOutlined />} loading={executing} onClick={handleExecute} disabled={!activeEditorTab?.sql?.trim() || !activeEditorTab.connectionId || !activeEditorTab.database}>
                  执行
                </Button>
              </Tooltip>
              <Button size="small" icon={<ClearOutlined />} onClick={handleClear}>清空</Button>
            </Space>
          </div>

          {/* Monaco 编辑器区域 */}
          <div style={{ height: editorHeight, position: 'relative' }}>
            {!activeEditorTab.connectionId ? (
              <EmptyState
                description="请先在顶部下拉框中选择一个数据库连接"
                actionText="前往连接管理"
                onAction={() => { window.location.hash = '/connection' }}
              />
            ) : !activeEditorTab.database ? (
              <EmptyState description="请在上方选择我们要查询的数据库" />
            ) : (
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
            )}
          </div>

          {/* 拖拽分割条 */}
          <div
            onMouseDown={() => {
              isDraggingRef.current = true
              document.body.style.cursor = 'row-resize'
              document.body.style.userSelect = 'none'
            }}
            style={{
              height: 4, cursor: 'row-resize', background: 'var(--glass-border)', zIndex: 10,
              opacity: 0.5, transition: 'opacity 0.2s', borderBottom: '1px solid var(--glass-border)'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={(e) => (!isDraggingRef.current && (e.currentTarget.style.opacity = '0.5'))}
          />

              {/* 结果区 */}
              <Content style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'transparent', flex: 1 }}>
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
                          <SqlResultPanel
                            result={r}
                            displayLabel={displayLabel}
                            tableHeight={resultTableHeight}
                            loadMoreKey={`${activeEditorTab.key}-${idx}`}
                            currentLoadKey={loadingMoreKey}
                            onLoadMore={r.preview && r.hasMore ? () => handleLoadMore(idx) : undefined}
                            onResultMetaChange={(patch) => handleResultMetaChange(idx, patch)}
                          />
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
                        <div style={{ padding: 12, overflow: 'auto', height: `calc(100vh - ${editorHeight + 150}px)` }}>
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
                                  ? r.preview
                                    ? `✅ 预览加载 ${r.loadedRows ?? r.rows?.length ?? 0} 行${r.hasMore ? '（还有更多）' : ''} (${r.duration}ms)`
                                    : `✅ 查询返回 ${r.rows?.length ?? 0} 行 (${r.duration}ms)`
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
        </Layout.Content>
      </Layout>

      {/* 收藏脚本弹窗 */}
      {activeEditorTab && (
        <SaveScriptModal
          open={saveModalOpen}
          initialSql={activeEditorTab.sql}
          database={activeEditorTab.database}
          onCancel={() => setSaveModalOpen(false)}
          onSuccess={() => {
            setSaveModalOpen(false)
          }}
        />
      )}
      <SavedScriptsModal
        open={listModalOpen}
        onCancel={() => setListModalOpen(false)}
        onSelect={(script) => {
          if (activeTabKey) {
            updateTabSql(activeTabKey, script.content)
            toast.success('已应用收藏脚本到当前编辑区')
          }
        }}
      />
    </Layout>
  )
}
