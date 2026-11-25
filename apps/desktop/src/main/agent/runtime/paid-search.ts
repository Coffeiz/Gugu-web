import { createHash } from 'node:crypto'
import type { RunIdentity } from '#core-source/agent/models.js'
import { createDeepResearchTool, createSimilarImageSearchTool } from '#core-source/agent/tools/search.js'
import { desktopDeepResearchResult, MAX_DESKTOP_SEARCH_IMAGE_BYTES } from '#core-source/agent/search-contracts.js'
import { openLocalFile } from '@gugu/fs/node'

export function bindDesktopPaidSearchTools(
  hostRequest: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  resolveOwnedAttachment: (identity: RunIdentity, attachId: string, signal: AbortSignal) => Promise<{
    kind: string; extension: string; size_bytes: number; root: string; relativePath: string
  } | null>,
  digest: (value: unknown) => string,
) {
  return function paidSearchTools(recoverySignal?: AbortSignal) {
    function paidSearchOperation(identity: RunIdentity, roundId: string, callId: string) {
      const hex = digest([identity.ownerId, identity.sessionId, identity.runId, roundId, callId])
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    }
    async function remotePaidSearch(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const result = desktopDeepResearchResult.safeParse(await hostRequest(method, params, signal))
      return result.success ? result.data : { kind: 'unknown' as const }
    }
    function researchParams(input: { query: string; maxResults?: number; depth: string }) {
      return { query: input.query, ...(input.maxResults === undefined ? {} : { max_results: input.maxResults }), depth: input.depth }
    }
    function imageParams(input: { attachmentId: string; url: string; maxResults?: number }) {
      return {
        ...(input.attachmentId ? { attach_id: input.attachmentId } : { image_url: input.url }),
        ...(input.maxResults === undefined ? {} : { max_results: input.maxResults }),
      }
    }
    const deepResearch = createDeepResearchTool({
      search(input, scope, call) {
        return remotePaidSearch('agent.search.deep_research', {
          operation_id: paidSearchOperation(scope.identity, scope.roundId, call.id), ...researchParams(input),
        }, scope.signal)
      },
      reconcile(input, identity, call) {
        return remotePaidSearch('agent.search.deep_research', {
          operation_id: paidSearchOperation(identity, identity.roundId, call.id), ...researchParams(input), reconcile_only: true,
        }, recoverySignal ?? AbortSignal.timeout(5_000))
      },
    })
    const similarImageSearch = createSimilarImageSearchTool({
      async search(input, scope, call) {
        if (input.attachmentId) {
          const image = await resolveOwnedAttachment(scope.identity, input.attachmentId, scope.signal)
          if (image?.kind !== 'image' || !['png', 'jpeg', 'jpg'].includes(image.extension.toLowerCase()))
            return { kind: 'completed', successful: false, mutated: false, value: { error: '当前消息没有可用的 JPG 或 PNG 附件' } }
        }
        return remotePaidSearch('agent.search.similar_image_search', {
          operation_id: paidSearchOperation(scope.identity, scope.roundId, call.id), ...imageParams(input),
        }, scope.signal)
      },
      async reconcile(input, identity, call) {
        const signal = recoverySignal ?? AbortSignal.timeout(5_000)
        let image: Record<string, unknown> = imageParams(input)
        if (input.attachmentId) {
          const file = await resolveOwnedAttachment(identity, input.attachmentId, signal)
          if (!file || file.kind !== 'image' || file.size_bytes > MAX_DESKTOP_SEARCH_IMAGE_BYTES) return { kind: 'unknown' }
          const opened = await openLocalFile(file.root, file.relativePath)
          if (!opened) return { kind: 'unknown' }
          try {
            if (opened.size !== file.size_bytes) return { kind: 'unknown' }
            const bytes = Buffer.alloc(file.size_bytes)
            const { bytesRead } = await opened.handle.read(bytes, 0, bytes.length, 0)
            signal.throwIfAborted()
            if (bytesRead !== bytes.length) return { kind: 'unknown' }
            image = { image_digest: createHash('sha256').update(bytes).digest('hex'),
              ...(input.maxResults === undefined ? {} : { max_results: input.maxResults }) }
          } finally { await opened.handle.close() }
        }
        return remotePaidSearch('agent.search.similar_image_search', {
          operation_id: paidSearchOperation(identity, identity.roundId, call.id), ...image, reconcile_only: true,
        }, signal)
      },
    })
    return { deepResearch, similarImageSearch }
  }
}
