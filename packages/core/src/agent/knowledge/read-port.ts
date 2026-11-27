import { dataContext } from '../../contracts/index.js'
import type { SqlDataRuntime } from '../../data/runtime.js'
import type { KnowledgeReadPort, KnowledgeSearchHit } from '../tools/knowledge/index.js'
import type { RunIdentity } from '../models.js'
import { parseAgentKnowledgeRecord } from '../rag/knowledge-source.js'
import { createScopedRagSearch } from '../rag/scoped-search.js'
import { createSqlRagPersistentIndexReader } from '../rag/persistent-index.js'
import type { RagSearchScope } from '../rag/contracts.js'
import type { AgentKnowledgeReadStore } from './overview.js'

const ID = /^[A-Za-z0-9_-]{1,128}$/u

function localIso(value: string, timezone: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('知识时间无效')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp)
  const field = (name: string) => parts.find(part => part.type === name)?.value ?? ''
  const local = `${field('year')}-${field('month')}-${field('day')}T${field('hour')}:${field('minute')}:${field('second')}`
  const localAsUtc = Date.UTC(Number(field('year')), Number(field('month')) - 1, Number(field('day')),
    Number(field('hour')), Number(field('minute')), Number(field('second')))
  const offset = Math.round((localAsUtc - timestamp) / 60_000)
  const sign = offset < 0 ? '-' : '+'
  const absolute = Math.abs(offset)
  return `${local}${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}

/** Desktop/Web owner scope reader:正文来自 owner FS，搜索只读当前 owner 的正式 BM25 索引。 */
export function createOwnerAgentKnowledgeReadPort(core: Pick<SqlDataRuntime, 'db' | 'backend'>,
  store: AgentKnowledgeReadStore, options: {
    timezone(identity: RunIdentity, signal?: AbortSignal): Promise<string>
    authorize(identity: RunIdentity, signal?: AbortSignal): Promise<boolean>
  }): KnowledgeReadPort {
  if (!store || typeof options.timezone !== 'function' || typeof options.authorize !== 'function')
    throw new TypeError('知识工具 Host 依赖未装配')
  const index = createSqlRagPersistentIndexReader(core.db, core.backend)
  return {
    async read(identity, rawId, signal) {
      signal.throwIfAborted()
      if (!await options.authorize(identity, signal)) throw new Error('知识读取未授权')
      const owner = dataContext(identity.ownerId).ownerId
      const id = rawId.trim()
      if (!ID.test(id)) return null
      const base = `${owner}/.agent/knowledge/`
      if (!await store.exists(`${base}.timestamps-iso-v1`)) return null
      const key = `${base}entries/${id}.md`
      if (!await store.exists(key)) return null
      signal.throwIfAborted()
      const record = parseAgentKnowledgeRecord(await store.read(key))
      signal.throwIfAborted()
      if (record.id !== id || record.owner.toLowerCase() !== owner.toLowerCase()
        || record.scope.scope_type !== 'owner' || !record.active) return null
      const timezone = await options.timezone(identity, signal)
      signal.throwIfAborted()
      const metadata = record.metadata
      return {
        knowledge_id: record.id, title: record.title, topic: String(metadata.topic ?? ''),
        description: String(metadata.description ?? ''),
        keywords: String(metadata.keywords ?? '').split('、').filter(Boolean),
        confidence: String(metadata.confidence ?? ''), source_type: String(metadata.source_type ?? ''),
        scope_type: record.scope.scope_type, created_at: localIso(record.created_at, timezone),
        updated_at: localIso(record.updated_at, timezone), content: record.content,
        version: Number(record.document_version.split(':', 1)[0]),
      }
    },
    async search(identity, keyword, requestedScope, limit, signal) {
      signal.throwIfAborted()
      if (!await options.authorize(identity, signal)) throw new Error('知识检索未授权')
      if (requestedScope && requestedScope !== 'owner') throw new Error('知识检索范围不可用')
      const owner = dataContext(identity.ownerId).ownerId
      const ownerScope: RagSearchScope = { scope_type: 'owner', scope_id: '' }
      const search = createScopedRagSearch({ index,
        async authorize(candidateOwner, candidateScope, authSignal) {
          authSignal?.throwIfAborted()
          return candidateOwner.toLowerCase() === owner.toLowerCase()
            && candidateScope.scope_type === 'owner' && (candidateScope.scope_id ?? '') === ''
            && await options.authorize(identity, authSignal)
        },
      })
      const result = await search(owner, ownerScope, keyword, { sourceTypes: ['knowledge'], limit }, signal)
      signal.throwIfAborted()
      const results: KnowledgeSearchHit[] = result.results.flatMap(item => {
        const document = item.document
        if (!document || document.source_type !== 'knowledge') return []
        const metadata = document.metadata ?? {}
        const score = Number(item.rank_score ?? item.fused_score)
        return [{ knowledge_id: document.source_id ?? document.parent_id ?? document.id,
          title: document.title ?? '', topic: String(metadata.topic ?? ''), description: String(metadata.description ?? ''),
          keywords: String(metadata.keywords ?? ''), confidence: String(metadata.confidence ?? ''),
          source_type: String(metadata.source_type ?? ''), source_ref: String(metadata.source_ref ?? ''),
          source_label: String(metadata.source_label ?? ''), content: item.text,
          score: Number.isFinite(score) ? score : null, updated_at: document.updated_at ?? '',
          version: document.document_version?.split(':', 1)[0] ?? '',
        }]
      })
      return { results, has_more: (result.diagnostics.source_diagnostics?.knowledge?.eligible_count ?? 0) > results.length }
    },
  }
}
