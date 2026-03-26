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
import { create } from 'zustand'
import type { DatabaseInfo, TableInfo, ColumnInfo, IndexInfo } from '@/types'

/**
 * 工作台上下文 Store
 * 跟踪当前连接、当前数据库、当前选中对象等全局上下文，
 * 供工作台、SQL 编辑器、迁移、同步等页面共享。
 *
 * 状态全部存在 Zustand 中，路由切换不会丢失。
 */

interface OpenConnection {
  id: string
  name: string
}

/** 表详情 Tab 状态 */
export interface TableTabState {
  type: 'table'
  connectionId: string
  connectionName: string
  database: string
  tableName: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  ddl: string
  previewRows: Record<string, unknown>[]
  detailTab: string
  loadedTabs: string[]
}

/** 数据库概览 Tab 状态 */
export interface DbOverviewTabState {
  type: 'db-overview'
  connectionId: string
  connectionName: string
  database: string
}

/** 分类列表 Tab 状态 */
export interface CategoryListTabState {
  type: 'category-list'
  connectionId: string
  connectionName: string
  database: string
  category: string // 'tables' | 'views' | 'triggers'
  categorySearch?: string
}

/** 工作台 Tab 联合类型 */
export type WorkbenchTab = TableTabState | DbOverviewTabState | CategoryListTabState

/** 当前选中的上下文 */
export interface SelectedContext {
  connectionId: string
  database?: string
  table?: string
  /** 选中分类节点时标识：tables / views / triggers */
  category?: string
}

interface WorkbenchState {
  /** 工作台中打开的连接列表（多连接并行） */
  openConnections: OpenConnection[]
  /** 当前活跃连接 ID（最近聚焦的连接） */
  activeConnectionId: string | null
  /** 当前活跃连接名称 */
  activeConnectionName: string | null
  /** 当前选中数据库 */
  activeDatabase: string | null
  /** 当前选中表 */
  activeTable: string | null
  /** 已打开的 Tab（表详情 / 数据库概览 / 分类列表） */
  openTableTabs: Record<string, WorkbenchTab>
  /** 当前活跃的 Tab key */
  activeTableTabKey: string | null
  /** 侧栏是否折叠 */
  siderCollapsed: boolean

  // --- 对象树持久化状态 ---
  /** 对象树展开的 key */
  treeExpandedKeys: React.Key[]
  /** per-connection 数据库列表缓存 */
  databasesMap: Record<string, DatabaseInfo[]>
  /** per-connection+db 对象列表缓存: "connId::dbName" → TableInfo[] */
  objectsMap: Record<string, TableInfo[]>
  /** 当前选中节点上下文 */
  selectedCtx: SelectedContext | null

  // --- 操作方法 ---
  addOpenConnection: (id: string, name: string) => void
  removeOpenConnection: (id: string) => void
  setActiveConnection: (id: string | null, name?: string | null) => void
  setActiveDatabase: (db: string | null) => void
  setActiveTable: (table: string | null) => void
  setSiderCollapsed: (collapsed: boolean) => void
  clearContext: () => void
  setOpenTableTabs: (updater: Record<string, WorkbenchTab> | ((prev: Record<string, WorkbenchTab>) => Record<string, WorkbenchTab>)) => void
  setActiveTableTabKey: (key: string | null) => void
  /** 原子批量更新 — 一次 set 合并多个字段变更，减少重渲染 */
  batchUpdate: (partial: Partial<Pick<WorkbenchState,
    'activeConnectionId' | 'activeConnectionName' | 'activeDatabase' | 'activeTable' |
    'selectedCtx' | 'activeTableTabKey' | 'openTableTabs'
  >>) => void

  // --- 对象树操作 ---
  setTreeExpandedKeys: (keys: React.Key[]) => void
  setDatabasesMap: (updater: Record<string, DatabaseInfo[]> | ((prev: Record<string, DatabaseInfo[]>) => Record<string, DatabaseInfo[]>)) => void
  setObjectsMap: (updater: Record<string, TableInfo[]> | ((prev: Record<string, TableInfo[]>) => Record<string, TableInfo[]>)) => void
  setSelectedCtx: (ctx: SelectedContext | null) => void
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  openConnections: [],
  activeConnectionId: null,
  activeConnectionName: null,
  activeDatabase: null,
  activeTable: null,
  openTableTabs: {},
  activeTableTabKey: null,
  siderCollapsed: false,

