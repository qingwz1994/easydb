export function formatDateTime(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/**
 * 格式化时长（毫秒 → 可读文本）
 * 850 → "850毫秒"
 * 3200 → "3秒"
 * 125000 → "2分5秒"
 * 3725000 → "1小时2分"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}毫秒`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  const remainSec = seconds % 60
  if (minutes < 60) {
    return remainSec > 0 ? `${minutes}分${remainSec}秒` : `${minutes}分`
  }
  const hours = Math.floor(minutes / 60)
  const remainMin = minutes % 60
  return remainMin > 0 ? `${hours}小时${remainMin}分` : `${hours}小时`
}

/**
 * 计算从 startedAt 到现在的实时耗时
 */
export function getElapsedMs(startedAt: string): number {
  return Date.now() - new Date(startedAt).getTime()
}

