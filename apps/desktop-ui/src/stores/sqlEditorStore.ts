import { create } from 'zustand'
import type { SqlResult } from '@/types'

/**
 * SQL 编辑器 Store
 * - tabs / activeTabKey: 标签页状态持久化，路由切换不丢失
 * - pendingSql: 从其他页面向编辑器传递 SQL 的机制
 */

export interface EditorTab {
  key: string
  title: string
  sql: string
  connectionId?: string
  database?: string
  results: SqlResult[]
  currentBatch: SqlResult[]
  resultTab: string
}

interface SqlEditorState {
  /** 编辑器标签页 */
  tabs: EditorTab[]
  /** 当前活跃标签页 key */
  activeTabKey: string
  /** 标签页计数器 */
  tabCounter: number

  /** 待注入的 SQL（由其他页面设置，编辑器消费后清空） */
  pendingSql: string | null
  pendingConnectionId: string | null
  pendingDatabase: string | null

  // --- 标签页操作 ---
  addTab: (connectionId?: string, database?: string) => string
  removeTab: (key: string) => void
  updateTab: (key: string, updates: Partial<EditorTab>) => void
  setActiveTabKey: (key: string) => void

  // --- pending SQL ---
  setPendingSql: (sql: string, connectionId?: string, database?: string) => void
  consumePendingSql: () => { sql: string; connectionId?: string; database?: string } | null
}

export const useSqlEditorStore = create<SqlEditorState>((set, get) => ({
  tabs: [],
  activeTabKey: '',
  tabCounter: 0,

  pendingSql: null,
  pendingConnectionId: null,
  pendingDatabase: null,

  addTab: (connectionId, database) => {
    const { tabCounter, tabs, activeTabKey } = get()
    // 所有 tab 关闭后重新从 1 开始编号
    const baseCounter = tabs.length === 0 ? 0 : tabCounter
    const newCounter = baseCounter + 1
    const newKey = `tab-${newCounter}`
    // 继承当前 tab 的连接上下文（如果未指定）
    const currentTab = tabs.find((t) => t.key === activeTabKey) || tabs[0]
    set({
      tabCounter: newCounter,
      activeTabKey: newKey,
      tabs: [...tabs, {
        key: newKey,
        title: `SQL ${newCounter}`,
        sql: '',
        connectionId: connectionId ?? currentTab?.connectionId,
        database: database ?? currentTab?.database,
        results: [],
        currentBatch: [],
        resultTab: 'result-0',
      }],
    })
    return newKey
  },

  removeTab: (key) =>
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.key !== key)
      return {
        tabs: newTabs,
        ...(state.activeTabKey === key
          ? { activeTabKey: newTabs.length > 0 ? newTabs[newTabs.length - 1].key : '' }
          : {}),
      }
    }),

  updateTab: (key, updates) =>
    set((state) => ({
      tabs: state.tabs.map((t) => t.key === key ? { ...t, ...updates } : t),
    })),

  setActiveTabKey: (key) =>
    set({ activeTabKey: key }),

  setPendingSql: (sql, connectionId, database) =>
    set({
      pendingSql: sql,
      pendingConnectionId: connectionId ?? null,
      pendingDatabase: database ?? null,
    }),

  consumePendingSql: () => {
    const { pendingSql, pendingConnectionId, pendingDatabase } = get()
    if (pendingSql === null) return null
    set({ pendingSql: null, pendingConnectionId: null, pendingDatabase: null })
    return {
      sql: pendingSql,
      ...(pendingConnectionId && { connectionId: pendingConnectionId }),
      ...(pendingDatabase && { database: pendingDatabase }),
    }
  },
}))
