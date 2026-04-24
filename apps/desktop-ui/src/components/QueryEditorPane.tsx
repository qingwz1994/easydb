import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Layout, Button, Space, Typography, Tabs, Select, Spin, theme, Tooltip } from 'antd'
import { PlayCircleOutlined, ClearOutlined, StarOutlined, FolderOpenOutlined, HistoryOutlined } from '@ant-design/icons'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import type { SqlResult, EditabilityStatus } from '@/types'
import { useSqlEditorStore, type EditorTab } from '@/stores/sqlEditorStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { sqlApi, connectionApi, metadataApi } from '@/services/api'
import { SqlResultPanel } from '@/components/SqlResultPanel'
import { EditableDataTable } from '@/components/EditableDataTable'
import { analyzeEditability, extractAllTableNames } from '@/utils/editabilityAnalyzer'
import { handleApiError, toast } from '@/utils/notification'
import { createSqlCompletionProvider, clearCompletionCache } from '../pages/sql-editor/sqlCompletionProvider'
import { SaveScriptModal } from '../pages/sql-editor/SaveScriptModal'
import { SavedScriptsModal } from '../pages/sql-editor/SavedScriptsModal'
import { SqlHistoryDrawer } from '../pages/sql-editor/SqlHistoryDrawer'
import { useAppSettingsStore } from '@/stores/appSettingsStore'
import { formatHotkey } from '@/utils/osUtils'
import {
  DEFAULT_SQL_PREVIEW_PAGE_SIZE,
  isPreviewableSql,
  MAX_SQL_PREVIEW_CELL_CHARS,
  mergeSqlPreviewResult,
  normalizeExecutableSql,
} from '../pages/sql-editor/queryPreview'
import { EmptyState } from '@/components/EmptyState'

const { Content } = Layout
const { Text } = Typography

interface QueryEditorPaneProps {
  queryId: string
  /** 开启高级 SQL 工具（收藏脚本、SQL 历史等）。默认开启。 */
  showAdvancedTools?: boolean
}

