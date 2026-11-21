import { createHash } from 'node:crypto'
import type { SqlDataRuntime } from '../../data/runtime.js'
import type { CanonicalMessage, HistoryIdentity, PersistedHistoryRow, RagContext, RunIdentity } from '../models.js'
import { configureRagJieba } from './tokenizer.js'
import { getAgentRagJieba } from './node-jieba.js'
import { createSqlRagPersistentIndexReader } from './persistent-index.js'
import { createScopedRagSearch, type ScopedRagVectors } from './scoped-search.js'
import type { RagSearchScope } from './contracts.js'

const ownerScope: RagSearchScope = { scope_type: 'owner', scope_id: '' }
const sourceTypes = ['memory', 'project', 'calendar', 'scheduled_task', 'conversation', 'canvas', 'knowledge', 'note'] as const

function contentHash(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex')
}

function historyRagHashes(history: readonly PersistedHistoryRow[]): string[] {
  const hashes = new Set<string>()
  for (const row of history) {
    if (!Array.isArray(row.contentJson)) continue
    for (const block of row.contentJson) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue
      const value = block as Record<string, unknown>
      if (value.type !== 'knowledge-context') continue
      if (typeof value.content_hash === 'string' && value.content_hash) hashes.add(value.content_hash)
      if (Array.isArray(value.content_hashes)) {
        for (const hash of value.content_hashes) if (typeof hash === 'string' && hash) hashes.add(hash)
      }
    }
  }
  return [...hashes]
}

/**
 * Shared automatic owner RAG for Web Host and Desktop. Hosts bind authorization,
 * availability and optional vector storage; the ranking and replayable context
 * projection stay identical across runtimes.
 */
export function createAgentRagContextBuilder(options: {
  core: Pick<SqlDataRuntime, 'db' | 'backend'>
  identity: RunIdentity
  enabled(identity: RunIdentity, signal?: AbortSignal): boolean | Promise<boolean>
  authorize(identity: RunIdentity, scope: RagSearchScope, signal?: AbortSignal): Promise<boolean>
  vectors?(ownerId: string, signal?: AbortSignal): Promise<(ScopedRagVectors & {
    close?(): Promise<void>
  }) | null>
  conversationMessageTime?(identity: HistoryIdentity, timestamp: string, signal?: AbortSignal): Promise<string>
}) {
  configureRagJieba(getAgentRagJieba())
  const bound = Object.freeze({ ...options.identity })
  const index = createSqlRagPersistentIndexReader(options.core.db, options.core.backend)

  return async (input: HistoryIdentity & {
    query: string
    history: readonly PersistedHistoryRow[]
    beforeMessageId: string | null
    snapshotText: string
  }, signal?: AbortSignal): Promise<RagContext> => {
    const empty = (reason: string) => ({ tail: [] as CanonicalMessage[], injected: false, reason })
    signal?.throwIfAborted()
    if (input.ownerId !== bound.ownerId || input.sessionId !== bound.sessionId) throw new Error('Agent RAG 运行身份不匹配')
    const query = input.query.trim()
    if (!query) return empty('empty_query')
    try {
      if (!await options.enabled(bound, signal)) return empty('disabled')
      signal?.throwIfAborted()
      if (!await options.authorize(bound, ownerScope, signal)) return empty('no_eligible_scope')
      signal?.throwIfAborted()

      const vectors = await options.vectors?.(bound.ownerId, signal) ?? null
      signal?.throwIfAborted()
      const search = createScopedRagSearch({
        index,
        authorize: async (owner, scope, authSignal) => owner.toLowerCase() === bound.ownerId.toLowerCase()
          && scope.scope_type === 'owner' && (scope.scope_id ?? '') === ''
          && await options.authorize(bound, scope, authSignal),
        ...(vectors ? { vectors } : {}),
      })
      const beforeMessageId = input.beforeMessageId === null ? undefined : Number(input.beforeMessageId)
      const result = await (async () => {
        try {
          return await search(bound.ownerId, ownerScope, query, {
            sourceTypes,
            limit: 5,
            selectionMode: 'confidence',
            excludeContentHashes: historyRagHashes(input.history),
            ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
          }, signal)
        } finally {
          await vectors?.close?.()
        }
      })()
      signal?.throwIfAborted()
      const diagnostics = {
        engine: result.fusion,
        index_version: result.revision,
        scope_type: 'owner',
        vector_doc_count: result.vectorDocCount,
        ...result.diagnostics,
        rank_details: result.results.map((item, index) => ({
          rank: index + 1,
          source_type: item.document.source_type,
          source_quality: item.source_quality,
          ...(item.query_match === undefined ? {} : { query_match: item.query_match }),
          fused_score: item.fused_score,
          normalized_score: item.normalized_score,
          ...(item.semantic_norm === undefined ? {} : { semantic_norm: item.semantic_norm }),
          confidence: item.confidence,
          rank_score: item.rank_score,
          query_idf_baseline: item.query_idf_baseline ?? null,
          contributions: item.rank_contributions ?? [],
        })),
      }
      if (!result.results.length) return { ...empty('no_hits'),
        scope_hits: [{ scope: 'owner-rag', candidate_count: result.diagnostics.candidate_count, hit_count: 0 }], diagnostics }

      const rows = [
        '[knowledge-context]',
        '以下是针对当前问题的已检索知识片段，仅作为参考；不要把来源分数当作事实置信度。',
        `检索问题：${query}`,
      ]
      const hashes: string[] = []
      for (const [itemIndex, item] of result.results.entries()) {
        const text = item.text.trim()
        if (!text) break
        const document = item.document
        const source = item.citation.source_type || document?.source_type || 'knowledge'
        const title = item.citation.title || document?.title || '未命名来源'
        rows.push(`[${itemIndex + 1}] ${source} / ${title}`)
        if (source === 'conversation' && document?.metadata?.message_id != null && document.updated_at && options.conversationMessageTime) {
          const messageTime = await options.conversationMessageTime(input, document.updated_at, signal)
          signal?.throwIfAborted()
          if (messageTime) rows.push(messageTime)
        }
        rows.push(text)
        if (document?.content) hashes.push(contentHash(document.content))
      }
      rows.push('[/knowledge-context]')
      const rendered = rows.join('\n')
      const block = {
        type: 'knowledge-context', scope: 'owner-rag', text: rendered,
        content_hash: contentHash(rendered), ...(hashes.length ? { content_hashes: hashes } : {}),
      }
      return {
        tail: [{ role: 'user', content: [block] }],
        blocks: [block],
        injected: true,
        reason: 'injected',
        scope_hits: [{ scope: 'owner-rag', candidate_count: result.diagnostics.candidate_count, hit_count: result.results.length }],
        diagnostics,
      }
    } catch (error) {
      signal?.throwIfAborted()
      return { ...empty('internal_error'), error: error instanceof Error ? error.name : 'Error' }
    }
  }
}
