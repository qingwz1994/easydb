import { create } from 'zustand'

/**
 * 工作台上下文 Store
 * 跟踪当前连接、当前数据库、当前选中对象等全局上下文，
 * 供工作台、SQL 编辑器、迁移、同步等页面共享。
 *
 * - openConnections: 工作台中同时打开的多个连接（多连接并行浏览）
 * - activeConnectionId: 当前聚焦的连接（用于 SQL 编辑器等页面的默认上下文）
 */

interface OpenConnection {
  id: string
  name: string
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
  /** 侧栏是否折叠 */
  siderCollapsed: boolean

  /** 添加连接到工作台树 */
  addOpenConnection: (id: string, name: string) => void
  /** 从工作台树移除连接 */
  removeOpenConnection: (id: string) => void
  /** 设置当前聚焦连接（同时加入 openConnections） */
  setActiveConnection: (id: string | null, name?: string | null) => void
  setActiveDatabase: (db: string | null) => void
  setActiveTable: (table: string | null) => void
  setSiderCollapsed: (collapsed: boolean) => void
  clearContext: () => void
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  openConnections: [],
  activeConnectionId: null,
  activeConnectionName: null,
  activeDatabase: null,
  activeTable: null,
  siderCollapsed: false,

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
      return {
        openConnections: newList,
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
      // 如果设为 null，清空上下文
      if (!id) {
        return {
          activeConnectionId: null,
          activeConnectionName: null,
          activeDatabase: null,
          activeTable: null,
        }
      }
      // 同时确保在 openConnections 中
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
    }),
}))
