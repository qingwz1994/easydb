import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Layout, Button, Space, Typography, Tabs, Select, theme } from 'antd'
import { PlayCircleOutlined, ClearOutlined } from '@ant-design/icons'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { SqlResult } from '@/types'
import { useSqlEditorStore, type EditorTab } from '@/stores/sqlEditorStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { sqlApi, connectionApi, metadataApi } from '@/services/api'
import { SqlResultPanel } from '@/components/SqlResultPanel'
import { handleApiError, toast } from '@/utils/notification'
import { createSqlCompletionProvider, clearCompletionCache } from '../pages/sql-editor/sqlCompletionProvider'
import {
  DEFAULT_SQL_PREVIEW_PAGE_SIZE,
  collectSqlQuerySessionIds,
  isPreviewableSql,
  MAX_SQL_PREVIEW_CELL_CHARS,
  mergeSqlPreviewResult,
  normalizeExecutableSql,
} from '../pages/sql-editor/queryPreview'
import { EmptyState } from '@/components/EmptyState'

const { Content } = Layout
const { Text } = Typography

const extractAllTableNames = (sql: string): string[] => {
  if (!sql) return []
  const regex = /(?:from|update|into)\s+([`'"]?[a-zA-Z0-9_$]+[`'"]?)/gi
  const matches = [...sql.matchAll(regex)]
  return matches.map(m => m[1].replace(/[`'"]/g, ''))
}

interface QueryEditorPaneProps {
  queryId: string
}

export const QueryEditorPane: React.FC<QueryEditorPaneProps> = ({ queryId }) => {
  const { token } = theme.useToken()
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null)

  const connections = useConnectionStore((s) => s.connections)
  const updateConnection = useConnectionStore((s) => s.updateConnection)
  
  const activeEditorTab = useSqlEditorStore(useCallback(s => s.tabs.find(t => t.key === queryId), [queryId]))
  const storeUpdateTab = useSqlEditorStore((s) => s.updateTab)
  
  const [executing, setExecuting] = useState(false)
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null)
  const [databases, setDatabases] = useState<string[]>([])
  
  const [editorHeight, setEditorHeight] = useState(300)
  const isDraggingRef = useRef(false)

  useEffect(() => {
    const handleMouseMove = (e: globalThis.MouseEvent) => {
      if (!isDraggingRef.current) return
      // Approx offset for top header + tabs
      const newHeight = e.clientY - 140
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

  const updateActiveTab = useCallback((updates: Partial<typeof activeEditorTab>) => {
    if (activeEditorTab) {
      storeUpdateTab(queryId, updates as Partial<EditorTab>)
    }
  }, [queryId, storeUpdateTab, activeEditorTab])

  // Fetch DBs whenever connection changes within this tab
  useEffect(() => {
    if (!activeEditorTab?.connectionId) { setDatabases([]); return }
    metadataApi.databases(activeEditorTab.connectionId).then((dbs) => {
      setDatabases((dbs as Array<{name: string}>).map(d => d.name))
    }).catch(() => setDatabases([]))
  }, [activeEditorTab?.connectionId])

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
    updateActiveTab({ connectionId: connId, database: undefined })
    clearCompletionCache()
  }

  const handleDatabaseChange = (db: string) => {
    updateActiveTab({ database: db })
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

  // --- 自动重新注册 CompletionProvider ---
  useEffect(() => {
    if (activeEditorTab?.connectionId && activeEditorTab?.database && monacoRef.current) {
      completionDisposableRef.current?.dispose()
      completionDisposableRef.current = monacoRef.current.languages.registerCompletionItemProvider(
        'sql',
        createSqlCompletionProvider(activeEditorTab.connectionId, activeEditorTab.database, monacoRef.current)
      )
    }
    return () => {
      completionDisposableRef.current?.dispose()
    }
  }, [activeEditorTab?.connectionId, activeEditorTab?.database])

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
    const executeStartTime = Date.now()

    setExecuting(true)
    try {
      // 关闭之前的 session（fire-and-forget，不阻塞新查询的执行）
      const previousSessionIds = collectSqlQuerySessionIds(activeEditorTab.currentBatch, activeEditorTab.results)
      if (previousSessionIds.length > 0) {
        Promise.allSettled(previousSessionIds.map((querySessionId) => sqlApi.querySessionClose(querySessionId)))
      }

      // 拆分多条 SQL，每条 SELECT 走 querySession 流式分页（类似 DBeaver），非 SELECT 走 execute
      const statements = execSql
        .split(/;(?=(?:[^']*'[^']*')*[^']*$)/) // 按分号拆分，但忽略引号内的分号
        .map(s => s.trim())
        .filter(s => s.length > 0)

      const resultList: SqlResult[] = []
      for (const stmt of statements) {
        const normalized = normalizeExecutableSql(stmt)
        if (!normalized) continue

        if (isPreviewableSql(normalized)) {

          const result = await sqlApi.querySessionStart({
            connectionId: activeEditorTab.connectionId,
            database: activeEditorTab.database,
            sql: normalized,
            pageSize: DEFAULT_SQL_PREVIEW_PAGE_SIZE,
            maxCellChars: MAX_SQL_PREVIEW_CELL_CHARS,
          }) as SqlResult

          resultList.push(result)
        } else {
          // DML / DDL：走一次性执行
          const results = await sqlApi.execute(
            activeEditorTab.connectionId, activeEditorTab.database, stmt
          ) as SqlResult[]
          resultList.push(...results)
        }
      }


      const totalElapsed = Date.now() - executeStartTime
      const adjustedResults = resultList.map(r => ({ ...r, duration: totalElapsed }))
      const newResults = [...[...adjustedResults].reverse(), ...(activeEditorTab.results || [])]


      const hasError = resultList.some((r) => r.type === 'error')
      if (hasError) {
        const errorMsg = resultList.find((r) => r.type === 'error')?.error ?? 'SQL 执行失败'
        toast.error(errorMsg)
        updateActiveTab({ results: newResults, currentBatch: adjustedResults, resultTab: 'messages' })
      } else {
        const hasQuery = resultList.some((r) => r.type === 'query')
        if (hasQuery) {
          updateActiveTab({ results: newResults, currentBatch: adjustedResults, resultTab: 'result-0' })
        } else {
          const totalAffected = resultList.reduce((sum, r) => sum + (r.affectedRows ?? 0), 0)
          toast.success(`执行成功，共影响 ${totalAffected} 行`)
          updateActiveTab({ results: newResults, currentBatch: adjustedResults, resultTab: 'messages' })
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
    if (!target || target.type !== 'query' || !target.preview || !target.hasMore || !target.querySessionId) return

    const loadKey = `${queryId}-${batchIndex}`
    setLoadingMoreKey(loadKey)
    try {
      const next = await sqlApi.querySessionFetch({
        querySessionId: target.querySessionId,
        pageSize: target.pageSize ?? DEFAULT_SQL_PREVIEW_PAGE_SIZE,
        maxCellChars: MAX_SQL_PREVIEW_CELL_CHARS,
      }) as SqlResult

      if (next.type === 'error') {
        // 会话已过期/关闭时，标记加载完毕而不是报错（可能是竞态：数据已全部加载）
        updateActiveTab({
          currentBatch: (activeEditorTab.currentBatch ?? []).map((result, idx) => {
            if (idx !== batchIndex) return result
            return { ...result, hasMore: false }
          }),
        })
        return
      }

      updateActiveTab({
        currentBatch: (activeEditorTab.currentBatch ?? []).map((result, idx) => {
          if (idx !== batchIndex) return result
          return mergeSqlPreviewResult(result, next)
        }),
      })
    } catch (error) {
      handleApiError(error, '加载更多失败')
    } finally {
      setLoadingMoreKey(null)
    }
  }, [activeEditorTab, queryId, updateActiveTab])

  const handleResultMetaChange = useCallback((batchIndex: number, patch: Partial<SqlResult>) => {
    updateActiveTab({
      currentBatch: (activeEditorTab?.currentBatch ?? []).map((result, idx) => (
        idx === batchIndex ? { ...result, ...patch } : result
      )),
    })
  }, [activeEditorTab?.currentBatch, updateActiveTab])

  const handleClear = () => {
    updateActiveTab({ sql: '' })
    editorRef.current?.setValue('')
    editorRef.current?.focus()
  }

  if (!activeEditorTab) return null

  const currentBatch = activeEditorTab.currentBatch ?? []
  const results = activeEditorTab.results ?? []
  const totalDuration = currentBatch.reduce((sum, r) => sum + (r.duration || 0), 0)
  const resultTableHeight = Math.max(240, (typeof window !== 'undefined' ? window.innerHeight : 900) - editorHeight - 230)
  const tableNameCounts: Record<string, number> = {}
  let queryIndex = 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 快捷连接栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        padding: '8px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}`, background: token.colorBgContainer
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
          <Button type="primary" size="small" icon={<PlayCircleOutlined />} loading={executing} onClick={handleExecute} disabled={!activeEditorTab?.sql?.trim() || !activeEditorTab.connectionId || !activeEditorTab.database}>
            执行
          </Button>
          <Button size="small" icon={<ClearOutlined />} onClick={handleClear}>清空</Button>
        </Space>
      </div>

      {/* Editor 区 */}
      <div style={{ height: editorHeight, position: 'relative', flexShrink: 0 }}>
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
            key={`editor-${queryId}`}
            height="100%"
            language="sql"
            theme="vs-dark"
            defaultValue={activeEditorTab.sql}
            onChange={(value) => updateActiveTab({ sql: value ?? '' })}
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
              bracketPairColorization: { enabled: true },
              padding: { top: 8, bottom: 8 },
              placeholder: '输入 SQL 语句... (⌘+Enter 执行，支持选中部分执行)',
            } as editor.IStandaloneEditorConstructionOptions}
          />
        )}
      </div>

      {/* Resize Handle */}
      <div
        onMouseDown={() => {
          isDraggingRef.current = true
          document.body.style.cursor = 'row-resize'
          document.body.style.userSelect = 'none'
        }}
        style={{
          height: 4, cursor: 'row-resize', background: token.colorBgSpotlight, zIndex: 10,
          opacity: 0.5, transition: 'opacity 0.2s', borderBottom: `1px solid ${token.colorBorderSecondary}`
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={(e) => (!isDraggingRef.current && (e.currentTarget.style.opacity = '0.5'))}
      />

      {/* Results 区 */}
      <Content style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', background: token.colorBgContainer, flex: 1 }}>
        <Tabs
          destroyInactiveTabPane
          activeKey={activeEditorTab.resultTab}
          onChange={(key) => updateActiveTab({ resultTab: key })}
          size="small"
          style={{ padding: '0 16px', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          tabBarStyle={{ marginBottom: 0 }}
          tabBarExtraContent={
            currentBatch.length > 0 && !currentBatch.some(r => r.type === 'error') ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                共 {currentBatch.length} 条语句 · 耗时 {totalDuration}ms
              </Text>
            ) : null
          }
          items={[
            ...currentBatch.map((r, idx) => {
              if (r.type !== 'query') return null
              const currentQueryIndex = queryIndex++
              
              // 从每条结果自身的 SQL 中提取表名
              const parsedNames = extractAllTableNames(r.sql || '')
              const parsedName = parsedNames[0]
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
                    loadMoreKey={`${queryId}-${idx}`}
                    currentLoadKey={loadingMoreKey}
                    onLoadMore={r.preview && r.hasMore ? () => handleLoadMore(idx) : undefined}
                    onResultMetaChange={(patch) => handleResultMetaChange(idx, patch)}
                  />
                )
              }
            }).filter(Boolean) as Array<{ key: string, label: string, children: React.ReactNode }>,
            {
              key: 'messages',
              label: '消息',
              children: (
                <div style={{ padding: '8px 0', height: '100%', overflow: 'auto' }}>
                  {results.slice(0, 50).map((r, i) => (
                    <div key={i} style={{ 
                      fontFamily: 'monospace', fontSize: 13, marginBottom: 4, 
                      color: r.type === 'error' ? token.colorError : token.colorSuccessText,
                      padding: '4px 8px',
                      background: r.type === 'error' ? token.colorErrorBg : token.colorSuccessBg,
                      borderRadius: 4
                    }}>
                      {r.type === 'error'
                        ? `[ERROR] ${r.error}`
                        : r.type === 'query'
                          ? r.preview
                            ? `[OK] 预览加载 ${r.loadedRows ?? r.rows?.length ?? 0} 行${r.hasMore ? '（还有更多）' : ''}. (耗时 ${r.duration}ms)`
                            : `[OK] 查询返回 ${r.loadedRows ?? r.rows?.length ?? 0} 行${r.hasMore ? '（结果已截断，请添加 LIMIT 限制查询范围）' : ''}. (耗时 ${r.duration}ms)`
                          : `[OK] 影响 ${r.affectedRows} 行. (耗时 ${r.duration}ms)`}
                      <div style={{ color: token.colorTextQuaternary, fontSize: 12, marginTop: 2, whiteSpace: 'pre-wrap' }}>{r.sql}</div>
                    </div>
                  ))}
                  {results.length === 0 && <Text type="secondary">暂无执行记录</Text>}
                </div>
              ),
            }
          ]}
        />
      </Content>
    </div>
  )
}
