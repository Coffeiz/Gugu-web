import { createHash } from 'node:crypto'
import type { RunIdentity } from '../models.js'
import type { AuthorizedMemoryScope, MemoryRagScopeStatePort, MemoryRagStorageReader } from './memory-loader.js'
import { prepareMemory } from './memory-loader.js'
import { createRagLexicalIndex } from './lexical-index.js'
import { rankCandidates } from './ranking/rank-candidates.js'
import type { RagRankCandidate } from './contracts.js'

export type MemorySearchScope = 'auto' | 'current_group' | 'all_my_groups' | 'private_memory'
export type MemorySearchSource = 'all' | 'profile' | 'pattern' | 'daily' | 'memory'
export type MemorySearchStrategy = 'auto' | 'bm25' | 'embedding'

export class MemorySearchAccessError extends Error {}

export interface MemorySearchRequest {
  query: string
  scope?: MemorySearchScope
  source?: MemorySearchSource
  strategy?: MemorySearchStrategy
  limit?: number
}

export interface MemorySearchSnapshot { revision: string; text: string }

/** 只有 resolveScopes 可以把已验证的 IM/DB 权限转换为 memory scope。 */
export interface MemorySearchPorts {
  resolveScopes(identity: RunIdentity, requested: MemorySearchScope, signal: AbortSignal): Promise<AuthorizedMemoryScope[]>
  authorize(identity: RunIdentity, scopes: readonly AuthorizedMemoryScope[], signal: AbortSignal): Promise<boolean>
  snapshot(identity: RunIdentity, signal: AbortSignal): Promise<MemorySearchSnapshot>
  storage(identity: RunIdentity): MemoryRagStorageReader
  scopeState: MemoryRagScopeStatePort
  /** 缺少可信 embedding 时使用 BM25；失败/空向量遵循 Python 回退语义。 */
  vectors?(identity: RunIdentity, signal: AbortSignal): Promise<{
    version: string
    embed(query: string, signal: AbortSignal): Promise<readonly number[]>
  } | null>
}

function exactScopeMatch(document: { scope_type: string; scope_id: string; platform?: string; bot_id?: string; group_id?: string }, scope: AuthorizedMemoryScope): boolean {
  if (scope.type === 'owner') return document.scope_type === 'owner' && !document.scope_id
  return document.scope_type === scope.type && document.scope_id === scope.id
    && document.platform === scope.platform && document.bot_id === scope.botId
    && document.group_id === (scope.groupId || (scope.type === 'group' ? scope.id : ''))
}

/**
 * 1.7.7 tool memory query: trusted scope resolution → owner-bound file loader → optional vectors →
 * the shared TS lexical/hybrid ranker. No model-provided owner, group or member ID is accepted.
 */
