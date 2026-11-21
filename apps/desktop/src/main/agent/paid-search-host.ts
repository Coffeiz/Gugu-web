import { createRemoteAgentDeepResearchClient, createRemoteAgentSearchAvailabilityClient, createRemoteAgentSimilarImageSearchClient, RemoteAgentSearchError } from '@gugu/core/agent/search-client'
import { desktopDeepResearchInput, desktopSimilarImageHostInput } from '@gugu/core/agent/search-contracts'
import type { createRemoteSessionStore } from '../auth/store.js'
import { DesktopError } from '../core-host.js'

const methods = new Set([
  'agent.search.deep_research.available', 'agent.search.similar_image_search.available',
  'agent.search.deep_research', 'agent.search.similar_image_search',
])
export const isDesktopPaidSearchMethod = (method: string) => methods.has(method)

export function createDesktopPaidSearchHost(
  sessions: ReturnType<typeof createRemoteSessionStore>,
  request: typeof fetch,
  readImage: (id: string) => Promise<{ data: Uint8Array }>,
) {
  const remoteSearchAvailable = createRemoteAgentSearchAvailabilityClient(request)
  const remoteDeepResearch = createRemoteAgentDeepResearchClient(request)
  const remoteSimilarImageSearch = createRemoteAgentSimilarImageSearchClient(request)
  return async (method: string, params: Record<string, unknown>, signal: AbortSignal) => {
    if ((method === 'agent.search.deep_research.available' || method === 'agent.search.similar_image_search.available')
      && Object.keys(params).length === 0) {
      const session = await sessions.read()
      return session ? remoteSearchAvailable(session,
        method === 'agent.search.deep_research.available' ? 'deep-research' : 'similar-image', signal) : false
    }
    if (method === 'agent.search.deep_research') {
      const parsed = desktopDeepResearchInput.safeParse(params)
      if (!parsed.success) throw new DesktopError('invalid_request', '深度研究请求无效')
      const session = await sessions.read()
      if (!session) throw new DesktopError('closed', '请先登录远程服务器以使用深度研究')
      try { return await remoteDeepResearch(session, parsed.data, signal) }
      catch (error) {
        signal.throwIfAborted()
        if (error instanceof RemoteAgentSearchError)
          throw new DesktopError('storage_error', error.message)
        throw new DesktopError('storage_error', '远程深度研究暂不可用，请稍后重试')
      }
    }
    if (method === 'agent.search.similar_image_search') {
      const parsed = desktopSimilarImageHostInput.safeParse(params)
      if (!parsed.success) throw new DesktopError('invalid_request', '相似图片搜索请求无效')
      const session = await sessions.read()
      if (!session) throw new DesktopError('closed', '请先登录远程服务器以使用相似图片搜索')
      try {
        if (!('attach_id' in parsed.data)) return await remoteSimilarImageSearch(session, parsed.data, signal)
        const { attach_id, ...fields } = parsed.data
        const image = await readImage(attach_id)
        signal?.throwIfAborted()
        return await remoteSimilarImageSearch(session, { ...fields, image_base64: Buffer.from(image.data).toString('base64') }, signal)
      }
      catch (error) {
        signal.throwIfAborted()
        if (error instanceof DesktopError) throw error
        if (error instanceof RemoteAgentSearchError)
          throw new DesktopError(error.code, error.message)
        throw new DesktopError('storage_error', '远程相似图片搜索暂不可用，请稍后重试')
      }
    }
    throw new DesktopError('invalid_request', '专项搜索操作无效')
  }
}
