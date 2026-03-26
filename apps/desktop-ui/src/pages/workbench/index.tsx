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
import React, { useEffect, useState, useCallback, useRef, useDeferredValue, useMemo, useLayoutEffect, type MouseEvent as ReactMouseEvent } from 'react'
import {
  Layout, Tree, Tabs, Table, Typography, Input, Space, Button, Tag, Tooltip, Modal, Dropdown,
  theme, Breadcrumb,
} from 'antd'
import {
  DatabaseOutlined, DownloadOutlined, UploadOutlined,
  CodeOutlined, ReloadOutlined,
  CloseOutlined, PlusOutlined,
  DeleteOutlined, EditOutlined,
} from '@ant-design/icons'
import { Database, Table2, Eye, Zap, Activity, Search, Plus } from 'lucide-react'
import type { DataNode } from 'antd/es/tree'
import type { DatabaseInfo, TableInfo, ColumnInfo, IndexInfo, ConnectionConfig } from '@/types'
import { useWorkbenchStore, type TableTabState, type WorkbenchTab } from '@/stores/workbenchStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSqlEditorStore } from '@/stores/sqlEditorStore'
import { metadataApi, connectionApi } from '@/services/api'
import { handleApiError, toast } from '@/utils/notification'
import { exportTableData } from '@/utils/exportUtils'
import { EmptyState } from '@/components/EmptyState'
import { EditableDataTable } from '@/components/EditableDataTable'
import { CreateDatabaseModal } from '@/components/CreateDatabaseModal'
import { EditDatabaseModal } from '@/components/EditDatabaseModal'
import { ImportSqlDialog } from '@/components/ImportSqlDialog'
import { TableDesigner } from '@/components/TableDesigner'
import { useNavigate } from 'react-router-dom'
import type { MenuProps } from 'antd'

const { Sider, Content } = Layout
const { Text } = Typography

/** 分类列表视图 — 独立组件，搜索状态通过 props 持久化 */
const CategoryListView: React.FC<{
  connectionId: string
  database: string
  category: string
  objects: TableInfo[]
  objectCategories: { key: string; label: string; types: string[]; icon: React.ReactNode }[]
  onSelectObject: (name: string) => void
  search: string
  onSearchChange: (value: string) => void
}> = ({ database, category, objects, objectCategories, onSelectObject, search, onSearchChange }) => {
  const { token } = theme.useToken()
  const deferredSearch = useDeferredValue(search)

  const catDef = objectCategories.find((c) => c.key === category)
  const categoryObjects = objects.filter((t) => catDef?.types.includes(t.type))
  const filtered = deferredSearch
    ? categoryObjects.filter(
        (t) =>
          t.name.toLowerCase().includes(deferredSearch.toLowerCase()) ||
          (t.comment && t.comment.toLowerCase().includes(deferredSearch.toLowerCase()))
      )
    : categoryObjects

  // 极速计算硬核 DBA 指标
  const isTables = category === 'tables'

  const formatBytes = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const maxDisk = isTables ? Math.max(...categoryObjects.map(t => (t.dataLength || 0) + (t.indexLength || 0)), 1) : 1
  const totalDisk = isTables ? categoryObjects.reduce((acc, t) => acc + (t.dataLength || 0) + (t.indexLength || 0), 0) : 0
  const topTable = isTables ? [...categoryObjects].sort((a, b) => ((b.dataLength || 0) + (b.indexLength || 0)) - ((a.dataLength || 0) + (a.indexLength || 0)))[0] : null
  const nonInnodbCount = isTables ? categoryObjects.filter(t => t.engine && t.engine.toUpperCase() !== 'INNODB').length : 0

  const catColumns =
    category === 'tables'
      ? [
          { title: '表名', dataIndex: 'name', key: 'name', ellipsis: true,
            render: (name: string) => <Text copyable={{ text: name }} strong style={{ fontSize: 13, color: token.colorPrimary }}>{name}</Text>,
          },
          { title: '注释', dataIndex: 'comment', key: 'comment', ellipsis: true,
            render: (v: string) => v ? <Text style={{ fontSize: 13 }}>{v}</Text> : <Text type="secondary" style={{ fontStyle: 'italic', fontSize: 12 }}>—</Text>,
          },
          { title: '物理空间占有 (Data+Index)', key: 'diskUsage', width: 220,
            render: (_: unknown, t: TableInfo) => {
              const totalBytes = (t.dataLength || 0) + (t.indexLength || 0)
              if (totalBytes === 0) return <Text type="secondary">—</Text>
              const pct = Math.min(100, Math.max(0.5, (totalBytes / maxDisk) * 100))
              return (
                <div style={{ position: 'relative', width: '100%', height: 22, display: 'flex', alignItems: 'center' }}>
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: token.colorPrimaryBg, borderRadius: 4, zIndex: 0 }} />
                  <span style={{ position: 'relative', zIndex: 1, paddingLeft: 6, fontSize: 12, fontFamily: 'monospace' }}>{formatBytes(totalBytes)}</span>
                </div>
              )
            },
          },
          { title: '引擎', dataIndex: 'engine', key: 'engine', width: 100,
            render: (v: string) => v ? <Tag color={v.toUpperCase() === 'INNODB' ? 'blue' : 'warning'}>{v.toUpperCase()}</Tag> : <Text type="secondary">—</Text>,
          },
          { title: '最后写入时间', dataIndex: 'updateTime', key: 'updateTime', width: 180,
            render: (v: string) => v ? <Text style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary" style={{ fontStyle: 'italic', fontSize: 12 }}>空/未记录</Text>,
          },
        ]
      : category === 'views'
        ? [
            { title: '视图名', dataIndex: 'name', key: 'name', ellipsis: true,
              render: (name: string) => <Text copyable={{ text: name }} style={{ fontSize: 13 }}>{name}</Text>,
            },
            { title: '注释', dataIndex: 'comment', key: 'comment', ellipsis: true,
              render: (v: string) => v || <Text type="secondary">—</Text>,
            },
          ]
        : [
            { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true,
              render: (name: string) => <Text style={{ fontSize: 13 }}>{name}</Text>,
            },
            { title: '类型', dataIndex: 'type', key: 'type', width: 100,
              render: (v: string) => <Tag>{v.toUpperCase()}</Tag>,
            },
          ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', padding: '24px 32px', background: token.colorBgLayout }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <Space>
          <Text strong style={{ fontSize: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            {catDef?.icon}
            <span>{catDef?.label} ({categoryObjects.length})</span>
          </Text>
          <Text type="secondary" style={{ fontSize: 13 }}>/ {database}</Text>
        </Space>
        <Input
          placeholder="在此过滤表名称或注释..."
          prefix={<Search size={14} color={token.colorTextQuaternary} style={{ marginRight: 4 }}/>}
          size="middle"
          variant="filled"
          style={{ width: 300, borderRadius: 6 }}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          allowClear
        />
      </div>

      {isTables && categoryObjects.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20, flexShrink: 0 }}>
          <div style={{ background: token.colorBgContainer, padding: '16px 20px', borderRadius: 12, border: `1px solid ${token.colorBorderSecondary}`, display: 'flex', flexDirection: 'column' }}>
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Zap size={14} color={token.colorPrimary}/> 磁盘存储霸主 (Top 1 物理体积)</Text>
            <Text strong style={{ fontSize: 16 }}>{topTable?.name}</Text>
            <Text type="secondary" style={{ fontSize: 12, marginTop: 4 }}>占据 {formatBytes((topTable?.dataLength || 0) + (topTable?.indexLength || 0))} 容量</Text>
          </div>
          <div style={{ background: token.colorBgContainer, padding: '16px 20px', borderRadius: 12, border: `1px solid ${token.colorBorderSecondary}`, display: 'flex', flexDirection: 'column' }}>
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Database size={14} /> 全库表体积总计</Text>
            <Text strong style={{ fontSize: 24, fontFamily: 'monospace', lineHeight: 1 }}>{formatBytes(totalDisk)}</Text>
            <Text type="secondary" style={{ fontSize: 12, marginTop: 6 }}>纯数据与索引体积</Text>
          </div>
          <div style={{ background: token.colorBgContainer, padding: '16px 20px', borderRadius: 12, border: `1px solid ${token.colorBorderSecondary}`, display: 'flex', flexDirection: 'column' }}>
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Eye size={14} color={nonInnodbCount > 0 ? token.colorWarning : token.colorSuccess} /> 架构健康度预警</Text>
            <Text strong style={{ fontSize: 24, lineHeight: 1, color: nonInnodbCount > 0 ? token.colorWarning : token.colorSuccess }}>{nonInnodbCount}</Text>
            <Text type="secondary" style={{ fontSize: 12, marginTop: 6 }}>非 InnoDB 引擎的表数量</Text>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', background: token.colorBgContainer, borderRadius: 12, border: `1px solid ${token.colorBorderSecondary}` }}>
        <Table
          dataSource={filtered}
          columns={catColumns}
          rowKey="name"
          size="small"
          pagination={filtered.length > 100 ? { pageSize: 100, showSizeChanger: true, showTotal: (t) => `共 ${t} 项` } : false}
          scroll={{ y: 'calc(100vh - 280px)' }}
          onRow={(record) => ({
            onClick: () => onSelectObject(record.name),
            style: { cursor: 'pointer' },
          })}
        />
      </div>
    </div>
  )
}

