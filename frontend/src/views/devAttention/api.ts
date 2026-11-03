import type { AttentionDefaults, AttentionInput, AttentionResult } from './scoring'

const baseUrl = import.meta.env.VITE_API_URL ?? '/api/v1'
function csrfHeaders(): Record<string, string> {
  const prefix = 'gugu_user_csrf_token='
  const cookie = document.cookie.split('; ').find((item) => item.startsWith(prefix))
  return cookie ? { 'X-CSRF-Token': decodeURIComponent(cookie.slice(prefix.length)) } : {}
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/dev/attention/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...csrfHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    let detail = ''
    try {
      const value = await response.json() as { detail?: unknown }
      if (typeof value.detail === 'string') detail = value.detail
    } catch { /* 以 HTTP 状态码作为可见错误 */ }
    throw new Error(detail || `HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export const attentionSandboxApi = {
  defaults: () => request<AttentionDefaults>('defaults'),
  score: (payload: AttentionInput) => request<AttentionResult>('score', payload),
}
