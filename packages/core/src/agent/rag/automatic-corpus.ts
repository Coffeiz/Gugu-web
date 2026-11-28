import type { SqlDataRuntime } from '../../data/runtime.js'
import type { RagContext } from '../models.js'
import type { RagSearchScope } from './contracts.js'
import { createRagLexicalCorpusCache } from './lexical-index.js'
import { getAgentRagJieba } from './node-jieba.js'
import type { createSqlRagPersistentIndexReader } from './persistent-index.js'
import { configureRagJieba } from './tokenizer.js'

export const automaticRagSources = ['memory', 'project', 'calendar', 'scheduled_task', 'conversation', 'canvas', 'knowledge', 'note'] as const
const allowedSources = new Set<string>(automaticRagSources)
const corpora = new WeakMap<SqlDataRuntime['db'], ReturnType<typeof createRagLexicalCorpusCache>>()

/** 自动召回仅预热已授权范围。实际检索仍需读取当前快照并复核授权。 */
export function prepareAutomaticRagCorpus(options: {
  db: SqlDataRuntime['db']
  index: Pick<ReturnType<typeof createSqlRagPersistentIndexReader>, 'snapshotForScope'>
  ownerId: string
  scopes: readonly RagSearchScope[]
}) {
  const { db, index, ownerId, scopes } = options
  let cache = corpora.get(db)
  if (!cache) {
    cache = createRagLexicalCorpusCache()
    corpora.set(db, cache)
  }
  const scopeKey = JSON.stringify(scopes.map(scope => JSON.stringify([
    scope.scope_type, scope.scope_id ?? '', scope.platform ?? '', scope.bot_id ?? '', scope.group_id ?? '',
  ])).sort())
  const lexicalCorpus = cache.bindReady(ownerId, scopeKey)
  if (lexicalCorpus) return { ready: true, lexicalCorpus } as const

  cache.warm(ownerId, async () => {
    const snapshots = []
    for (const scope of scopes) snapshots.push(await index.snapshotForScope(ownerId, scope))
    configureRagJieba(getAgentRagJieba())
    return {
      revision: snapshots.map(snapshot => snapshot.revision ?? 'empty').join('|'),
      documents: snapshots.flatMap(snapshot => snapshot.documents).filter(document => allowedSources.has(document.source_type)),
    }
  }, scopeKey)
  return { ready: false, context: { tail: [], blocks: [], scope_hits: [], injected: false, reason: 'index_warming' } satisfies RagContext } as const
}