  // 对象树持久化状态初始值
  treeExpandedKeys: [],
  databasesMap: {},
  objectsMap: {},
  selectedCtx: null,

  addOpenConnection: (id, name) =>
    set((state) => {
      if (state.openConnections.some((c) => c.id === id)) return state
      return {
        openConnections: [...state.openConnections, { id, name }],
        activeConnectionId: id,
        activeConnectionName: name,
      }
    }),

  removeOpenConnection: (id) =>
    set((state) => {
      const newList = state.openConnections.filter((c) => c.id !== id)
      const wasActive = state.activeConnectionId === id
      // 清理该连接的缓存
      const newDbMap = { ...state.databasesMap }
      delete newDbMap[id]
      const newObjMap = { ...state.objectsMap }
      for (const k of Object.keys(newObjMap)) {
        if (k.startsWith(`${id}::`)) delete newObjMap[k]
      }
      // 清理该连接下的 Tab
      const newTabs = { ...state.openTableTabs }
      for (const k of Object.keys(newTabs)) {
        if (k.includes(id)) delete newTabs[k]
      }
      const activeTabCleared = state.activeTableTabKey?.includes(id)
      const newExpandedKeys = state.treeExpandedKeys.filter(
        (k) => !String(k).includes(id)
      )
      const clearSelected = state.selectedCtx?.connectionId === id
      return {
        openConnections: newList,
        databasesMap: newDbMap,
        objectsMap: newObjMap,
        openTableTabs: newTabs,
        treeExpandedKeys: newExpandedKeys,
        ...(clearSelected ? { selectedCtx: null } : {}),
        ...(activeTabCleared ? { activeTableTabKey: null } : {}),
        ...(wasActive
          ? {
              activeConnectionId: newList.length > 0 ? newList[newList.length - 1].id : null,
              activeConnectionName: newList.length > 0 ? newList[newList.length - 1].name : null,
              activeDatabase: null,
              activeTable: null,
            }
          : {}),
      }
    }),

  setActiveConnection: (id, name = null) =>
    set((state) => {
      if (!id) {
        return {
          activeConnectionId: null,
          activeConnectionName: null,
          activeDatabase: null,
          activeTable: null,
        }
      }
      const alreadyOpen = state.openConnections.some((c) => c.id === id)
      return {
        activeConnectionId: id,
        activeConnectionName: name,
        activeDatabase: null,
        activeTable: null,
        ...(alreadyOpen
          ? {}
          : { openConnections: [...state.openConnections, { id, name: name ?? id }] }),
      }
    }),

  setActiveDatabase: (db) =>
    set({ activeDatabase: db, activeTable: null }),

  setActiveTable: (table) =>
    set({ activeTable: table }),

  setSiderCollapsed: (collapsed) =>
    set({ siderCollapsed: collapsed }),

  clearContext: () =>
    set({
      openConnections: [],
      activeConnectionId: null,
      activeConnectionName: null,
      activeDatabase: null,
      activeTable: null,
      openTableTabs: {},
      activeTableTabKey: null,
      treeExpandedKeys: [],
      databasesMap: {},
      objectsMap: {},
      selectedCtx: null,
    }),

  // --- 对象树操作 ---
  setTreeExpandedKeys: (keys) =>
    set({ treeExpandedKeys: keys }),

  setDatabasesMap: (updater) =>
    set((state) => ({
      databasesMap: typeof updater === 'function' ? updater(state.databasesMap) : updater,
    })),

  setObjectsMap: (updater) =>
    set((state) => ({
      objectsMap: typeof updater === 'function' ? updater(state.objectsMap) : updater,
    })),

  setSelectedCtx: (ctx) =>
    set({ selectedCtx: ctx }),

  setOpenTableTabs: (updater) =>
    set((state) => ({
      openTableTabs: typeof updater === 'function' ? updater(state.openTableTabs) : updater,
    })),

  setActiveTableTabKey: (key) =>
    set({ activeTableTabKey: key }),

  batchUpdate: (partial) =>
    set(partial),
}))
