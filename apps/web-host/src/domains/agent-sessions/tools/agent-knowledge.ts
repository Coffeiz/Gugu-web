import { createAgentKnowledgeOverview, createScopedRagSearch, createSqlRagPersistentIndexReader, parseAgentKnowledgeRecord, type AgentKnowledgeReadStore, type ContextDataPorts, type Json, type RagSearchScope, type RunIdentity } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { KnowledgeReadPort, KnowledgeSearchHit } from '@gugu/core/tools'
import { dataContext } from '@gugu/core/contracts'

const ID = /^[A-Za-z0-9_-]{1,128}$/u

/** Python load_knowledge_overview 在知识存储不可用时保留本轮上下文，其它数据仍可继续加载。 */
export function createAgentKnowledgeOverviewLoader(store: AgentKnowledgeReadStore): ContextDataPorts['loadKnowledge'] {
  const readOverview = createAgentKnowledgeOverview(store)
  return async (identity, signal) => {
    signal?.throwIfAborted()
    const owner = dataContext(identity.ownerId).ownerId
    try {
      return (await readOverview(owner, signal)).map(item => ({
        title: item.title,
        topic: item.topic,
        description: item.description,
      }) as Record<string, Json>)
    } catch {
      signal?.throwIfAborted()
      return []
    }
  }
}

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

/** 生产 Host 适配：正文经 owner FS 直读；关键词只查正式索引和可信 scope。 */
export function createAgentKnowledgeReadPort(core: Pick<SqlDataRuntime, 'db' | 'backend'>,
  store: AgentKnowledgeReadStore, options: {
    timezone(identity: RunIdentity): Promise<string>
    resolveScope(identity: RunIdentity, requested: string, signal: AbortSignal): Promise<RagSearchScope | null>
    authorize(identity: RunIdentity, scope: RagSearchScope, signal: AbortSignal): Promise<boolean>
  }): KnowledgeReadPort {
  if (!store || typeof options.timezone !== 'function' || typeof options.resolveScope !== 'function'
    || typeof options.authorize !== 'function') throw new TypeError('知识工具 Host 依赖未装配')
  const index = createSqlRagPersistentIndexReader(core.db, core.backend)
  return {
    async read(identity, rawId, signal) {
      signal.throwIfAborted()
      const owner = dataContext(identity.ownerId).ownerId
      const id = rawId.trim()
      if (!ID.test(id)) return null
      const root = `${owner}/.agent/knowledge/`
      if (!await store.exists(`${root}.timestamps-iso-v1`)) throw new Error('知识存储尚未迁移到 owner 授权文件格式')
      const key = `${root}entries/${id}.md`
      if (!await store.exists(key)) return null
      signal.throwIfAborted()
      const record = parseAgentKnowledgeRecord(await store.read(key))
      signal.throwIfAborted()
      if (record.id !== id || record.owner.toLowerCase() !== owner.toLowerCase() || !record.active) return null
      const timezone = await options.timezone(identity)
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
      const owner = dataContext(identity.ownerId).ownerId
      const scope = await options.resolveScope(identity, requestedScope || 'owner', signal)
      signal.throwIfAborted()
      if (!scope || !await options.authorize(identity, scope, signal)) throw new Error('RAG 检索未授权')
      const scopeFields = ['scope_type', 'scope_id', 'platform', 'bot_id', 'group_id'] as const
      const search = createScopedRagSearch({ index,
        authorize: async (candidateOwner, candidateScope, authSignal) => candidateOwner.toLowerCase() === owner.toLowerCase()
          && scopeFields.every(key => candidateScope[key] === scope[key])
          && await options.authorize(identity, candidateScope, authSignal ?? signal),
      })
      const result = await search(owner, scope, keyword, { sourceTypes: ['knowledge'], limit }, signal)
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
          // Python read_knowledge returns the ranked hit text (including the
          // shared 3000-character/context projection), never the full stored
          // chunk content. Keep the same boundary for tool output.
          source_label: String(metadata.source_label ?? ''), content: item.text,
          score: Number.isFinite(score) ? score : null, updated_at: document.updated_at ?? '',
          version: document.document_version?.split(':', 1)[0] ?? '',
        }]
      })
      return { results, has_more: (result.diagnostics.source_diagnostics?.knowledge?.eligible_count ?? 0) > results.length }
    },
  }
}

/** Web Run 有 owner 身份、没有可信 IM 群上下文时，只启用 Python 默认 owner scope。 */
export function createWebOwnerAgentKnowledgeReadPort(core: Pick<SqlDataRuntime, 'db' | 'backend'>,
  store: AgentKnowledgeReadStore, options: {
    timezone(identity: RunIdentity): Promise<string>
  }): KnowledgeReadPort {
  return createAgentKnowledgeReadPort(core, store, {
    timezone: options.timezone,
    async resolveScope(_identity, requested) {
      return !requested || requested === 'owner' ? { scope_type: 'owner', scope_id: '' } : null
    },
    async authorize(identity, scope) {
      const owner = dataContext(identity.ownerId).ownerId
      return Boolean(owner) && scope.scope_type === 'owner' && (scope.scope_id ?? '') === ''
    },
  })
}
