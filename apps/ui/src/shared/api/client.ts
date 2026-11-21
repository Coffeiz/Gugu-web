/**
 * 咕咕 API 传输客户端。
 * 统一处理 Cookie 会话、CSRF、请求去重和错误映射。
 */
import { i18n } from '@/i18n'
import { getInteractionClientId } from '@/interaction/sync/InteractionSyncState'
import { handleUnauthorized, isUnauthorizedResponse } from '@/services/authSession'

export const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

export function getCookieValue(name: string): string {
  if (typeof document === 'undefined') return ''
  const prefix = `${encodeURIComponent(name)}=`
  const item = document.cookie.split('; ').find(value => value.startsWith(prefix))
  return item ? decodeURIComponent(item.slice(prefix.length)) : ''
}

export function getCsrfHeaders(cookieName = 'gugu_user_csrf_token'): Record<string, string> {
  const token = getCookieValue(cookieName)
  return token ? { 'X-CSRF-Token': token } : {}
}

// 本标签页的 client-id：每次写操作作为 X-Client-Id 头发给后端，后端把它塞进 SSE 事件的 origin。
// 前端收到「origin === 自己」的回声时跳过重拉（本页已乐观更新过），只让别的标签页/端刷新。
// 每标签页独立并在 sessionStorage 中保持；刷新同一 Tab 不会改变来源身份。
export const CLIENT_ID: string = getInteractionClientId()

const UNDO_CONTEXT_STORAGE_KEY = 'gugu.undo.context-id'

function getUndoContextId(): string {
  if (typeof window === 'undefined') return `undo-${CLIENT_ID}`
  try {
    const existing = window.sessionStorage.getItem(UNDO_CONTEXT_STORAGE_KEY)
    if (existing) return existing
    const value = `undo-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`
    window.sessionStorage.setItem(UNDO_CONTEXT_STORAGE_KEY, value)
    return value
  } catch {
    return `undo-${CLIENT_ID}`
  }
}

export const UNDO_CONTEXT_ID = getUndoContextId()

export interface RequestMeta { mutationId?: string; undoGroupId?: string; headers?: Record<string, string> }

// 同一标签页中多个页面/全局组件可能在启动时同时读取同一资源。只合并进行中的
// GET；请求结束后立即移除，显式刷新仍会访问服务端。
const inFlightGetRequests = new Map<string, Promise<unknown>>()

export async function request<T = any>(method: string, path: string, body: any = null, isForm = false,
                                       signal?: AbortSignal, meta?: RequestMeta): Promise<T> {
  const sessionKey = getCookieValue('gugu_user_csrf_token')
  const canDeduplicate = method.toUpperCase() === 'GET' && !!sessionKey && !signal && !meta && body === null
  if (!canDeduplicate) return performRequest<T>(method, path, body, isForm, signal, meta)

  const key = JSON.stringify([sessionKey, path])
  const cloneResult = (value: T): T =>
    value === null || value === undefined || typeof value !== 'object' ? value : JSON.parse(JSON.stringify(value)) as T
  const existing = inFlightGetRequests.get(key)
  if (existing) return (existing as Promise<T>).then(cloneResult)

  const pending = performRequest<T>(method, path, body, isForm, signal, meta)
  inFlightGetRequests.set(key, pending)
  const clearPending = () => {
    if (inFlightGetRequests.get(key) === pending) inFlightGetRequests.delete(key)
  }
  void pending.then(clearPending, clearPending)
  return pending.then(cloneResult)
}

async function performRequest<T>(method: string, path: string, body: any, isForm: boolean,
                                 signal: AbortSignal | undefined, meta: RequestMeta | undefined): Promise<T> {
  const headers: Record<string, string> = {
    'X-Client-Id': CLIENT_ID,
    ...(['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
      ? {}
      : { ...getCsrfHeaders(), 'X-Undo-Context-ID': UNDO_CONTEXT_ID }),
  }
  if (meta?.mutationId) headers['X-Mutation-Id'] = meta.mutationId
  if (meta?.undoGroupId) headers['X-Undo-Group-ID'] = meta.undoGroupId
  if (meta?.headers) Object.assign(headers, meta.headers)

  const opts: RequestInit = { method, headers, signal, credentials: 'include' }
  if (body !== null) {
    if (isForm) {
      opts.body = body
    } else {
      headers['Content-Type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
  }

  const response = await fetch(`${BASE_URL}${path}`, opts)
  if (!response.ok) {
    if (isUnauthorizedResponse(response)) {
      throw new Error(i18n.global.t('errors.loginRequired'))
    }
    const error = await response.json().catch(() => ({}))
    const detail = error.detail
    const message = !detail ? i18n.global.t('errors.http', { status: response.status })
      : typeof detail === 'string' ? detail
      : Array.isArray(detail) ? detail.map((item: any) => item.msg ?? item).join('；')
      : typeof (detail as any).message === 'string' ? (detail as any).message
      : i18n.global.t('errors.http', { status: response.status })
    const apiError = new Error(message) as Error & { status?: number; code?: string; params?: Record<string, unknown> }
    apiError.status = response.status
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      if (typeof (detail as any).code === 'string') apiError.code = (detail as any).code
      if ((detail as any).params && typeof (detail as any).params === 'object') apiError.params = (detail as any).params
    }
    throw apiError
  }

  if (response.status === 204) return null as T
  return response.json()
}

export const get = <T = any>(path: string) => request<T>('GET', path)
export const post = <T = any>(path: string, body?: any, meta?: RequestMeta) => request<T>('POST', path, body, false, undefined, meta)
export const patch = <T = any>(path: string, body?: any, meta?: RequestMeta) => request<T>('PATCH', path, body, false, undefined, meta)
export const put = <T = any>(path: string, body?: any) => request<T>('PUT', path, body)
export const del = <T = any>(path: string, meta?: RequestMeta) => request<T>('DELETE', path, null, false, undefined, meta)
export const upload = <T = any>(path: string, form: FormData) => request<T>('POST', path, form, true)

export function uploadWithProgress(path: string, form: FormData, onProgress: (progress: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE_URL}${path}`)
    xhr.withCredentials = true
    xhr.setRequestHeader('X-Client-Id', CLIENT_ID)
    xhr.setRequestHeader('X-Undo-Context-ID', UNDO_CONTEXT_ID)
    const csrf = getCsrfHeaders()
    if (csrf['X-CSRF-Token']) xhr.setRequestHeader('X-CSRF-Token', csrf['X-CSRF-Token'])
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) } catch { resolve(null) }
      } else {
        if (xhr.status === 401) {
          handleUnauthorized('user')
          reject(new Error(i18n.global.t('errors.loginRequired')))
          return
        }
        try {
          const detail = JSON.parse(xhr.responseText).detail
          const message = !detail ? i18n.global.t('errors.http', { status: xhr.status })
            : typeof detail === 'string' ? detail
            : Array.isArray(detail) ? detail.map((item: any) => item.msg ?? item).join('；')
            : i18n.global.t('errors.http', { status: xhr.status })
          reject(new Error(message))
        } catch { reject(new Error(i18n.global.t('errors.http', { status: xhr.status }))) }
      }
    }
    xhr.onerror = () => reject(new Error(i18n.global.t('errors.network')))
    xhr.send(form)
  })
}