export function createMemorySearch(ports: MemorySearchPorts) {
  return async (identity: RunIdentity, request: MemorySearchRequest, signal: AbortSignal) => {
    signal.throwIfAborted()
    const query = request.query.trim()
    if (!query) return { query: '', results: [], has_more: false, message: '需要提供检索关键词' }
    const limit = request.limit ?? 5
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new TypeError('RAG 查询参数无效')
    const requestedScope = request.scope ?? 'auto'
    const source = request.source ?? 'all'
    const strategy = request.strategy ?? 'auto'
    const scopes = await ports.resolveScopes(identity, requestedScope, signal)
    signal.throwIfAborted()
    if (!scopes.length || scopes.some(scope => scope.ownerId.toLowerCase() !== identity.ownerId.toLowerCase())) throw new MemorySearchAccessError('RAG 检索未授权')
    if (!await ports.authorize(identity, scopes, signal)) throw new MemorySearchAccessError('RAG 检索未授权')
    const snapshot = await ports.snapshot(identity, signal)
    signal.throwIfAborted()
    const vectors = strategy === 'bm25' ? null : await ports.vectors?.(identity, signal) ?? null
    signal.throwIfAborted()
    const prepared = await prepareMemory({ ownerId: identity.ownerId, scopes, sourceFilter: source,
      snapshotRevision: snapshot.revision, snapshotText: snapshot.text, vectorVersion: vectors?.version ?? '', signal },
    ports.scopeState, ports.storage(identity))
    signal.throwIfAborted()
    const documents = prepared.documents.filter(document => scopes.some(scope => exactScopeMatch(document, scope)))
    // Python memory files can repeat a source key (for example profile:0) in several
    // authorized IM scopes. The shared lexical index is keyed by document ID, so give
    // each already-authorized scope projection an internal unique key before indexing.
    const indexedDocuments = documents.map(document => ({
      ...document,
      id: `${document.id}\u001f${JSON.stringify([document.scope_type, document.platform, document.bot_id, document.group_id, document.scope_id])}`,
    }))
    const index = createRagLexicalIndex(identity.ownerId)
    index.replace(identity.ownerId, prepared.indexSource || 'memory-transient', indexedDocuments)
    let fused
    let fallbackReason: string | null = strategy === 'bm25'
      ? 'lexical_only'
      : vectors ? 'embedding_cache_unavailable' : 'embedding_disabled'
    if (vectors && strategy !== 'bm25' && documents.length) {
      let queryVector: readonly number[] = []
      try { queryVector = await vectors.embed(query, signal) } catch { signal.throwIfAborted() }
      signal.throwIfAborted()
      if (queryVector.length) {
        fused = index.searchHybrid(identity.ownerId, query, 50, ['memory'], undefined, {
          queryVector, vectorVersion: vectors.version, expectedVersion: vectors.version,
          vectors: new Map(indexedDocuments.flatMap((document, index) => {
            const vector = prepared.vectors[documents[index]!.id]
            return vector ? [[document.id, vector] as const] : []
          })),
        })
      }
      if (fused?.fusion === 'hybrid-rrf') fallbackReason = null
    }
    fused ??= { ...index.search(identity.ownerId, query, 50, ['memory']), fusion: 'bm25' as const, vectorDocCount: 0 }
    const byId = new Map(indexedDocuments.map(document => [document.id, document]))
    const candidates: RagRankCandidate[] = fused.results.flatMap(hit => {
      const document = byId.get(hit.id)
      if (!document) return []
      return [{ id: hit.id, source_type: 'memory', raw_score: hit.score, document,
        ...('semantic_score' in hit ? { semantic_score: hit.semantic_score } : {}),
        ...(fused.fusion === 'hybrid-rrf' ? { fusion: 'hybrid-rrf' as const } : {}) }]
    })
    const ranked = rankCandidates(query, candidates, { limit, maxChars: 3000, selectionMode: 'top_k', corpusStatistics: index.statistics(identity.ownerId) })
    signal.throwIfAborted()
    if (!await ports.authorize(identity, scopes, signal)) throw new MemorySearchAccessError('RAG 检索授权已撤销')
    signal.throwIfAborted()
    const results = ranked.results.map((result, rank) => {
      const document = byId.get(result.id)!
      const sourceId = String(document.source_id || '')
      const title = String(document.title || '未命名来源')
      const version = String(document.document_version || '')
      const chunkId = `${document.parent_id || document.id}:${version}:${document.chunk_index || 0}`
      const contentHash = createHash('sha256').update(String(document.content || '').trim()).digest('hex')
      const citation = { source_type: 'memory', source_id: sourceId, title, chunk_id: chunkId, version,
        ...(document.updated_at ? { updated_at: document.updated_at } : {}) }
      return { source: 'memory', source_id: sourceId, title, summary: String(document.summary || ''), text: result.text,
        score: Number(result.rank_score ?? result.fused_score), chunk_id: chunkId, version, document_version: version,
        content_hash: contentHash, content_fingerprint: contentHash, updated_at: document.updated_at ?? null, citation,
        rank: rank + 1, normalized_score: result.normalized_score, fused_score: result.fused_score,
        confidence: result.confidence, source_quality: result.source_quality }
    })
    const strategyUsed = fused.fusion === 'hybrid-rrf' ? 'hybrid' : 'bm25'
    return { query, results, has_more: fused.diagnostics.eligible_count > results.length,
      strategy: strategyUsed, fallback_reason: fallbackReason, index_source: prepared.indexSource, sources: ['memory'],
      candidate_count: candidates.length, permission_rejected: 0,
      rejected_low_score: ranked.diagnostics.rejected_low_score, rejected_not_preferred: ranked.diagnostics.rejected_not_preferred,
      rejected_duplicate: ranked.diagnostics.rejected_duplicate, rejected_parent: ranked.diagnostics.rejected_parent,
      rejected_source: ranked.diagnostics.rejected_source, rejected_diversity: ranked.diagnostics.rejected_similarity,
      accepted_count: results.length, top_confidence: ranked.diagnostics.top_confidence,
      confidence_threshold: ranked.diagnostics.threshold, preferred_confidence_threshold: ranked.diagnostics.preferred_threshold,
      selection_mode: ranked.diagnostics.selection_mode, scoring_version: ranked.diagnostics.scoring_version,
      rescore_version: ranked.diagnostics.rescore_version, idf_source: ranked.diagnostics.idf_source,
      contribution_exponent: ranked.diagnostics.contribution_exponent,
      engine: 'typescript', cache_hit: prepared.probe.cache.owner_cache_hit || prepared.probe.cache.scoped_cache_hit,
      cache_entries: prepared.probe.cache.owner_cache_hit || prepared.probe.cache.scoped_cache_hit ? 1 : 0,
      cache_miss_reasons: [], sidecar_reused: null, stage_ms: { ...prepared.probe.stage_ms, rank_candidates_ms: ranked.diagnostics.elapsed_ms },
      source_diagnostics: { memory: { candidate_count: candidates.length, hit_count: fused.diagnostics.eligible_count } },
      rank: ranked.diagnostics, ...(results.length ? {} : { message: '未找到相关记忆' }) }
  }
}
