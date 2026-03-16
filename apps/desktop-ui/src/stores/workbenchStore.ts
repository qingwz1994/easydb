import { create } from 'zustand'

/**
 * 工作台上下文 Store
 * 跟踪当前连接、当前数据库、当前选中对象等全局上下文，
 * 供工作台、SQL 编辑器、迁移、同步等页面共享。
 */
interface WorkbenchState {
  /** 当前活跃连接 ID */
  activeConnectionId: string | null
  /** 当前活跃连接名称 */
  activeConnectionName: string | null
  /** 当前选中数据库 */
  activeDatabase: string | null
  /** 当前选中表 */
  activeTable: string | null
  /** 侧栏是否折叠 */
  siderCollapsed: boolean

  setActiveConnection: (id: string | null, name?: string | null) => void
  setActiveDatabase: (db: string | null) => void
  setActiveTable: (table: string | null) => void
  setSiderCollapsed: (collapsed: boolean) => void
  clearContext: () => void
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  activeConnectionId: null,
  activeConnectionName: null,
  activeDatabase: null,
  activeTable: null,
  siderCollapsed: false,

  setActiveConnection: (id, name = null) =>
    set({
      activeConnectionId: id,
      activeConnectionName: name,
      activeDatabase: null,
      activeTable: null,
    }),

  setActiveDatabase: (db) =>
    set({ activeDatabase: db, activeTable: null }),

  setActiveTable: (table) =>
    set({ activeTable: table }),

  setSiderCollapsed: (collapsed) =>
    set({ siderCollapsed: collapsed }),

  clearContext: () =>
    set({
      activeConnectionId: null,
      activeConnectionName: null,
      activeDatabase: null,
      activeTable: null,
    }),
}))
