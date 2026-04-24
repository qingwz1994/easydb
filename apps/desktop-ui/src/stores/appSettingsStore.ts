/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
import { create } from 'zustand'

const KEY_SQL_HISTORY_ENABLED       = 'easydb-sql-history-enabled'
const KEY_SQL_HISTORY_FILTER_BY_DB  = 'easydb-sql-history-filter-by-db'

function loadBool(key: string, defaultValue: boolean): boolean {
  const v = localStorage.getItem(key)
  if (v === null) return defaultValue
  return v === 'true'
}

interface AppSettingsState {
  /** 是否启用 SQL 历史记录功能（默认开启） */
  sqlHistoryEnabled: boolean
  /** 历史是否按当前数据库过滤，关闭时展示该连接全部数据库的历史（默认开启，即按库隔离） */
  sqlHistoryFilterByDatabase: boolean

  setSqlHistoryEnabled: (v: boolean) => void
  setSqlHistoryFilterByDatabase: (v: boolean) => void
}

export const useAppSettingsStore = create<AppSettingsState>((set) => ({
  sqlHistoryEnabled:          loadBool(KEY_SQL_HISTORY_ENABLED,      true),
  sqlHistoryFilterByDatabase: loadBool(KEY_SQL_HISTORY_FILTER_BY_DB, true),

  setSqlHistoryEnabled: (v) => {
    localStorage.setItem(KEY_SQL_HISTORY_ENABLED, String(v))
    set({ sqlHistoryEnabled: v })
  },
  setSqlHistoryFilterByDatabase: (v) => {
    localStorage.setItem(KEY_SQL_HISTORY_FILTER_BY_DB, String(v))
    set({ sqlHistoryFilterByDatabase: v })
  },
}))