export const WorkbenchPage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()

  // --- Store（持久化状态，路由切换不丢失） ---
  const openConnections = useWorkbenchStore((s) => s.openConnections)
  const addOpenConnection = useWorkbenchStore((s) => s.addOpenConnection)
  const removeOpenConnection = useWorkbenchStore((s) => s.removeOpenConnection)

  const databasesMap = useWorkbenchStore((s) => s.databasesMap)
  const setDatabasesMap = useWorkbenchStore((s) => s.setDatabasesMap)
  const objectsMap = useWorkbenchStore((s) => s.objectsMap)
  const setObjectsMap = useWorkbenchStore((s) => s.setObjectsMap)
  const expandedKeys = useWorkbenchStore((s) => s.treeExpandedKeys)
  const setExpandedKeys = useWorkbenchStore((s) => s.setTreeExpandedKeys)
  const selectedCtx = useWorkbenchStore((s) => s.selectedCtx)
  const setSelectedCtx = useWorkbenchStore((s) => s.setSelectedCtx)

  const connections = useConnectionStore((s) => s.connections)
  const setConnections = useConnectionStore((s) => s.setConnections)
  const updateConnection = useConnectionStore((s) => s.updateConnection)

  // --- Local state（页面级临时状态）---
  const [loadingConns, setLoadingConns] = useState<Set<string>>(new Set())
  const [searchText, setSearchText] = useState('')
  const deferredSearch = useDeferredValue(searchText)

  // --- 树组件虚拟列表高度 ---
  const [treeHeight, setTreeHeight] = useState(600)
  const treeContainerRef = useRef<HTMLDivElement>(null)
  
  useLayoutEffect(() => {
    if (!treeContainerRef.current) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setTreeHeight(entry.contentRect.height)
      }
    })
    ro.observe(treeContainerRef.current)
    return () => ro.disconnect()
  }, [])

  // --- 多 Tab 状态（持久化到 Store，路由切换不丢失）---
  const openTableTabs = useWorkbenchStore((s) => s.openTableTabs)
  const setOpenTableTabs = useWorkbenchStore((s) => s.setOpenTableTabs)
  const activeTableTabKey = useWorkbenchStore((s) => s.activeTableTabKey)
  const setActiveTableTabKey = useWorkbenchStore((s) => s.setActiveTableTabKey)
  const batchUpdate = useWorkbenchStore((s) => s.batchUpdate)
  const activeTab = activeTableTabKey ? openTableTabs[activeTableTabKey] ?? null : null

  const setPendingSql = useSqlEditorStore((s) => s.setPendingSql)

  // --- 右键菜单状态（单个 Dropdown 代替 N 个）---
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeKey: string } | null>(null)
  // --- Tab 右键菜单 ---
  const [tabCtxMenu, setTabCtxMenu] = useState<{ x: number; y: number; tabKey: string } | null>(null)

  // --- 请求竞态控制 ---
  const loadSeqRef = useRef(0)

  // --- 新建数据库弹窗状态 ---
  const [createDbModal, setCreateDbModal] = useState<{ connectionId: string; connectionName: string } | null>(null)

  // --- 编辑数据库弹窗状态 ---
  const [editDbModal, setEditDbModal] = useState<{ connectionId: string; databaseName: string } | null>(null)

  // --- 新建/编辑表状态 ---
  const [createTableCtx, setCreateTableCtx] = useState<{ connectionId: string; connectionName: string; database: string; editTableName?: string } | null>(null)

  // --- SQL 文件导入弹窗状态 ---
  const [importSqlModal, setImportSqlModal] = useState<{ connectionId: string; connectionName: string; database: string } | null>(null)

  // --- 自动加载连接列表 ---
  useEffect(() => {
    if (connections.length === 0) {
      connectionApi.list().then((list) => {
        setConnections(list as ConnectionConfig[])
      }).catch(() => {})
    }
  }, [connections.length, setConnections])

  // --- 加载某个连接的数据库列表 ---
  // 确保连接已打开（自动重连）
  const ensureConnected = useCallback(async (connId: string): Promise<boolean> => {
    const conn = connections.find((c) => c.id === connId)
    if (!conn) return false
    if (conn.status === 'connected') return true
    try {
      const hide = toast.loading(`正在连接「${conn.name}」...`)
      await connectionApi.open(conn.id)
      updateConnection(conn.id, { status: 'connected' })
      hide()
      toast.success(`已连接到「${conn.name}」`)
      return true
    } catch (e) {
      handleApiError(e, '自动连接失败')
      return false
    }
  }, [connections, updateConnection])

  const loadDatabases = useCallback(async (connId: string) => {
    if (!(await ensureConnected(connId))) return
    setLoadingConns((prev) => new Set(prev).add(connId))
    try {
      const dbs = await metadataApi.databases(connId) as DatabaseInfo[]
      setDatabasesMap((prev) => ({ ...prev, [connId]: dbs }))
    } catch (e) {
      handleApiError(e, '加载数据库列表失败')
    } finally {
      setLoadingConns((prev) => {
        const next = new Set(prev)
        next.delete(connId)
        return next
      })
    }
  }, [ensureConnected, setDatabasesMap])

  // 当 openConnections 变化时，自动加载新增连接的数据库列表
  useEffect(() => {
    for (const conn of openConnections) {
      if (!databasesMap[conn.id]) {
        loadDatabases(conn.id)
      }
    }
  }, [openConnections, databasesMap, loadDatabases])

  // --- 加载某库下的对象列表 ---
  const loadTables = useCallback(async (connId: string, dbName: string) => {
    if (!(await ensureConnected(connId))) return
    const key = `${connId}::${dbName}`
    try {
      const tbls = await metadataApi.objects(connId, dbName) as TableInfo[]
      setObjectsMap((prev) => ({ ...prev, [key]: tbls }))
    } catch (e) {
      handleApiError(e, '加载对象列表失败')
    }
  }, [ensureConnected, setObjectsMap])

  // --- 多 Tab 数据加载（懒加载 + Tab 内独立缓存）---
  const updateTabState = useCallback((tabKey: string, updater: (prev: TableTabState) => Partial<TableTabState>) => {
    setOpenTableTabs(prev => {
      const tab = prev[tabKey]
      if (!tab || tab.type !== 'table') return prev
      return { ...prev, [tabKey]: { ...tab, ...updater(tab) } as TableTabState }
    })
  }, [setOpenTableTabs])

  const loadTabDataForTab = useCallback(async (tabKey: string, connId: string, dbName: string, tableName: string, tab: string) => {
    const seq = ++loadSeqRef.current
    try {
      // columns 始终加载
      const promises: Promise<void>[] = []
      // currentTab 可能为 undefined（新 Tab 刚创建，state 还未 commit）
      const currentTab = openTableTabs[tabKey]
      if (currentTab && currentTab.type !== 'table') return
      const tableTab = currentTab as TableTabState | undefined
      const needColumns = !tableTab?.loadedTabs.includes('columns')
      const needTab = tab !== 'columns' && !tableTab?.loadedTabs.includes(tab)
      if (!needColumns && !needTab) return
      if (needColumns) {
        promises.push(
          metadataApi.tableDefinition(connId, dbName, tableName).then((def: unknown) => {
            if (seq !== loadSeqRef.current) return
            updateTabState(tabKey, (prev) => ({
              columns: (def as { columns: ColumnInfo[] }).columns || [],
              loadedTabs: [...prev.loadedTabs, 'columns'],
            }))
          })
        )
      }
      if (needTab) {
        if (tab === 'preview') {
          promises.push(
            metadataApi.previewRows(connId, dbName, tableName).then((rows: unknown) => {
              if (seq !== loadSeqRef.current) return
              updateTabState(tabKey, (prev) => ({
                previewRows: rows as Record<string, unknown>[],
                loadedTabs: [...prev.loadedTabs, 'preview'],
              }))
            })
          )
        } else if (tab === 'indexes') {
          promises.push(
            metadataApi.indexes(connId, dbName, tableName).then((idxs: unknown) => {
              if (seq !== loadSeqRef.current) return
              updateTabState(tabKey, (prev) => ({
                indexes: idxs as IndexInfo[],
                loadedTabs: [...prev.loadedTabs, 'indexes'],
              }))
            })
          )
        } else if (tab === 'ddl') {
          promises.push(
            metadataApi.ddl(connId, dbName, tableName).then((ddlStr: unknown) => {
              if (seq !== loadSeqRef.current) return
              updateTabState(tabKey, (prev) => ({
                ddl: ddlStr as string,
                loadedTabs: [...prev.loadedTabs, 'ddl'],
              }))
            })
          )
        }
      }
      await Promise.all(promises)
    } catch (e) {
      if (seq !== loadSeqRef.current) return
      handleApiError(e, '加载表详情失败')
    }
  }, [openTableTabs, updateTabState])

  // 打开或激活一个表 Tab
  const openOrActivateTab = useCallback((connId: string, connName: string, dbName: string, tableName: string) => {
    const tabKey = `table:${connId}::${dbName}::${tableName}`
    const existing = openTableTabs[tabKey]
    if (!existing) {
      const newTab: TableTabState = {
        type: 'table',
        connectionId: connId,
        connectionName: connName,
        database: dbName,
        tableName,
        columns: [],
        indexes: [],
        ddl: '',
        previewRows: [],
        detailTab: 'preview',
        loadedTabs: [],
      }
      batchUpdate({
        openTableTabs: { ...openTableTabs, [tabKey]: newTab },
        activeTableTabKey: tabKey,
        selectedCtx: { connectionId: connId, database: dbName, table: tableName },
        activeConnectionId: connId,
        activeConnectionName: connName,
        activeDatabase: dbName,
        activeTable: tableName,
      })
      loadTabDataForTab(tabKey, connId, dbName, tableName, 'preview')
    } else {
      batchUpdate({
        activeTableTabKey: tabKey,
        selectedCtx: { connectionId: connId, database: dbName, table: tableName },
        activeConnectionId: connId,
        activeConnectionName: connName,
        activeDatabase: dbName,
        activeTable: tableName,
      })
    }
  }, [openTableTabs, batchUpdate, loadTabDataForTab])

  // 打开或激活数据库概览 Tab
  const openOrActivateDbOverview = useCallback((connId: string, connName: string, dbName: string) => {
    const tabKey = `db:${connId}::${dbName}`
    const existing = openTableTabs[tabKey]
    if (!existing) {
      batchUpdate({
        openTableTabs: {
          ...openTableTabs,
          [tabKey]: { type: 'db-overview' as const, connectionId: connId, connectionName: connName, database: dbName },
        },
        activeTableTabKey: tabKey,
        selectedCtx: { connectionId: connId, database: dbName },
        activeConnectionId: connId,
        activeConnectionName: connName,
        activeDatabase: dbName,
      })
    } else {
      batchUpdate({
        activeTableTabKey: tabKey,
        selectedCtx: { connectionId: connId, database: dbName },
        activeConnectionId: connId,
        activeConnectionName: connName,
        activeDatabase: dbName,
      })
    }
    loadTables(connId, dbName)
  }, [openTableTabs, batchUpdate, loadTables])

  // 打开或激活分类列表 Tab
  const openOrActivateCategoryTab = useCallback((connId: string, connName: string, dbName: string, catKey: string) => {
    const tabKey = `cat:${connId}::${dbName}::${catKey}`
    const existing = openTableTabs[tabKey]
    if (!existing) {
      batchUpdate({
        openTableTabs: {
          ...openTableTabs,
          [tabKey]: { type: 'category-list' as const, connectionId: connId, connectionName: connName, database: dbName, category: catKey },
        },
        activeTableTabKey: tabKey,
        selectedCtx: { connectionId: connId, database: dbName, category: catKey },
        activeConnectionId: connId,
        activeConnectionName: connName,
        activeDatabase: dbName,
      })
    } else {
      batchUpdate({
        activeTableTabKey: tabKey,
        selectedCtx: { connectionId: connId, database: dbName, category: catKey },
        activeConnectionId: connId,
        activeConnectionName: connName,
        activeDatabase: dbName,
      })
    }
    loadTables(connId, dbName)
  }, [openTableTabs, batchUpdate, loadTables])

  // 关闭一个表 Tab
  const closeTableTab = useCallback((tabKey: string) => {
    setOpenTableTabs(prev => {
      const next = { ...prev }
      delete next[tabKey]
      // 如果关闭的是当前活动 Tab，切换到另一个
      if (activeTableTabKey === tabKey) {
        const remaining = Object.keys(next)
        setActiveTableTabKey(remaining.length > 0 ? remaining[remaining.length - 1] : null)
      }
      return next
    })
  }, [activeTableTabKey, setOpenTableTabs, setActiveTableTabKey])

  // --- 添加连接到工作台 ---
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const handleAddConnection = useCallback(async (connId: string) => {
    const conn = connections.find((c) => c.id === connId)
    if (!conn) return

    // 未连接的自动连接
    if (conn.status !== 'connected') {
      setConnectingId(connId)
      const hide = toast.loading(`正在连接「${conn.name}」...`)
      try {
        await connectionApi.open(conn.id)
        updateConnection(conn.id, { status: 'connected' })
        hide()
        toast.success(`已连接到「${conn.name}」`)
      } catch (e) {
        hide()
        handleApiError(e, '连接失败')
        return
      } finally {
        setConnectingId(null)
      }
    }
    addOpenConnection(conn.id, conn.name)
  }, [connections, updateConnection, addOpenConnection])

  // --- 从工作台移除连接 ---
  const handleRemoveConnection = useCallback((connId: string) => {
    const wasCurrent = selectedCtx?.connectionId === connId
    removeOpenConnection(connId)
    // 清理该连接下的所有已打开 Tab
    setOpenTableTabs(prev => {
      const next = { ...prev }
      for (const key of Object.keys(next)) {
        if (key.startsWith(`${connId}::`)) delete next[key]
      }
      return next
    })
    if (wasCurrent) {
      setActiveTableTabKey(null)
    }
  }, [removeOpenConnection, selectedCtx, setActiveTableTabKey, setOpenTableTabs])

  // --- 打开 SQL 编辑器 ---
  const openSqlEditor = useCallback(() => {
    const connId = selectedCtx?.connectionId ?? undefined
    const db = selectedCtx?.database ?? undefined
    setPendingSql('', connId, db)
    navigate('/sql-editor')
  }, [selectedCtx, navigate, setPendingSql])

  // --- 对象分类 ---
  const objectCategories = useMemo(() => [
    { key: 'tables', label: '表', types: ['table'], icon: <Table2 size={16} /> },
    { key: 'views', label: '视图', types: ['view'], icon: <Eye size={16} /> },
    { key: 'triggers', label: '触发器', types: ['trigger'], icon: <Zap size={16} /> },
  ], [])
  // --- 高性能图标缓存 ---
  const iconTable = useMemo(() => <Table2 size={14} color={token.colorPrimary} />, [token.colorPrimary])
  const iconView = useMemo(() => <Eye size={14} color="#3B82F6" />, [])
  const iconTrigger = useMemo(() => <Zap size={14} color="#F59E0B" />, [])
  const iconDb = useMemo(() => <Database size={16} color={token.colorTextSecondary} />, [token.colorTextSecondary])
  const iconConn = useMemo(() => <Activity size={16} color={token.colorPrimary} />, [token.colorPrimary])

  // --- 构建多连接对象树 ---
  // key 编码规则：
  //   连接节点: "conn:{connId}"
  //   数据库节点: "db:{connId}:{dbName}"
  //   分类节点: "cat:{connId}:{dbName}:{catKey}"
  //   对象节点: "obj:{connId}:{dbName}:{objName}"

  // --- 解决切换工作台路由时的海量节点遍历卡顿 ---
  const [deferTree, setDeferTree] = useState(true)
  useEffect(() => {
    // 延迟 50ms 计算树，让页面骨架先秒切渲染，解决点击“工作台”即卡死的性能瓶颈
    const timer = setTimeout(() => setDeferTree(false), 50)
    return () => clearTimeout(timer)
  }, [])

  const treeData: DataNode[] = useMemo(() => {
    if (deferTree) return [] // 初次渲染不计算

    return openConnections.map((conn) => {
    const connDbs = databasesMap[conn.id] || []
    const isLoading = loadingConns.has(conn.id)

    const dbChildren: DataNode[] = connDbs
      .map((db) => {
        const objKey = `${conn.id}::${db.name}`
        const dbObjects = objectsMap[objKey] || []
        const lowerSearch = deferredSearch.toLowerCase()
        const dbNameMatches = !deferredSearch || db.name.toLowerCase().includes(lowerSearch)
        // 数据库内是否有匹配的对象
        const hasMatchingObjects = deferredSearch && dbObjects.some(
          (t) => t.name.toLowerCase().includes(lowerSearch)
        )

        // 数据库名不匹配且子对象也不匹配 → 过滤掉
        if (deferredSearch && !dbNameMatches && !hasMatchingObjects) return null

        const categoryChildren: DataNode[] = objectCategories
          .map((cat) => {
            const items = dbObjects.filter(
              (t) => cat.types.includes(t.type)
                && (!deferredSearch || dbNameMatches || t.name.toLowerCase().includes(lowerSearch))
            )
            return {
              key: `cat:${conn.id}:${db.name}:${cat.key}`,
              title: `${cat.label} (${items.length})`,
              icon: cat.icon,
              children: items.map((t) => ({
                key: `obj:${conn.id}:${db.name}:${t.name}`,
                title: t.name,
                icon: t.type === 'view' ? iconView : t.type === 'trigger' ? iconTrigger : iconTable,
                isLeaf: true,
              })),
            } as DataNode
          })
          .filter((cat) => !deferredSearch || (cat.children && cat.children.length > 0))

        return {
          key: `db:${conn.id}:${db.name}`,
          title: db.name,
          icon: iconDb,
          children: categoryChildren,
        } as DataNode
      })
      .filter(Boolean) as DataNode[]

    return {
      key: `conn:${conn.id}`,
      title: (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingRight: 4 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {conn.name}
          </span>
          <Tooltip title="从工作台移除">
            <CloseOutlined
              style={{ fontSize: 11, color: token.colorTextQuaternary, flexShrink: 0, marginLeft: 4 }}
              onClick={(e) => {
                e.stopPropagation()
                handleRemoveConnection(conn.id)
              }}
            />
          </Tooltip>
        </div>
      ),
      icon: iconConn,
      children: isLoading ? [{ key: `loading:${conn.id}`, title: '加载中...', isLeaf: true, selectable: false }] : dbChildren,
    } as DataNode
  })
  }, [deferTree, openConnections, databasesMap, objectsMap, loadingConns, deferredSearch, objectCategories, token, handleRemoveConnection, iconConn, iconDb, iconTable, iconTrigger, iconView])

  // --- 搜索时自动展开所有匹配的节点 ---
  const prevExpandedRef = useRef<React.Key[]>([])
  useEffect(() => {
    if (deferredSearch) {
      // 保存搜索前的展开状态
      if (prevExpandedRef.current.length === 0) {
        prevExpandedRef.current = [...expandedKeys]
      }
      // 展开所有有子节点的节点
      const allKeys: React.Key[] = []
      const collectKeys = (nodes: DataNode[]) => {
        for (const node of nodes) {
          if (node.children && node.children.length > 0) {
            allKeys.push(node.key)
            collectKeys(node.children)
          }
        }
      }
      collectKeys(treeData)
      setExpandedKeys(allKeys)
    } else if (prevExpandedRef.current.length > 0) {
      // 搜索清空时恢复之前的展开状态
      setExpandedKeys(prevExpandedRef.current)
      prevExpandedRef.current = []
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredSearch])

  // --- 树节点选中 ---
  const handleTreeSelect = (_: React.Key[], info: { node: DataNode }) => {
    const key = String(info.node.key)

    if (key.startsWith('conn:')) {
      const connId = key.slice(5)
      const conn = openConnections.find((c) => c.id === connId)
      batchUpdate({
        selectedCtx: { connectionId: connId },
        activeConnectionId: connId,
        activeConnectionName: conn?.name ?? null,
      })
    } else if (key.startsWith('db:')) {
      const parts = key.slice(3).split(':')
      const connId = parts[0]
      const dbName = parts.slice(1).join(':')
      const conn = openConnections.find((c) => c.id === connId)
      openOrActivateDbOverview(connId, conn?.name ?? '', dbName)
    } else if (key.startsWith('obj:')) {
      const parts = key.slice(4).split(':')
      const connId = parts[0]
      const dbName = parts[1]
      const objName = parts.slice(2).join(':')
      const conn = openConnections.find((c) => c.id === connId)
      const tabKey = `table:${connId}::${dbName}::${objName}`
      const hasTab = !!openTableTabs[tabKey]
      batchUpdate({
        selectedCtx: { connectionId: connId, database: dbName, table: objName },
        activeConnectionId: connId,
        activeConnectionName: conn?.name ?? null,
        activeDatabase: dbName,
        activeTable: objName,
        ...(hasTab ? { activeTableTabKey: tabKey } : {}),
      })
    } else if (key.startsWith('cat:')) {
      const parts = key.slice(4).split(':')
      const connId = parts[0]
      const dbName = parts[1]
      const catKey = parts.slice(2).join(':')
      const conn = openConnections.find((c) => c.id === connId)
      openOrActivateCategoryTab(connId, conn?.name ?? '', dbName, catKey)
    }
  }

  // --- 树节点展开 ---
  const handleTreeExpand = (keys: React.Key[], info: { node: DataNode; expanded: boolean }) => {
    setExpandedKeys(keys)
    const key = String(info.node.key)
    if (info.expanded) {
      if (key.startsWith('conn:')) {
        // 展开连接节点时加载数据库列表
        const connId = key.slice(5)
        if (!databasesMap[connId]) {
          loadDatabases(connId)
        }
      } else if (key.startsWith('db:')) {
        // 展开数据库节点时加载表列表
        const parts = key.slice(3).split(':')
        const connId = parts[0]
        const dbName = parts.slice(1).join(':')
        const objKey = `${connId}::${dbName}`
        if (!objectsMap[objKey]) {
          loadTables(connId, dbName)
        }
      }
    }
  }

  // --- 右键导出表数据 ---
  const handleTableExport = useCallback(async (
    connId: string, dbName: string, tableName: string, format: 'csv' | 'json' | 'sql',
  ) => {
    try {
      toast.info('正在获取数据...')
      const [def, rows] = await Promise.all([
        metadataApi.tableDefinition(connId, dbName, tableName) as Promise<{ columns: ColumnInfo[] }>,
        metadataApi.previewRows(connId, dbName, tableName) as Promise<Record<string, unknown>[]>,
      ])
      const colNames = (def.columns || []).map(c => c.name)
      exportTableData(tableName, colNames, rows, format)
      toast.success('导出成功')
    } catch (e) {
      handleApiError(e, '导出数据失败')
    }
  }, [])

  // --- 右键菜单 ---
  const getContextMenuItems = useCallback((nodeKey: string): MenuProps['items'] => {
    // 连接节点：新建数据库 / 刷新
    if (nodeKey.startsWith('conn:')) {
      const connId = nodeKey.slice(5)
      const conn = openConnections.find((c) => c.id === connId)
      return [
        {
          key: 'create-db',
          icon: <PlusOutlined />,
          label: '新建数据库',
          onClick: () => setCreateDbModal({ connectionId: connId, connectionName: conn?.name ?? '' }),
        },
        {
          key: 'refresh-conn',
          icon: <ReloadOutlined />,
          label: '刷新',
          onClick: () => loadDatabases(connId),
        },
      ]
    }
    // 数据库节点：刷新 / 删除数据库
    if (nodeKey.startsWith('db:')) {
      const parts = nodeKey.slice(3).split(':')
      const connId = parts[0]
      const dbName = parts.slice(1).join(':')
      return [
        {
          key: 'edit-db',
          icon: <EditOutlined />,
          label: '编辑数据库',
          onClick: () => setEditDbModal({ connectionId: connId, databaseName: dbName }),
        },
        {
          key: 'refresh-db',
          icon: <ReloadOutlined />,
          label: '刷新',
          onClick: () => loadTables(connId, dbName),
        },
        { type: 'divider' },
        {
          key: 'import-sql',
          icon: <UploadOutlined />,
          label: '执行 SQL 文件',
          onClick: () => {
            const conn = openConnections.find((c) => c.id === connId)
            setImportSqlModal({ connectionId: connId, connectionName: conn?.name ?? '', database: dbName })
          },
        },
        { type: 'divider' },
        {
          key: 'drop-db',
          icon: <DeleteOutlined />,
          label: '删除数据库',
          danger: true,
          onClick: () => {
            Modal.confirm({
              title: `确认删除数据库「${dbName}」？`,
              content: '此操作不可恢复，数据库中的所有数据将被永久删除。',
              okText: '删除',
              okType: 'danger',
              cancelText: '取消',
              onOk: async () => {
                try {
                  await metadataApi.dropDatabase(connId, dbName)
                  toast.success(`数据库「${dbName}」已删除`)
                  loadDatabases(connId)
                  if (selectedCtx?.connectionId === connId && selectedCtx?.database === dbName) {
                    setSelectedCtx({ connectionId: connId })
                  }
                } catch (e) {
                  handleApiError(e, '删除数据库失败')
                }
              },
            })
          },
        },
      ]
    }
    // 分类节点（表/视图/触发器）
    if (nodeKey.startsWith('cat:')) {
      const parts = nodeKey.slice(4).split(':')
      const connId = parts[0]
      const dbName = parts[1]
      const catKey = parts.slice(2).join(':')
      const items: MenuProps['items'] = []
      if (catKey === 'tables') {
        items.push({
          key: 'create-table',
          icon: <PlusOutlined />,
          label: '新建表',
          onClick: () => {
            const conn = openConnections.find((c) => c.id === connId)
            setCreateTableCtx({ connectionId: connId, connectionName: conn?.name ?? '', database: dbName })
          },
        })
      }
      items.push({
        key: 'refresh-cat',
        icon: <ReloadOutlined />,
        label: '刷新',
        onClick: () => loadTables(connId, dbName),
      })
      return items
    }
    // 表/对象节点：删除表 / 清空表
    if (nodeKey.startsWith('obj:')) {
      const parts = nodeKey.slice(4).split(':')
      const connId = parts[0]
      const dbName = parts[1]
      const objName = parts.slice(2).join(':')
      return [
        {
          key: 'design-table',
          icon: <EditOutlined />,
          label: '设计表',
          onClick: () => {
            const conn = openConnections.find((c) => c.id === connId)
            setCreateTableCtx({ connectionId: connId, connectionName: conn?.name ?? '', database: dbName, editTableName: objName })
          },
        },
        {
          key: 'rename-table',
          icon: <EditOutlined />,
          label: '重命名',
          onClick: () => {
            let newName = objName
            Modal.confirm({
              title: `重命名表「${objName}」`,
              content: (
                <Input
                  defaultValue={objName}
                  onChange={(e) => { newName = e.target.value }}
                  style={{ marginTop: 8 }}
                  autoFocus
                />
              ),
              okText: '确定',
              cancelText: '取消',
              onOk: async () => {
                if (!newName.trim() || newName === objName) return
                try {
                  await metadataApi.renameTable(connId, dbName, objName, newName)
                  toast.success(`表已重命名为「${newName}」`)
                  loadTables(connId, dbName)
                  if (selectedCtx?.table === objName) {
                    setSelectedCtx({ connectionId: connId, database: dbName, table: newName })
                  }
                } catch (e) {
                  handleApiError(e, '重命名表失败')
                }
              },
            })
          },
        },
        {
          key: 'export-csv',
          icon: <DownloadOutlined />,
          label: '导出为 CSV',
          onClick: () => handleTableExport(connId, dbName, objName, 'csv'),
        },
        {
          key: 'export-json',
          icon: <DownloadOutlined />,
          label: '导出为 JSON',
          onClick: () => handleTableExport(connId, dbName, objName, 'json'),
        },
        {
          key: 'export-sql',
          icon: <DownloadOutlined />,
          label: '导出为 SQL INSERT',
          onClick: () => handleTableExport(connId, dbName, objName, 'sql'),
        },
        { type: 'divider' },
        {
          key: 'truncate-table',
          icon: <DeleteOutlined />,
          label: '清空表',
          onClick: () => {
            Modal.confirm({
              title: `确认清空表「${objName}」？`,
              content: '此操作将删除表中所有数据，但保留表结构。操作不可恢复。',
              okText: '清空',
              okType: 'danger',
              cancelText: '取消',
              onOk: async () => {
                try {
                  await metadataApi.truncateTable(connId, dbName, objName)
                  toast.success(`表「${objName}」已清空`)
                } catch (e) {
                  handleApiError(e, '清空表失败')
                }
              },
            })
          },
        },
        { type: 'divider' },
        {
          key: 'drop-table',
          icon: <DeleteOutlined />,
          label: '删除表',
          danger: true,
          onClick: () => {
            Modal.confirm({
              title: `确认删除表「${objName}」？`,
              content: '此操作将永久删除该表及其所有数据，不可恢复。',
              okText: '删除',
              okType: 'danger',
              cancelText: '取消',
              onOk: async () => {
                try {
                  await metadataApi.dropTable(connId, dbName, objName)
                  toast.success(`表「${objName}」已删除`)
                  loadTables(connId, dbName)
                  if (selectedCtx?.connectionId === connId && selectedCtx?.database === dbName && selectedCtx?.table === objName) {
                    setSelectedCtx({ connectionId: connId, database: dbName })
                  }
                } catch (e) {
                  handleApiError(e, '删除表失败')
                }
              },
            })
          },
        },
      ]
    }
    return []
  }, [openConnections, loadDatabases, loadTables, selectedCtx, setSelectedCtx, handleTableExport, setCreateDbModal, setEditDbModal, setImportSqlModal, setCreateTableCtx])

  // ctxMenuItems 缓存（必须在 getContextMenuItems 之后）
  const ctxMenuItems = useMemo(() => ctxMenu ? getContextMenuItems(ctxMenu.nodeKey) : [], [ctxMenu, getContextMenuItems])

  // 可添加的连接列表（排除已在工作台中的）
  const availableConnections = connections.filter(
    (c) => !openConnections.some((o) => o.id === c.id)
  )

  // --- 表结构列定义 ---
  const columnTableColumns = [
    { title: '字段名', dataIndex: 'name', key: 'name', width: 160 },
    { title: '类型', dataIndex: 'type', key: 'type', width: 140 },
    {
      title: '可空',
      dataIndex: 'nullable',
      key: 'nullable',
      width: 60,
      render: (v: boolean) => v ? '是' : '否',
    },
    { title: '默认值', dataIndex: 'defaultValue', key: 'defaultValue', width: 120 },
    {
      title: '主键',
      dataIndex: 'isPrimaryKey',
      key: 'isPrimaryKey',
      width: 60,
      render: (v: boolean) => v ? <Tag color="gold">PK</Tag> : null,
    },
    { title: '备注', dataIndex: 'comment', key: 'comment' },
  ]

  // 索引列定义
  const indexTableColumns = [
    { title: '索引名', dataIndex: 'name', key: 'name', width: 200 },
    {
      title: '字段',
      dataIndex: 'columns',
      key: 'columns',
      render: (cols: string[]) => cols.join(', '),
    },
    {
      title: '唯一',
      dataIndex: 'isUnique',
      key: 'isUnique',
      width: 60,
      render: (v: boolean) => v ? '是' : '否',
    },
    {
      title: '主键',
      dataIndex: 'isPrimary',
      key: 'isPrimary',
      width: 60,
      render: (v: boolean) => v ? <Tag color="gold">PK</Tag> : null,
    },
  ]

  // 当前选中节点的 tree key
  const selectedTreeKeys: React.Key[] = selectedCtx
    ? (selectedCtx.table && selectedCtx.database
      ? [`obj:${selectedCtx.connectionId}:${selectedCtx.database}:${selectedCtx.table}`]
      : selectedCtx.category && selectedCtx.database
        ? [`cat:${selectedCtx.connectionId}:${selectedCtx.database}:${selectedCtx.category}`]
        : selectedCtx.database
          ? [`db:${selectedCtx.connectionId}:${selectedCtx.database}`]
          : [`conn:${selectedCtx.connectionId}`]
    )
    : []

  return (
    <Layout style={{ height: '100%' }}>
      {/* 左侧对象树 */}
      <Sider
        width={280}
        style={{
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <style>{`
          .workbench-object-tree .ant-tree-node-content-wrapper.ant-tree-node-selected {
            background: ${token.colorPrimaryBg};
            color: ${token.colorPrimary};
          }
          .workbench-object-tree .ant-tree-title {
            display: inline-block;
            vertical-align: middle;
            max-width: calc(100% - 24px);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .workbench-object-tree .ant-tree-node-content-wrapper {
            display: inline-flex;
            align-items: center;
            width: 100%;
            overflow: hidden;
          }
        `}</style>
        {/* --- 极致优化的侧边栏微型头部 --- */}
        <div style={{ padding: '12px 14px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: token.colorTextQuaternary, letterSpacing: 0.5 }}>
            DATABASES
          </span>
          <Space size={2}>
            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              menu={{
                items: availableConnections.length > 0
                  ? availableConnections.map((c) => ({
                      key: c.id,
                      label: (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minWidth: 160 }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                          {c.status !== 'connected' && (
                            <span style={{ fontSize: 11, color: token.colorTextQuaternary, marginLeft: 8, flexShrink: 0 }}>未连接</span>
                          )}
                        </div>
                      ),
                      onClick: () => handleAddConnection(c.id),
                    }))
                  : [{ key: 'empty', label: <span style={{ color: token.colorTextQuaternary }}>全体连接已载入</span>, disabled: true }],
              }}
            >
              <Tooltip title="接入数据库" placement="bottom">
                <Button loading={!!connectingId} type="text" size="small" icon={!connectingId && <Plus size={14} />} style={{ width: 24, height: 24, padding: 0, color: token.colorTextSecondary }} />
              </Tooltip>
            </Dropdown>
          </Space>
        </div>
        
        {/* --- 无感下沉搜索框 --- */}
        <div style={{ padding: '0 12px 8px' }}>
          <Input
            placeholder="在此过滤表或数据库..."
            prefix={<Search size={14} color={token.colorTextQuaternary} style={{ marginRight: 4 }} />}
            variant="filled"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            style={{ borderRadius: 6, fontSize: 12, padding: '4px 10px' }}
          />
        </div>
        <div ref={treeContainerRef} style={{ flex: 1, overflow: 'hidden' }}>
          {openConnections.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center' }}>
              <Text type="secondary" style={{ fontSize: 13 }}>
                从上方下拉框添加连接
              </Text>
            </div>
          ) : (
            <>
              <Tree
                height={treeHeight}
                className="workbench-object-tree"
                treeData={treeData}
                showIcon
                blockNode
                titleRender={
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (nodeData: any) => {
                  if (nodeData.isLeaf && String(nodeData.key).startsWith('obj:')) {
                    return (
                      <Tooltip title={String(nodeData.title)} mouseEnterDelay={0.5} placement="right">
                        <span>{nodeData.title as React.ReactNode}</span>
                      </Tooltip>
                    )
                  }
                  return nodeData.title as React.ReactNode
                }}
                onSelect={handleTreeSelect}
                selectedKeys={selectedTreeKeys}
                expandedKeys={expandedKeys}
                onExpand={handleTreeExpand}
                onDoubleClick={(_e, node) => {
                  const key = String(node.key)
                  if (key.startsWith('obj:')) {
                    const parts = key.slice(4).split(':')
                    const connId = parts[0]
                    const dbName = parts[1]
                    const objName = parts.slice(2).join(':')
                    const conn = openConnections.find((c) => c.id === connId)
                    openOrActivateTab(connId, conn?.name ?? '', dbName, objName)
                  }
                }}
                onRightClick={({ event, node }) => {
                  event.preventDefault()
                  event.stopPropagation()
                  const key = String(node.key)
                  const nativeEvent = event as unknown as ReactMouseEvent
                  setCtxMenu({ x: nativeEvent.clientX, y: nativeEvent.clientY, nodeKey: key })
                }}
              />
              {ctxMenu && ctxMenuItems && ctxMenuItems.length > 0 && (
                <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 999 }}
                    onClick={() => setCtxMenu(null)}
                    onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}
                  />
                  <div style={{
                    position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 1000,
                    background: token.colorBgElevated, borderRadius: token.borderRadius,
                    boxShadow: token.boxShadowSecondary, padding: '4px 0', minWidth: 160,
                  }}>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {ctxMenuItems.map((item: any, i: number) => {
                      if (!item) return null
                      if (item.type === 'divider') return <div key={`d${i}`} style={{ height: 1, background: token.colorBorderSecondary, margin: '4px 0' }} />
                      return (
                        <div
                          key={item.key}
                          style={{
                            padding: '5px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                            color: item.danger ? token.colorError : token.colorText, fontSize: 13,
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = token.colorBgTextHover }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                          onClick={() => { item.onClick?.(); setCtxMenu(null) }}
                        >
                          {item.icon}
                          <span>{item.label}</span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>
        </div>
      </Sider>

      {/* 右侧详情区 */}
      <Content style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: token.colorBgLayout }}>
        {createTableCtx ? (
          <TableDesigner
            connectionId={createTableCtx.connectionId}
            connectionName={createTableCtx.connectionName}
            database={createTableCtx.database}
            editTableName={createTableCtx.editTableName}
            onSuccess={() => {
              loadTables(createTableCtx.connectionId, createTableCtx.database)
              setCreateTableCtx(null)
            }}
            onCancel={() => setCreateTableCtx(null)}
          />
        ) : activeTableTabKey && openTableTabs[activeTableTabKey] ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <style>{`
              .workbench-detail-tabs.ant-tabs {
                height: 100%;
                min-height: 0;
              }
              .workbench-detail-tabs .ant-tabs-content-holder {
                flex: 1;
                min-height: 0;
                overflow: hidden;
              }
              .workbench-detail-tabs .ant-tabs-content {
                height: 100%;
                min-height: 0;
              }
              .workbench-detail-tabs .ant-tabs-tabpane,
              .workbench-detail-tabs .ant-tabs-tabpane-active {
                height: 100%;
                min-height: 0;
                overflow: hidden;
              }
              /* Pro-Max Borderless Geeky Tabs */
              .workbench-main-tabs.ant-tabs-card > .ant-tabs-nav {
                margin: 0 !important;
                background: ${token.colorBgContainer};
              }
              .workbench-main-tabs.ant-tabs-card > .ant-tabs-nav::before {
                border-bottom: 1px solid ${token.colorBorderSecondary} !important;
              }
              .workbench-main-tabs.ant-tabs-card > .ant-tabs-nav .ant-tabs-tab {
                border: none !important;
                background: transparent !important;
                border-radius: 0 !important;
                padding: 8px 16px !important;
                margin: 0 !important;
                border-bottom: 2px solid transparent !important;
                transition: all 0.2s;
              }
              .workbench-main-tabs.ant-tabs-card > .ant-tabs-nav .ant-tabs-tab-active {
                background: ${token.colorBgElevated} !important;
                border-bottom: 2px solid ${token.colorPrimary} !important;
              }
              .workbench-main-tabs .ant-tabs-tab-remove {
                opacity: 0;
                transition: opacity 0.2s;
                margin-left: 8px !important;
              }
              .workbench-main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove,
              .workbench-main-tabs .ant-tabs-tab:hover .ant-tabs-tab-remove {
                opacity: 1;
              }
            `}</style>
            {/* 表 Tab 栏 */}
            {(() => {
              const tabKeys = Object.keys(openTableTabs)
              return (
                <>
                  <Tabs
                    className="workbench-main-tabs"
                    type="editable-card"
                    size="small"
                    hideAdd
                    activeKey={activeTableTabKey ?? undefined}
                    onChange={(key) => {
                      const tab = openTableTabs[key]
                      if (tab) {
                        batchUpdate({
                          activeTableTabKey: key,
                          selectedCtx: tab.type === 'table'
                            ? { connectionId: tab.connectionId, database: tab.database, table: tab.tableName }
                            : tab.type === 'category-list'
                              ? { connectionId: tab.connectionId, database: tab.database, category: tab.category }
                              : { connectionId: tab.connectionId, database: tab.database },
                          activeConnectionId: tab.connectionId,
                          activeConnectionName: tab.connectionName,
                          activeDatabase: tab.database,
                          activeTable: tab.type === 'table' ? tab.tableName : null,
                        })
                      } else {
                        setActiveTableTabKey(key)
                      }
                    }}
                    onEdit={(targetKey, action) => {
                      if (action === 'remove' && typeof targetKey === 'string') {
                        closeTableTab(targetKey)
                      }
                    }}
                    style={{ flexShrink: 0, padding: '0 16px' }}
                    tabBarStyle={{ marginBottom: 0 }}
                    items={tabKeys.map((key) => {
                      const tab = openTableTabs[key]
                      const tabLabel = tab.type === 'table'
                        ? tab.tableName
                        : tab.type === 'db-overview'
                          ? tab.database
                          : tab.type === 'category-list'
                            ? `${tab.database} / ${tab.category === 'tables' ? '表' : tab.category === 'views' ? '视图' : tab.category === 'triggers' ? '触发器' : tab.category}`
                            : ''
                      const tabIcon = tab.type === 'table'
                        ? <Table2 size={14} style={{ marginRight: 6 }} />
                        : tab.type === 'db-overview'
                          ? <Database size={14} style={{ marginRight: 6 }} />
                          : <Table2 size={14} style={{ marginRight: 6 }} />
                      const tabTitle = tab.type === 'table'
                        ? `${tab.database}.${tab.tableName}`
                        : tab.database
                      return {
                        key,
                        label: (
                          <span
                            title={tabTitle}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setTabCtxMenu({ x: e.clientX, y: e.clientY, tabKey: key })
                            }}
                          >
                            {tabIcon}{tabLabel}
                          </span>
                        ),
                        closable: true,
                      }
                    })}
                  />
                  {/* Tab 右键菜单 */}
                  {tabCtxMenu && (
                    <>
                      <div
                        style={{ position: 'fixed', inset: 0, zIndex: 999 }}
                        onClick={() => setTabCtxMenu(null)}
                        onContextMenu={(e) => { e.preventDefault(); setTabCtxMenu(null) }}
                      />
                      <div style={{
                        position: 'fixed', left: tabCtxMenu.x, top: tabCtxMenu.y, zIndex: 1000,
                        background: token.colorBgElevated, borderRadius: token.borderRadius,
                        boxShadow: token.boxShadowSecondary, padding: '4px 0', minWidth: 140,
                      }}>
                        {[
                          { label: '关闭', onClick: () => closeTableTab(tabCtxMenu.tabKey) },
                          { label: '关闭其他', onClick: () => {
                            setOpenTableTabs(prev => {
                              const keep = prev[tabCtxMenu.tabKey]
                              return keep ? { [tabCtxMenu.tabKey]: keep } : {}
                            })
                            setActiveTableTabKey(tabCtxMenu.tabKey)
                          }},
                          { label: '关闭左侧', onClick: () => {
                            const idx = tabKeys.indexOf(tabCtxMenu.tabKey)
                            const toRemove = new Set(tabKeys.slice(0, idx))
                            setOpenTableTabs(prev => {
                              const next = { ...prev }
                              for (const k of toRemove) delete next[k]
                              return next
                            })
                            if (activeTableTabKey && toRemove.has(activeTableTabKey)) setActiveTableTabKey(tabCtxMenu.tabKey)
                          }},
                          { label: '关闭右侧', onClick: () => {
                            const idx = tabKeys.indexOf(tabCtxMenu.tabKey)
                            const toRemove = new Set(tabKeys.slice(idx + 1))
                            setOpenTableTabs(prev => {
                              const next = { ...prev }
                              for (const k of toRemove) delete next[k]
                              return next
                            })
                            if (activeTableTabKey && toRemove.has(activeTableTabKey)) setActiveTableTabKey(tabCtxMenu.tabKey)
                          }},
                          { label: '关闭全部', onClick: () => {
                            setOpenTableTabs({})
                            setActiveTableTabKey(null)
                          }},
                        ].map((item) => (
                          <div
                            key={item.label}
                            style={{ padding: '5px 12px', cursor: 'pointer', fontSize: 13, color: token.colorText }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = token.colorBgTextHover }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                            onClick={() => { item.onClick(); setTabCtxMenu(null) }}
                          >
                            {item.label}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )
            })()}
            {/* 当前活动 Tab 的详情内容 */}
            {/* Tab 内容区域 — 根据 Tab 类型渲染 */}
            {activeTab && (() => {
              const tabKey = activeTableTabKey!

              // ===== 表详情 Tab =====
              if (activeTab.type === 'table') {
                const t = activeTab
                return (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    {/* 面包屑 */}
                    <div style={{ padding: '8px 16px 0 16px', flexShrink: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <Space>
                          <Breadcrumb
                            separator="/"
                            items={[
                              {
                                title: (
                                  <span style={{ cursor: 'pointer', color: token.colorTextSecondary }} onClick={() => openOrActivateDbOverview(t.connectionId, t.connectionName, t.database)}>
                                    <DatabaseOutlined style={{ marginRight: 4 }} />{t.database}
                                  </span>
                                ),
                              },
                              {
                                title: <Text strong style={{ fontSize: 13 }}>{t.tableName}</Text>,
                              },
                            ]}
                          />
                        </Space>
                        <Space size={8}>
                          <Text type="secondary" style={{ fontSize: 12 }}>({t.connectionName})</Text>
                          <Button size="small" icon={<CodeOutlined />} onClick={() => openSqlEditor()}>打开 SQL 编辑器</Button>
                        </Space>
                      </div>
                    </div>
                    {/* 详情 Tabs */}
                    <Tabs
                      className="workbench-detail-tabs"
                      size="small"
                      activeKey={t.detailTab}
                      onChange={(key) => {
                        updateTabState(tabKey, () => ({ detailTab: key }))
                        loadTabDataForTab(tabKey, t.connectionId, t.database, t.tableName, key)
                      }}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 16px' }}
                      tabBarStyle={{ flexShrink: 0, marginBottom: 0 }}
                      items={[
                        {
                          key: 'preview',
                          label: `数据预览${t.previewRows.length > 0 ? ` (${t.previewRows.length})` : ''}`,
                          children: (
                            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8, padding: '0 2px', flexShrink: 0 }}>
                                <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
                                  {t.columns.length > 0 && t.columns.some((c: ColumnInfo) => c.isPrimaryKey)
                                    ? `可编辑 · 主键：${t.columns.filter((c: ColumnInfo) => c.isPrimaryKey).map((c: ColumnInfo) => c.name).join(', ')}`
                                    : '当前表无主键，数据编辑功能不可用'}
                                </Text>
                                <Space size={8}>
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {t.previewRows.length > 0 ? `共 ${t.previewRows.length} 行` : ''}
                                  </Text>
                                  {t.previewRows.length > 0 && (
                                    <Dropdown menu={{
                                      items: [
                                        { key: 'csv', label: '导出为 CSV', onClick: () => exportTableData(t.tableName, t.columns.map((c: ColumnInfo) => c.name), t.previewRows, 'csv') },
                                        { key: 'json', label: '导出为 JSON', onClick: () => exportTableData(t.tableName, t.columns.map((c: ColumnInfo) => c.name), t.previewRows, 'json') },
                                        { key: 'sql', label: '导出为 SQL INSERT', onClick: () => exportTableData(t.tableName, t.columns.map((c: ColumnInfo) => c.name), t.previewRows, 'sql') },
                                      ],
                                    }}>
                                      <Button size="small" icon={<DownloadOutlined />}>导出</Button>
                                    </Dropdown>
                                  )}
                                </Space>
                              </div>
                              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                                <EditableDataTable
                                  connectionId={t.connectionId}
                                  database={t.database}
                                  tableName={t.tableName}
                                  columns={t.columns}
                                  dataSource={t.previewRows}
                                  onRefresh={() => {
                                    updateTabState(tabKey, (prev) => ({
                                      loadedTabs: prev.loadedTabs.filter(k => k !== 'preview' && k !== 'columns'),
                                    }))
                                    loadTabDataForTab(tabKey, t.connectionId, t.database, t.tableName, 'preview')
                                  }}
                                  onFilter={async (params) => {
                                    try {
                                      const rows = await metadataApi.previewRows(
                                        t.connectionId, t.database, t.tableName, params
                                      ) as Record<string, unknown>[]
                                      updateTabState(tabKey, () => ({
                                        previewRows: rows,
                                      }))
                                    } catch (e) {
                                      handleApiError(e, '筛选数据失败')
                                    }
                                  }}
                                />
                              </div>
                            </div>
                          ),
                        },
                        {
                          key: 'columns',
                          label: '字段结构',
                          children: (
                            <div style={{ overflow: 'auto', height: '100%', minHeight: 0 }}>
                              <Table columns={columnTableColumns} dataSource={t.columns} rowKey="name" pagination={false} size="small" />
                            </div>
                          ),
                        },
                        {
                          key: 'indexes',
                          label: '索引',
                          children: (
                            <div style={{ overflow: 'auto', height: '100%', minHeight: 0 }}>
                              <Table columns={indexTableColumns} dataSource={t.indexes} rowKey="name" pagination={false} size="small" />
                            </div>
                          ),
                        },
                        {
                          key: 'ddl',
                          label: 'DDL',
                          children: (
                            <pre style={{
                              background: '#1e1e1e', color: '#d4d4d4', padding: 16, borderRadius: token.borderRadius,
                              fontSize: 12, fontFamily: 'Menlo, Monaco, monospace', overflow: 'auto', height: '100%',
                            }}>
                              {t.ddl || '无 DDL 数据'}
                            </pre>
                          ),
                        },
                      ]}
                    />
                  </div>
                )
              }

              // ===== 数据库概览 Tab =====
              if (activeTab.type === 'db-overview') {
                const objKey = `${activeTab.connectionId}::${activeTab.database}`
                const dbObjects = objectsMap[objKey] || []
                return (
                  <div style={{ flex: 1, padding: '32px 40px', overflow: 'auto', background: token.colorBgBase }}>
                    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
                      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div>
                          <Text strong style={{ fontSize: 24, display: 'flex', alignItems: 'center', gap: 10, color: token.colorText }}>
                            <Database size={24} color={token.colorPrimary} />
                            {activeTab.database}
                          </Text>
                          <Text type="secondary" style={{ fontSize: 13, marginTop: 4, display: 'block' }}>连接网络: {activeTab.connectionName}</Text>
                        </div>
                        <Button type="primary" size="large" icon={<CodeOutlined />} onClick={() => openSqlEditor()} style={{ background: token.colorPrimary, border: 'none', boxShadow: '0 0 15px rgba(34,197,94,0.3)', borderRadius: 8 }}>
                          新建查询 Workspace
                        </Button>
                      </div>

                      {/* Bento Grid */}
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(12, 1fr)',
                        gap: 16,
                        gridAutoRows: 'minmax(120px, auto)'
                      }}>
                        {/* Box 1: Tables Count */}
                        <div style={{ gridColumn: 'span 4', background: token.colorBgContainer, borderRadius: 12, padding: 20, border: `1px solid ${token.colorBorderSecondary}`, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
                          <Table2 size={20} color={token.colorPrimary} style={{ marginBottom: 12 }} />
                          <Text type="secondary" style={{ fontSize: 13, marginBottom: 4 }}>数据表总数</Text>
                          <Text strong style={{ fontSize: 32, lineHeight: 1 }}>{dbObjects.filter((t) => t.type === 'table').length}</Text>
                          <div style={{ position: 'absolute', right: -15, bottom: -15, opacity: 0.03 }}>
                            <Table2 size={120} />
                          </div>
                        </div>

                        {/* Box 2: Views & Triggers */}
                        <div style={{ gridColumn: 'span 4', display: 'flex', flexDirection: 'column', gap: 16 }}>
                          <div style={{ flex: 1, background: token.colorBgContainer, borderRadius: 12, padding: '16px 20px', border: `1px solid ${token.colorBorderSecondary}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 2 }}>视图分类</Text>
                              <Text strong style={{ fontSize: 20 }}>{dbObjects.filter((t) => t.type === 'view').length}</Text>
                            </div>
                            <div style={{ width: 40, height: 40, borderRadius: 8, background: 'rgba(59,130,246,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <Eye size={20} color="#3B82F6" />
                            </div>
                          </div>
                          <div style={{ flex: 1, background: token.colorBgContainer, borderRadius: 12, padding: '16px 20px', border: `1px solid ${token.colorBorderSecondary}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 2 }}>系统触发器</Text>
                              <Text strong style={{ fontSize: 20 }}>{dbObjects.filter((t) => t.type === 'trigger').length}</Text>
                            </div>
                            <div style={{ width: 40, height: 40, borderRadius: 8, background: 'rgba(245,158,11,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <Zap size={20} color="#F59E0B" />
                            </div>
                          </div>
                        </div>

                        {/* Box 3: Quick Actions */}
                        <div style={{ gridColumn: 'span 4', background: token.colorBgContainer, borderRadius: 12, padding: 20, border: `1px solid ${token.colorBorderSecondary}` }}>
                          <Text strong style={{ fontSize: 14, marginBottom: 16, display: 'flex', alignItems: 'center' }}>
                            <Activity size={16} style={{ marginRight: 6 }} />
                            快捷面板
                          </Text>
                          <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <Button block style={{ textAlign: 'left', background: token.colorBgElevated, border: 'none', color: token.colorTextSecondary }} icon={<ReloadOutlined />} onClick={() => loadTables(activeTab.connectionId, activeTab.database)}>
                              重新加载对象树
                            </Button>
                            <Button block style={{ textAlign: 'left', background: token.colorBgElevated, border: 'none', color: token.colorTextSecondary }} icon={<PlusOutlined />} onClick={() => setCreateTableCtx({ connectionId: activeTab.connectionId, connectionName: activeTab.connectionName, database: activeTab.database })}>
                              进入可视化表设计器
                            </Button>
                          </Space>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              }

              // ===== 分类列表 Tab =====
              if (activeTab.type === 'category-list') {
                return (
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <CategoryListView
                      connectionId={activeTab.connectionId}
                      database={activeTab.database}
                      category={activeTab.category}
                      objects={objectsMap[`${activeTab.connectionId}::${activeTab.database}`] || []}
                      objectCategories={objectCategories}
                      search={activeTab.categorySearch || ''}
                      onSearchChange={(value) => {
                        const key = activeTableTabKey!
                        setOpenTableTabs((prev) => ({
                          ...prev,
                          [key]: { ...prev[key], categorySearch: value } as WorkbenchTab,
                        }))
                      }}
                      onSelectObject={(name) => {
                        openOrActivateTab(activeTab.connectionId, activeTab.connectionName, activeTab.database, name)
                      }}
                    />
                  </div>
                )
              }

              return null
            })()}
          </div>
        ) : (
          <EmptyState description={openConnections.length === 0 ? '从左侧添加连接开始浏览' : '选择左侧对象树中的数据库或表以查看详情'} />
        )}
      </Content>

      {/* 新建数据库弹窗 */}
      {createDbModal && (
        <CreateDatabaseModal
          open={!!createDbModal}
          connectionId={createDbModal.connectionId}
          connectionName={createDbModal.connectionName}
          onClose={() => setCreateDbModal(null)}
          onSuccess={() => loadDatabases(createDbModal.connectionId)}
        />
      )}

      {/* 编辑数据库弹窗 */}
      {editDbModal && (
        <EditDatabaseModal
          open={!!editDbModal}
          connectionId={editDbModal.connectionId}
          databaseName={editDbModal.databaseName}
          onClose={() => setEditDbModal(null)}
          onSuccess={() => loadDatabases(editDbModal.connectionId)}
        />
      )}

      {/* SQL 文件导入弹窗 */}
      {importSqlModal && (
        <ImportSqlDialog
          open={!!importSqlModal}
          connectionId={importSqlModal.connectionId}
          connectionName={importSqlModal.connectionName}
          database={importSqlModal.database}
          databases={(databasesMap[importSqlModal.connectionId] || []).map(d => d.name)}
          onClose={() => setImportSqlModal(null)}
        />
      )}
    </Layout>
  )
}
