import type { BindRemoteRequest } from '../shared/remote-request.js'
import { desktopDeepResearchInput, desktopDeepResearchResult, desktopSimilarImageInput, type DesktopDeepResearchInput, type DesktopDeepResearchResult, type DesktopSimilarImageInput } from './search-contracts.js'

export class RemoteAgentSearchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function readResult(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new RemoteAgentSearchError('invalid_response', '服务器未返回搜索结果')
  const decoder = new TextDecoder()
  let body = ''
  let bytes = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > 1024 * 1024) throw new RemoteAgentSearchError('invalid_response', '服务器返回的搜索结果过大')
      body += decoder.decode(value, { stream: true })
    }
    try { return JSON.parse(body + decoder.decode()) as unknown }
    catch { throw new RemoteAgentSearchError('invalid_response', '服务器返回的搜索结果无效') }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof RemoteAgentSearchError) throw error
    throw new RemoteAgentSearchError('unavailable', '远程服务器在返回搜索结果时断开连接')
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

export function createRemoteAgentSearchAvailabilityClient<Session>(bind: BindRemoteRequest<Session>) {
  return async (session: Session, capability: 'deep-research' | 'similar-image', signal?: AbortSignal) => {
    const request = bind(session)
    if (!request) return false
    const deadline = AbortSignal.timeout(5_000)
    const connection = signal ? AbortSignal.any([signal, deadline]) : deadline
    try {
      connection.throwIfAborted()
      const response = await request(`/api/v1/agent/desktop-search/${capability}`, {
        credentials: 'omit', redirect: 'error', signal: connection,
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        return false
      }
      const result = await readResult(response, connection)
      return !!result && typeof result === 'object' && 'available' in result && result.available === true
    } catch {
      signal?.throwIfAborted()
      return false
    }
  }
}

async function postSearch<Session>(
  bind: BindRemoteRequest<Session>,
  session: Session,
  input: DesktopDeepResearchInput | DesktopSimilarImageInput | undefined,
  capability: 'deep-research' | 'similar-image',
  signal?: AbortSignal,
): Promise<DesktopDeepResearchResult> {
  const request = bind(session)
  const research = capability === 'deep-research'
  const label = research ? '深度研究' : '相似图片搜索'
  if (!request || !input)
    throw new RemoteAgentSearchError('invalid_request', research ? '远程搜索请求或会话无效' : '远程图片搜索请求或会话无效')
  signal?.throwIfAborted()
  const deadline = AbortSignal.timeout(120_000)
  const connection = signal ? AbortSignal.any([signal, deadline]) : deadline
  const response = await request(`/api/v1/agent/desktop-search/${capability}`, {
    method: 'POST', credentials: 'omit', redirect: 'error', signal: connection,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }).catch(() => {
    signal?.throwIfAborted()
    throw new RemoteAgentSearchError('unavailable', research ? '无法连接远程搜索服务' : '无法连接远程图片搜索服务')
  })
  if (connection.aborted || !response.ok) {
    void response.body?.cancel().catch(() => {})
    signal?.throwIfAborted()
    const messages: Record<number, [string, string]> = {
      401: ['session_expired', '远程会话已失效，请重新登录'],
      403: ['forbidden', '服务器未开放此搜索能力'],
      404: ['not_found', `远程服务器尚未提供${label}`],
      422: ['invalid_request', `${label}请求无效`],
      429: ['rate_limited', `${label}次数已达上限`],
    }
    const unavailable: [string, string] = ['unavailable', research ? '远程搜索服务暂不可用' : '远程图片搜索服务暂不可用']
    throw new RemoteAgentSearchError(...(connection.aborted ? unavailable : messages[response.status] ?? unavailable))
  }
  let body: unknown
  try { body = await readResult(response, connection) }
  catch (error) {
    signal?.throwIfAborted()
    if (deadline.aborted) throw new RemoteAgentSearchError('unavailable', '远程搜索服务响应超时')
    throw error
  }
  const result = desktopDeepResearchResult.safeParse(body)
  if (!result.success)
    throw new RemoteAgentSearchError('invalid_response', research ? '服务器返回的搜索结果无效' : '服务器返回的图片搜索结果无效')
  return result.data
}

export function createRemoteAgentDeepResearchClient<Session>(bind: BindRemoteRequest<Session>) {
  return (session: Session, input: DesktopDeepResearchInput, signal?: AbortSignal) =>
    postSearch(bind, session, desktopDeepResearchInput.safeParse(input).data, 'deep-research', signal)
}

export function createRemoteAgentSimilarImageSearchClient<Session>(bind: BindRemoteRequest<Session>) {
  return (session: Session, input: DesktopSimilarImageInput, signal?: AbortSignal) =>
    postSearch(bind, session, desktopSimilarImageInput.safeParse(input).data, 'similar-image', signal)
}
