import type { CliResult } from './client.js'

const errors: Record<number, string> = {
  400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden',
  404: 'not_found', 409: 'conflict', 422: 'invalid_request',
}

export function createDesktopClient(port: string, token: string) {
  const url = new URL('http://127.0.0.1:' + port)
  if (!/^\d+$/.test(port) || Number(port) < 1024 || !/^[A-Za-z0-9_-]{32,}$/.test(token))
    throw new Error('服务地址或访问令牌无效')

  return async (path: string, method = 'GET', fields?: Record<string, unknown>): Promise<CliResult<unknown>> => {
    try {
      const response = await fetch(new URL('/api/v1/' + path, url), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: 'Bearer ' + token,
          ...(fields ? { 'Content-Type': 'application/json' } : {}),
        },
        body: fields ? JSON.stringify(fields) : undefined,
      })
      if (!response.ok) {
        return { version: 1, ok: false, data: null, error: {
          code: errors[response.status] ?? (method !== 'GET' && response.status >= 500 ? 'result_unknown' : 'request_failed'),
          message: '桌面请求返回 HTTP ' + response.status,
        } }
      }
      const data: unknown = response.status === 204 ? null : await response.json()
      return { version: 1, ok: true, data, error: null }
    } catch {
      return { version: 1, ok: false, data: null, error: {
        code: method === 'GET' ? 'request_failed' : 'result_unknown',
        message: method === 'GET' ? '无法读取请求结果' : '写入结果未确认，请先查询状态',
      } }
    }
  }
}
