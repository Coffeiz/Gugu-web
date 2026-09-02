import { readonly, ref } from 'vue'
import { i18n } from '@/i18n'

export type AppToastKind = 'error' | 'success' | 'info'

interface AppToastOptions {
  duration?: number
  kind?: AppToastKind
}

interface AppToast {
  id: number
  message: string
  kind: AppToastKind
}

const currentToast = ref<AppToast | null>(null)
let toastId = 0
let dismissTimer: ReturnType<typeof setTimeout> | null = null

function clearToastTimer() {
  if (dismissTimer) clearTimeout(dismissTimer)
  dismissTimer = null
}

export function dismissAppToast() {
  clearToastTimer()
  currentToast.value = null
}

export function showAppToast(message: string, options: AppToastOptions = {}) {
  clearToastTimer()
  currentToast.value = {
    id: ++toastId,
    message,
    kind: options.kind ?? 'info',
  }
  dismissTimer = setTimeout(dismissAppToast, options.duration ?? 3200)
}

export function showAppError(message: string, duration?: number) {
  showAppToast(message, { kind: 'error', duration })
}

export function showAppSuccess(message: string, duration?: number) {
  showAppToast(message, { kind: 'success', duration })
}

/** 所有面板共用的普通操作提示，视觉与错误提示保持同一套弹层规格。 */
export function showAppNotice(message: string, duration?: number) {
  showAppToast(message, { kind: 'info', duration })
}

export function errorMessage(error: unknown, fallback = i18n.global.t('errors.requestFailed')) {
  return error instanceof Error && error.message ? error.message : fallback
}

export function useAppToast() {
  return {
    currentToast: readonly(currentToast),
    dismissAppToast,
    showAppError,
    showAppNotice,
    showAppSuccess,
    showAppToast,
  }
}
