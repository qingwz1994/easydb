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

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'easydb-theme'

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? getSystemTheme() : mode
}

function loadThemeMode(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
  return saved ?? 'dark'
}

interface ThemeState {
  themeMode: ThemeMode
  effectiveTheme: 'light' | 'dark'
  setThemeMode: (mode: ThemeMode) => void
}

export const useThemeStore = create<ThemeState>((set) => {
  const initial = loadThemeMode()

  // 监听系统主题变化
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    set((state) => {
      if (state.themeMode === 'system') {
        const effective = getSystemTheme()
        document.documentElement.setAttribute('data-theme', effective)
        return { effectiveTheme: effective }
      }
      return {}
    })
  })

  // 初始化时设置 data-theme
  const effective = getEffectiveTheme(initial)
  document.documentElement.setAttribute('data-theme', effective)

  return {
    themeMode: initial,
    effectiveTheme: effective,
    setThemeMode: (mode: ThemeMode) => {
      localStorage.setItem(STORAGE_KEY, mode)
      const effective = getEffectiveTheme(mode)
      document.documentElement.setAttribute('data-theme', effective)
      set({ themeMode: mode, effectiveTheme: effective })
    },
  }
})
