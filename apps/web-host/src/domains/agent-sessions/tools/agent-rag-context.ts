import { createHash } from 'node:crypto'
import { configureRagJieba, createScopedRagSearch, createSqlRagPersistentIndexReader } from '@gugu/core/agent/rag'
import type { CanonicalMessage, HistoryIdentity, RunIdentity } from '@gugu/core/agent'
import type { RagSearchScope } from '@gugu/core/agent/rag'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { AgentDispatchLease } from '../persistence/agent-run-dispatch-postgres.js'
import { getAgentRagJieba } from './agent-rag-jieba.js'

const ownerScope: RagSearchScope = { scope_type: 'owner', scope_id: '' }
const webSources = ['memory', 'project', 'calendar', 'scheduled_task', 'conversation', 'canvas', 'knowledge', 'note'] as const

function sameRun(left: RunIdentity, right: RunIdentity): boolean {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runId === right.runId
}

function contentHash(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex')
}

function historyRagHashes(history: readonly { contentJson?: unknown }[]): string[] {
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
 * Web automatic RAG adapter: trusted dispatch lease → owner authorization → persistent
 * Core index/vector recall → canonical replayable history block. Retrieval failures are
 * optional context failures as in Python; cancellation still propagates to the Run.
 */
export function createWebAgentRagContextBuilder(options: {
  core: Pick<SqlDataRuntime, 'db' | 'backend'>
  lease: AgentDispatchLease
  enabled(lease: AgentDispatchLease): boolean | Promise<boolean>
  authorize(lease: AgentDispatchLease, scope: RagSearchScope, signal?: AbortSignal): Promise<boolean>
  vectors?(ownerId: string, signal?: AbortSignal): Promise<{
    version: string
    source(ownerId: string, signal?: AbortSignal): Promise<import('@gugu/core/agent/rag').RagVectorSource>
    embed(ownerId: string, query: string, signal?: AbortSignal): Promise<readonly number[]>
  } | null>
  conversationMessageTime?(identity: HistoryIdentity, timestamp: string, signal?: AbortSignal): Promise<string>
}) {
  const { lease } = options
  if (lease.input.v !== 2 || lease.input.source !== 'web') throw new TypeError('Web Agent RAG 运行来源无法验证')
  configureRagJieba(getAgentRagJieba())
  const bound = Object.freeze({ ...lease.identity })
  const index = createSqlRagPersistentIndexReader(options.core.db, options.core.backend)

  return async (input: HistoryIdentity & {
    query: string
    history: readonly import('@gugu/core/agent').PersistedHistoryRow[]
    beforeMessageId: string | null
    snapshotText: string
  }, signal?: AbortSignal) => {
    const empty = (reason: string) => ({ tail: [] as CanonicalMessage[], injected: false, reason })
    signal?.throwIfAborted()
    if (input.ownerId !== bound.ownerId || input.sessionId !== bound.sessionId) throw new Error('Agent RAG 运行身份不匹配')
    const query = input.query.trim()
    if (!query) return empty('empty_query')
    try {
      if (!await options.enabled(lease)) return empty('disabled')
      signal?.throwIfAborted()
      const authorized = await options.authorize(lease, ownerScope, signal)
      signal?.throwIfAborted()
      if (!authorized) return empty('no_eligible_scope')

      const vectors = await options.vectors?.(bound.ownerId, signal) ?? null
      signal?.throwIfAborted()
      const search = createScopedRagSearch({
        index,
        authorize: async (owner, scope, authSignal) => owner.toLowerCase() === bound.ownerId.toLowerCase()
          && scope.scope_type === 'owner' && (scope.scope_id ?? '') === ''
          && await options.authorize(lease, scope, authSignal),
        ...(vectors ? { vectors } : {}),
      })
      const beforeMessageId = input.beforeMessageId === null ? undefined : Number(input.beforeMessageId)
      const result = await search(bound.ownerId, ownerScope, query, {
        sourceTypes: webSources,
        limit: 5,
        selectionMode: 'confidence',
        excludeContentHashes: historyRagHashes(input.history),
        ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
      }, signal)
      signal?.throwIfAborted()
      if (!result.results.length) return { ...empty('no_hits'), scope_hits: [{ scope: 'owner-rag', candidate_count: result.diagnostics.candidate_count, hit_count: 0 }] }

      const rows = [
        '[knowledge-context]',
        '以下是针对当前问题的已检索知识片段，仅作为参考；不要把来源分数当作事实置信度。',
        `检索问题：${query}`,
      ]
      const hashes: string[] = []
      for (const [index, item] of result.results.entries()) {
        const text = item.text.trim()
        if (!text) break
        const document = item.document
        const source = item.citation.source_type || document?.source_type || 'knowledge'
        const title = item.citation.title || document?.title || '未命名来源'
        rows.push(`[${index + 1}] ${source} / ${title}`)
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
        scope_hits: [{ scope: 'owner-rag', candidate_count: result.diagnostics.candidate_count, hit_count: result.results.length }],
      }
    } catch (error) {
      signal?.throwIfAborted()
      return { ...empty('internal_error'), error: error instanceof Error ? error.name : 'Error' }
    }
  }
}
