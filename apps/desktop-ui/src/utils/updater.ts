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
const GITHUB_OWNER = 'qingwz1994'
const GITHUB_REPO = 'easydb'
const SETTINGS_KEY = 'easydb_auto_check_update'

// 当前版本（构建时从 tauri.conf.json 注入）
export const APP_VERSION = __APP_VERSION__ ?? '1.2.0'

export interface UpdateInfo {
  hasUpdate: boolean
  latestVersion: string
  currentVersion: string
  downloadUrl: string
  releaseNotes: string
  publishedAt: string
}

/** 比较版本号：1.2.0 < 1.2.1 */
function compareVersions(current: string, latest: string): number {
  const a = current.replace(/^v/, '').split('.').map(Number)
  const b = latest.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] || 0) - (a[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 检查 GitHub Releases 是否有新版本（仓库公开后可用） */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    { headers: { Accept: 'application/vnd.github.v3+json' } }
  )
  if (!resp.ok) {
    throw new Error(`检查更新失败: ${resp.status}`)
  }
  const release = await resp.json()
  const latestVersion = (release.tag_name || '').replace(/^v/, '')
  const hasUpdate = compareVersions(APP_VERSION, latestVersion) > 0

  return {
    hasUpdate,
    latestVersion,
    currentVersion: APP_VERSION,
    downloadUrl: release.html_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    releaseNotes: release.body || '',
    publishedAt: release.published_at || '',
  }
}

/** 读取「自动检查更新」设置 */
export function getAutoCheckEnabled(): boolean {
  const val = localStorage.getItem(SETTINGS_KEY)
  return val === null ? true : val === 'true'
}

/** 保存「自动检查更新」设置 */
export function setAutoCheckEnabled(enabled: boolean): void {
  localStorage.setItem(SETTINGS_KEY, String(enabled))
}
