import {
  remoteLoginInputSchema, remoteLoginResponseSchema, remoteSessionSchema, remoteUserSchema,
  type RemoteLoginInput, type RemoteSession, type RemoteUser,
} from './contracts.js'

export class RemoteAuthError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'unsupported' | 'invalid_credentials' | 'account_disabled'
      | 'rate_limited' | 'session_expired' | 'unavailable' | 'invalid_response',
    message: string,
  ) {
    super(message)
  }
}

export function remoteServerOrigin(server: string): string {
  let url: URL
  try { url = new URL(server.trim()) } catch {
    throw new RemoteAuthError('invalid_request', '请输入有效的服务器地址')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new RemoteAuthError('invalid_request', '请输入服务器根地址')
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin
  throw new RemoteAuthError('invalid_request', '远程服务器需要 HTTPS。本机回环地址可使用 HTTP')
}

async function readJson(response: Response, maxBytes = 128 * 1024): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new RemoteAuthError('invalid_response', '服务器返回了无效的登录数据')
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maxBytes) throw new RemoteAuthError('invalid_response', '服务器响应超过大小限制')
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  try { return JSON.parse(text + decoder.decode()) as unknown } catch {
    throw new RemoteAuthError('invalid_response', '服务器返回了无效的登录数据')
  }
}

export function createRemoteAuthClient(request: typeof fetch = fetch) {
  async function json(origin: string, path: 'login' | 'me', init: RequestInit = {}): Promise<unknown> {
    try {
      const response = await request(new URL('/api/v1/auth/' + path, origin), {
        ...init, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12_000),
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        if (response.status === 401 || response.status === 403) {
          if (path === 'me') throw new RemoteAuthError('session_expired', '远程会话已失效，请重新登录')
          if (response.status === 401) throw new RemoteAuthError('invalid_credentials', '账号或密码错误')
          throw new RemoteAuthError('account_disabled', '服务器拒绝登录，请检查账号状态')
        }
        if (response.status === 429) throw new RemoteAuthError('rate_limited', '登录尝试过多，请稍后再试')
        throw new RemoteAuthError('unavailable', '远程服务器暂不可用')
      }
      return await readJson(response)
    } catch (error) {
      if (error instanceof RemoteAuthError) throw error
      throw new RemoteAuthError('unavailable', '无法安全连接远程服务器，请检查地址和网络')
    }
  }

  async function restore(session: RemoteSession): Promise<RemoteUser> {
    const parsed = remoteSessionSchema.safeParse(session)
    if (!parsed.success || remoteServerOrigin(parsed.data.origin) !== parsed.data.origin)
      throw new RemoteAuthError('invalid_request', '远程会话格式无效')
    const response = await json(parsed.data.origin, 'me', {
      headers: { Authorization: 'Bearer ' + parsed.data.token },
    })
    const user = remoteUserSchema.safeParse(response)
    if (!user.success) throw new RemoteAuthError('invalid_response', '服务器返回了无效的账号资料')
    if (user.data.id !== parsed.data.accountId || !user.data.isActive)
      throw new RemoteAuthError('session_expired', '远程会话已失效，请重新登录')
    return user.data
  }

  return {
    async login(input: RemoteLoginInput, deviceId?: string): Promise<{ session: RemoteSession; user: RemoteUser }> {
      const parsed = remoteLoginInputSchema.safeParse(input)
      if (!parsed.success) throw new RemoteAuthError('invalid_request', '请填写服务器地址、账号和密码')
      const { provider, username, password, server } = parsed.data
      if (provider === 'official-saas' && !deviceId) throw new RemoteAuthError('invalid_request', '缺少本机设备标识')
      const origin = remoteServerOrigin(server)
      const body = await json(origin, 'login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Transport': 'bearer', ...(deviceId ? { 'X-Device-ID': deviceId } : {}) },
        body: JSON.stringify({ username, password, ...(provider === 'official-saas' ? { device_id: deviceId } : {}) }),
      })
      const result = remoteLoginResponseSchema.safeParse(body)
      if (!result.success || !result.data.access_token)
        throw new RemoteAuthError('invalid_response', '服务器未返回可用的登录会话')
      const session: RemoteSession = {
        provider, origin, accountId: result.data.user.id, token: result.data.access_token,
      }
      return { session, user: await restore(session) }
    },
    async saasProjects(session: RemoteSession) {
      const send = bindRemoteSession(request)(session)
      if (!send || session.provider !== 'official-saas') throw new RemoteAuthError('invalid_request', '需要 SaaS 会话')
      const projects = new Map<string, { id: string; name: string; summary: string | null }>()
      let cursor = '0'
      for (let page = 0; page < 100; page++) {
        const response = await send('/api/v1/sync/projects/pull?limit=20&cursor=' + encodeURIComponent(cursor), {
          signal: AbortSignal.timeout(12_000),
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new RemoteAuthError('unavailable', '云端项目暂不可用')
        }
        const body = await readJson(response, 4 * 1024 * 1024) as { changes?: unknown; next_cursor?: unknown; has_more?: unknown } | null
        if (!body || !Array.isArray(body.changes) || typeof body.has_more !== 'boolean')
          throw new RemoteAuthError('invalid_response', '云端项目响应无效')
        for (const change of body.changes) {
          if (typeof change?.sync_id !== 'string') throw new RemoteAuthError('invalid_response', '云端项目标识无效')
          if (change.operation === 'delete') projects.delete(change.sync_id)
          else if (change.operation === 'upsert' && typeof change.data?.name === 'string') {
            projects.set(change.sync_id, {
              id: change.sync_id, name: change.data.name,
              summary: typeof change.data.summary === 'string' ? change.data.summary : null,
            })
          } else throw new RemoteAuthError('invalid_response', '云端项目数据无效')
        }
        if (!body.has_more) return [...projects.values()]
        if (typeof body.next_cursor !== 'string' || !/^\d{1,19}$/.test(body.next_cursor) ||
          BigInt(body.next_cursor) <= BigInt(cursor)) throw new RemoteAuthError('invalid_response', '云端项目游标无效')
        cursor = body.next_cursor
      }
      throw new RemoteAuthError('unavailable', '云端项目超过当前读取范围')
    },
    async logoutSaas(session: RemoteSession) {
      const send = bindRemoteSession(request)(session)
      if (!send || session.provider !== 'official-saas') throw new RemoteAuthError('invalid_request', '需要 SaaS 会话')
      const response = await send('/api/v1/auth/logout', { method: 'POST', signal: AbortSignal.timeout(12_000) })
      if (!response.ok && response.status !== 401) throw new RemoteAuthError('unavailable', '无法撤销 SaaS 会话，请重试')
    },
    restore,
  }
}

export function bindRemoteSession(request: typeof fetch = fetch) {
  return (session: RemoteSession) => {
    const parsed = remoteSessionSchema.safeParse(session)
    if (!parsed.success || remoteServerOrigin(parsed.data.origin) !== parsed.data.origin) return null
    const { origin, token } = parsed.data
    return (path: string, init: RequestInit) => {
      const url = new URL(path, origin)
      if (url.origin !== origin) throw new RemoteAuthError('invalid_request', '远程请求地址无效')
      const headers = new Headers(init.headers)
      headers.set('Authorization', 'Bearer ' + token)
      return request(url, { ...init, headers, credentials: 'omit', redirect: 'error' })
    }
  }
}
