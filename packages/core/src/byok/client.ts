import { remoteServerOrigin } from '../auth/client.js'
import { remoteSessionSchema, type RemoteSession } from '../auth/contracts.js'
import { byokCommand, byokList, byokSummary, byokTest, type ByokCommand, type ByokResult } from './contracts.js'

export class RemoteByokError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const errors: Record<number, [string, string]> = {
  401: ['session_expired', '远程会话已失效，请重新登录'],
  403: ['forbidden', '服务器未开放 BYOK 或当前账号无权操作'],
  404: ['not_found', '凭据不存在，或服务器版本尚未提供此操作'],
  422: ['invalid_request', '凭据配置无效。更换 Provider 或目标地址时请重新填写 Key'],
  429: ['rate_limited', '操作过于频繁，请稍后重试'],
  503: ['unavailable', '服务器凭据服务暂不可用'],
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new RemoteByokError('invalid_response', '服务器未返回凭据数据')
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 2 * 1024 * 1024) throw new RemoteByokError('invalid_response', '服务器返回的凭据数据过大')
      body += decoder.decode(value, { stream: true })
    }
    try { return JSON.parse(body + decoder.decode()) as unknown } catch {
      throw new RemoteByokError('invalid_response', '服务器返回的凭据数据无效')
    }
  } catch (error) {
    if (error instanceof RemoteByokError) throw error
    throw new RemoteByokError('unavailable', '远程服务器在返回凭据数据时断开连接')
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const base = '/api/v1/byok'

function route(command: ByokCommand) {
  switch (command.action) {
    case 'list': return { path: base, method: 'GET', schema: byokList }
    case 'create': return { path: command.makeDefault ? base : base + '/saved', method: 'POST', schema: byokSummary }
    case 'update': return { path: base + '/' + command.id, method: 'PATCH', schema: byokSummary }
    case 'test-preview': return { path: base + '/test-preview', method: 'POST', schema: byokTest }
    case 'test': return { path: base + '/' + command.id + '/test', method: 'POST', schema: byokTest }
    case 'bind': return { path: base + '/' + command.id + '/default', method: 'PUT' }
    case 'delete': return { path: base + '/' + command.id, method: 'DELETE' }
  }
}

export function createRemoteByokClient(request: typeof fetch = fetch) {
  return async (session: RemoteSession, value: ByokCommand): Promise<ByokResult> => {
    const parsed = byokCommand.safeParse(value)
    const auth = remoteSessionSchema.safeParse(session)
    if (!parsed.success || !auth.success || remoteServerOrigin(auth.data.origin) !== auth.data.origin) {
      throw new RemoteByokError('invalid_request', '凭据操作或远程会话无效')
    }
    const command = parsed.data
    const { path, method, schema } = route(command)
    const headers = new Headers({ Authorization: 'Bearer ' + auth.data.token })
    if ('input' in command) headers.set('Content-Type', 'application/json')
    const response = await request(new URL(path, auth.data.origin), {
      method, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(60_000), headers,
      body: 'input' in command ? JSON.stringify(command.input) : undefined,
    }).catch(() => {
      throw new RemoteByokError('unavailable', '无法连接远程凭据服务')
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new RemoteByokError(...(errors[response.status] ?? ['unavailable', '远程凭据操作失败']))
    }
    if (!schema) {
      void response.body?.cancel().catch(() => {})
      if (response.status === 204) return null
      throw new RemoteByokError('invalid_response', '服务器未确认凭据操作')
    }
    const result = schema.safeParse(await readJson(response))
    if (!result.success) throw new RemoteByokError('invalid_response', '服务器返回的凭据数据无效')
    return result.data
  }
}
