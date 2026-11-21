import { i18n } from '@/i18n'

export interface ApiErrorLike extends Error { status?: number; code?: string; params?: Record<string, unknown> }

const codeToKey: Record<string, string> = {
  REQUEST_FAILED: 'errors.requestFailed',
  NETWORK_ERROR: 'errors.network',
  AUTH_REQUIRED: 'errors.loginRequired',
}

export function apiErrorMessage(error: unknown, fallbackKey = 'errors.requestFailed') {
  const value = error as Partial<ApiErrorLike> | null
  if (value?.code && codeToKey[value.code]) return i18n.global.t(codeToKey[value.code], value.params ?? {})
  if (value?.message) return value.message
  return i18n.global.t(fallbackKey)
}
