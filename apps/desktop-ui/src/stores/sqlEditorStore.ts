import { create } from 'zustand'

/**
 * SQL 编辑器跨页面状态
 * 用于从其他页面（如结构对比）向 SQL 编辑器传递待执行的 SQL
 */
interface SqlEditorState {
  /** 待注入的 SQL（由其他页面设置，编辑器消费后清空） */
  pendingSql: string | null
  /** 待注入的目标连接 ID */
  pendingConnectionId: string | null
  /** 待注入的目标数据库 */
  pendingDatabase: string | null

  /** 设置待注入的 SQL */
  setPendingSql: (sql: string, connectionId?: string, database?: string) => void
  /** 消费并清空待注入的 SQL */
  consumePendingSql: () => { sql: string; connectionId?: string; database?: string } | null
}

export const useSqlEditorStore = create<SqlEditorState>((set, get) => ({
  pendingSql: null,
  pendingConnectionId: null,
  pendingDatabase: null,

  setPendingSql: (sql, connectionId, database) =>
    set({ pendingSql: sql, pendingConnectionId: connectionId ?? null, pendingDatabase: database ?? null }),

  consumePendingSql: () => {
    const { pendingSql, pendingConnectionId, pendingDatabase } = get()
    if (!pendingSql) return null
    set({ pendingSql: null, pendingConnectionId: null, pendingDatabase: null })
    return {
      sql: pendingSql,
      ...(pendingConnectionId && { connectionId: pendingConnectionId }),
      ...(pendingDatabase && { database: pendingDatabase }),
    }
  },
}))