export const QueryEditorPane: React.FC<QueryEditorPaneProps> = ({ queryId, showAdvancedTools = true }) => {
  const { token } = theme.useToken()
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null)

  const connections = useConnectionStore((s) => s.connections)
  const updateConnection = useConnectionStore((s) => s.updateConnection)
  
  const activeEditorTab = useSqlEditorStore(useCallback(s => s.tabs.find(t => t.key === queryId), [queryId]))
  const storeUpdateTab = useSqlEditorStore((s) => s.updateTab)

  // Advanced tools state
  const sqlHistoryEnabled          = useAppSettingsStore((s) => s.sqlHistoryEnabled)
  const sqlHistoryFilterByDatabase = useAppSettingsStore((s) => s.sqlHistoryFilterByDatabase)
  const [saveModalOpen, setSaveModalOpen] = useState(false)
  const [listModalOpen, setListModalOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  
  const [executing, setExecuting] = useState(false)
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null)
  const [databases, setDatabases] = useState<string[]>([])
  const [editabilityMap, setEditabilityMap] = useState<Map<number, EditabilityStatus>>(new Map())
  const [analyzingEditability, setAnalyzingEditability] = useState(false)

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
      // 拆分多条 SQL，每条 SELECT  queryPreview 流式分页（类似 DBeaver），非 SELECT 走 execute
      const statements = execSql
        .split(/;(?=(?:[^']*'[^']*')*[^']*$)/) // 按分号拆分，但忽略引号内的分号
        .map(s => s.trim())
        .filter(s => s.length > 0)

      const resultList: SqlResult[] = []
      for (const stmt of statements) {
        const normalized = normalizeExecutableSql(stmt)
        if (!normalized) continue

        if (isPreviewableSql(normalized)) {
          const result = await sqlApi.queryPreview({
            connectionId: activeEditorTab.connectionId,
            database: activeEditorTab.database,
            sql: normalized,
            offset: 0,
            pageSize: DEFAULT_SQL_PREVIEW_PAGE_SIZE,
            maxCellChars: MAX_SQL_PREVIEW_CELL_CHARS,
          }) as SqlResult

          // 为结果添加 connectionId 和 database，用于后续加载更多和编辑性分析
          resultList.push({
            ...result,
            connectionId: activeEditorTab.connectionId,
            database: activeEditorTab.database,
          })
        } else {
          // DML / DDL：走一次性执行
          const results = await sqlApi.execute(
            activeEditorTab.connectionId, activeEditorTab.database, stmt
          ) as SqlResult[]
          // 补充连接信息，用于编辑性分析
          resultList.push(...results.map(r => ({
            ...r,
            connectionId: activeEditorTab.connectionId,
            database: activeEditorTab.database,
          })))
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
    if (!target || target.type !== 'query' || !target.preview || !target.hasMore) return
    if (!target.connectionId || !target.database) return

    const loadKey = `${queryId}-${batchIndex}`
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
  }, [activeEditorTab, queryId, updateActiveTab])

  const handleResultMetaChange = useCallback((batchIndex: number, patch: Partial<SqlResult>) => {
    updateActiveTab({
      currentBatch: (activeEditorTab?.currentBatch ?? []).map((result, idx) => (
        idx === batchIndex ? { ...result, ...patch } : result
      )),
    })
  }, [activeEditorTab?.currentBatch, updateActiveTab])

  // 分析查询结果的可编辑性
  useEffect(() => {
    const currentBatch = activeEditorTab?.currentBatch ?? []
    if (currentBatch.length === 0) {
      setEditabilityMap(new Map())
      return
    }

    let cancelled = false

    const analyzeBatch = async () => {
      setAnalyzingEditability(true)
      const newMap = new Map<number, EditabilityStatus>()

      for (let idx = 0; idx < currentBatch.length; idx++) {
        if (cancelled) return
        const result = currentBatch[idx]
        if (result.type === 'query') {
          try {
            const status = await analyzeEditability(result, metadataApi)
            if (cancelled) return
            newMap.set(idx, status)
          } catch {
            if (cancelled) return
            newMap.set(idx, { editable: false, reason: 'metadata_error' })
          }
        }
      }

      if (!cancelled) {
        setEditabilityMap(newMap)
        setAnalyzingEditability(false)
      }
    }

    analyzeBatch()
    return () => { cancelled = true }
  }, [activeEditorTab?.currentBatch])

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
    <>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 快捷连接栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
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
          {showAdvancedTools && (
            <>
              <Button size="small" icon={<FolderOpenOutlined />} onClick={() => setListModalOpen(true)}>
                打开收藏
              </Button>
              <Button size="small" icon={<StarOutlined />} onClick={() => setSaveModalOpen(true)} disabled={!activeEditorTab?.sql?.trim()}>
                收藏
              </Button>
              <Tooltip title="查看当前连接的 SQL 执行历史">
                <Button
                  size="small"
                  icon={<HistoryOutlined />}
                  onClick={() => setHistoryOpen(true)}
                  disabled={!activeEditorTab?.connectionId || !sqlHistoryEnabled}
                >
                  历史
                </Button>
              </Tooltip>
              <Tooltip title={`执行当前/已选 SQL (${formatHotkey(['Cmd', 'Enter'])})`}>
                <Button type="primary" size="small" icon={<PlayCircleOutlined />} loading={executing} onClick={handleExecute} disabled={!activeEditorTab?.sql?.trim() || !activeEditorTab.connectionId || !activeEditorTab.database}>
                  执行
                </Button>
              </Tooltip>
            </>
          )}
          {!showAdvancedTools && (
            <Button type="primary" size="small" icon={<PlayCircleOutlined />} loading={executing} onClick={handleExecute} disabled={!activeEditorTab?.sql?.trim() || !activeEditorTab.connectionId || !activeEditorTab.database}>
              执行
            </Button>
          )}
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
          height: 4, cursor: 'row-resize', background: 'var(--glass-border)', zIndex: 10,
          opacity: 0.5, transition: 'opacity 0.2s', borderBottom: '1px solid var(--glass-border)'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={(e) => (!isDraggingRef.current && (e.currentTarget.style.opacity = '0.5'))}
      />

      {/* Results 区 */}
      <Content style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'transparent', flex: 1 }}>
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
                children: (() => {
                  const editability = editabilityMap.get(idx)

                  // 正在分析时显示加载状态（包括 preview 模式）
                  if (!editability && analyzingEditability) {
                    return (
                      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: resultTableHeight }}>
                        <Spin tip="分析可编辑性..." />
                      </div>
                    )
                  }

                  // 可编辑：渲染 EditableDataTable
                  if (editability?.editable && editability.tableName && editability.columns) {
                    return (
                      <EditableDataTable
                        connectionId={r.connectionId!}
                        database={r.database!}
                        tableName={editability.tableName}
                        columns={editability.columns}
                        dataSource={r.rows ?? []}
                        onRefresh={() => handleExecute()}
                        hasMore={r.preview && r.hasMore}
                        onLoadMore={r.preview && r.hasMore ? () => handleLoadMore(idx) : undefined}
                        loadingMore={loadingMoreKey === `${queryId}-${idx}`}
                      />
                    )
                  }

                  // 不可编辑或预览模式：渲染 SqlResultPanel
                  return (
                    <SqlResultPanel
                      result={r}
                      displayLabel={displayLabel}
                      tableHeight={resultTableHeight}
                      loadMoreKey={`${queryId}-${idx}`}
                      currentLoadKey={loadingMoreKey}
                      onLoadMore={r.preview && r.hasMore ? () => handleLoadMore(idx) : undefined}
                      onResultMetaChange={(patch) => handleResultMetaChange(idx, patch)}
                      editabilityReason={editability?.reason}
                    />
                  )
                })()
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

    {/* 高级工具模态框（收藏脚本 / SQL 历史） */}
    {showAdvancedTools && activeEditorTab && (
      <>
        <SaveScriptModal
          open={saveModalOpen}
          initialSql={activeEditorTab.sql}
          database={activeEditorTab.database}
          onCancel={() => setSaveModalOpen(false)}
          onSuccess={() => setSaveModalOpen(false)}
        />
        <SavedScriptsModal
          open={listModalOpen}
          onCancel={() => setListModalOpen(false)}
          onSelect={(script) => {
            storeUpdateTab(queryId, { sql: script.content })
            editorRef.current?.setValue(script.content)
            editorRef.current?.focus()
            setListModalOpen(false)
            toast.success('已加载收藏脚本到编辑区')
          }}
        />
        <SqlHistoryDrawer
          open={historyOpen}
          connectionId={activeEditorTab.connectionId ?? ''}
          database={sqlHistoryFilterByDatabase ? (activeEditorTab.database ?? undefined) : undefined}
          onClose={() => setHistoryOpen(false)}
          onApply={(sql) => {
            if (editorRef.current) {
              editorRef.current.setValue(sql)
              editorRef.current.focus()
            } else {
              storeUpdateTab(queryId, { sql })
            }
            setHistoryOpen(false)
          }}
        />
      </>
    )}
  </>
  )
}
