import { message, notification } from 'antd'

/**
 * 全局通知工具
 * 统一封装 Antd message 和 notification，
 * 避免在组件中直接调用 message.xxx()
 */

/** 轻量提示（顶部消息条） */
export const toast = {
  success: (content: string) => message.success(content),
  error: (content: string) => message.error(content),
  warning: (content: string) => message.warning(content),
  info: (content: string) => message.info(content),
  loading: (content: string) => message.loading(content),
}

/** 重要通知（右侧通知卡片） */
export const notify = {
  success: (title: string, description?: string) =>
    notification.success({ message: title, description }),

  error: (title: string, description?: string) =>
    notification.error({ message: title, description, duration: 0 }),

  warning: (title: string, description?: string) =>
    notification.warning({ message: title, description }),

  info: (title: string, description?: string) =>
    notification.info({ message: title, description }),
}

/**
 * API 错误统一处理
 * 在 services/api.ts 的 catch 中使用
 */
export function handleApiError(error: unknown, fallbackMessage = '操作失败') {
  const msg = error instanceof Error ? error.message : fallbackMessage
  toast.error(msg)
}
