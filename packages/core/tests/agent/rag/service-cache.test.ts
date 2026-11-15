import { describe, expect, it } from 'vitest'
import type { RagResponse, RagSourceBatch } from '../../../src/agent/rag/contracts.js'
import { RagIndexCacheService } from '../../../src/agent/rag/index-cache-service.js'
import { RagSnapshotCache } from '../../../src/agent/rag/snapshot-cache.js'
import { TsRagService, type RagServiceEngine } from '../../../src/agent/rag/rag-service.js'

function ok(fields: Record<string, unknown> = {}): RagResponse {
  return { status: 'ok', version: 'test', revision: 'r1', ...fields } as RagResponse
}

describe('1.7.7 RAG cache 与服务生命周期', () => {
  it('索引缓存按访问 TTL、revision 和显式失效报告原因', () => {
    let now = 0
    const cache = new RagIndexCacheService({ ttlMs: 100, now: () => now })

    expect(cache.lookup('owner:a', 'r1').reason).toBe('miss')
    cache.commit('owner:a', 'r1')
    now = 90
    expect(cache.lookup('owner:a', 'r1').reason).toBe('hit')
    now = 180
    expect(cache.lookup('owner:a', 'r1').reason).toBe('hit')
    expect(cache.lookup('owner:a', 'r2').reason).toBe('revision-changed')
    now = 281
    expect(cache.lookup('owner:a', 'r1').reason).toBe('expired')
    cache.invalidate('owner:a')
    expect(cache.lookup('owner:a', 'r1').reason).toBe('miss')
    expect(cache.stats()).toEqual({ entries: 0, hits: 2, misses: 4, expired: 1, revisionChanges: 1 })
  })

  it('snapshot cache 在相同 scope/revision 复用、刷新 TTL，版本变化或失效时重建', () => {
    let now = 0
    let builds = 0
    const cache = new RagSnapshotCache({ ttlMs: 100, now: () => now })
    const create = () => ({ generation: ++builds })

    expect(cache.getOrCreate('owner:a', 'r1', create)).toEqual({
      value: { generation: 1 }, hit: false, reason: 'miss',
    })
    now = 90
    expect(cache.getOrCreate('owner:a', 'r1', create)).toEqual({
      value: { generation: 1 }, hit: true, reason: 'hit',
    })
    now = 180
    expect(cache.getOrCreate('owner:a', 'r1', create)).toEqual({
      value: { generation: 1 }, hit: true, reason: 'hit',
    })
    expect(cache.getOrCreate('owner:a', 'r2', create).reason).toBe('revision-changed')
    expect(cache.getOrCreate('owner:b', 'r2', create).value).toEqual({ generation: 3 })
    cache.invalidate('owner:a')
    expect(cache.getOrCreate('owner:a', 'r2', create).reason).toBe('miss')
    expect(builds).toBe(4)
  })

  it('服务复用同一 scope/revision 的索引，并在来源 revision 更新后重建再查询', async () => {
    const loads: string[] = []
    const builds: string[] = []
    const searches: string[] = []
    const engine: RagServiceEngine = {
      async buildAndIndex(revision: string, _batch: RagSourceBatch) {
        builds.push(revision)
        return ok({ revision, document_count: 1, estimated_bytes: 20, vector_count: 0, vector_version: '' })
      },
      async unifiedSearch(revision: string, query: string) {
        searches.push(`${revision}:${query}`)
        return ok({ revision, results: [], has_more: false, diagnostics: { candidate_count: 0, accepted_count: 0, rejected_duplicate: 0, rejected_parent: 0, rejected_source: 0, rejected_similarity: 0, output_chars: 0 } })
      },
    }
    const service = new TsRagService(async context => {
      loads.push(context.revision)
      return { memory: [{ id: context.revision }] }
    }, engine)
    const context = { scopeKey: 'owner:a', revision: 'r1' }

    expect((await service.search(context, 'first')).built).toBe(true)
    expect((await service.search(context, 'second')).built).toBe(false)
    expect((await service.search({ ...context, revision: 'r2' }, 'third')).built).toBe(true)
    expect(loads).toEqual(['r1', 'r2'])
    expect(builds).toEqual(['r1', 'r2'])
    expect(searches).toEqual(['r1:first', 'r1:second', 'r2:third'])
    expect(service.size()).toBe(1)
  })

  it('单个可变索引拒绝跨 scope 复用，避免缓存把 owner 内容串给另一用户', async () => {
    const engine: RagServiceEngine = {
      async buildAndIndex(revision) { return ok({ revision, document_count: 0, estimated_bytes: 0, vector_count: 0, vector_version: '' }) },
      async unifiedSearch(revision) { return ok({ revision, results: [], has_more: false, diagnostics: {} }) },
    }
    const service = new TsRagService(async () => ({}), engine)
    await service.search({ scopeKey: 'owner:a', revision: 'r1' }, 'query')
    await expect(service.search({ scopeKey: 'owner:b', revision: 'r1' }, 'query')).rejects.toThrow('不允许跨 scope')
  })

  it('索引构建失败不会被解释为空结果或留下可复用缓存，重试会重新加载', async () => {
    let builds = 0
    let searches = 0
    let loads = 0
    const engine: RagServiceEngine = {
      async buildAndIndex(revision) {
        builds += 1
        if (builds === 2) return { status: 'error', code: 'worker_failure', message: '索引写入失败' }
        return ok({ revision, document_count: 0, estimated_bytes: 0, vector_count: 0, vector_version: '' })
      },
      async unifiedSearch(revision) {
        searches += 1
        return ok({ revision, results: [], has_more: false, diagnostics: {} })
      },
    }
    const service = new TsRagService(async () => { loads += 1; return {} }, engine)
    await service.search({ scopeKey: 'owner:a', revision: 'r1' }, 'first')
    await expect(service.search({ scopeKey: 'owner:a', revision: 'r2' }, 'second')).rejects.toThrow('TS RAG 构建索引失败')
    await service.search({ scopeKey: 'owner:a', revision: 'r2' }, 'retry')

    expect({ builds, searches, loads }).toEqual({ builds: 3, searches: 2, loads: 3 })
  })

  it('不接受缺少 scope/revision，且召回错误不会变成成功的空列表', async () => {
    const engine: RagServiceEngine = {
      async buildAndIndex(revision) { return ok({ revision, document_count: 0, estimated_bytes: 0, vector_count: 0, vector_version: '' }) },
      async unifiedSearch() { return { status: 'error', code: 'worker_failure', message: '查询不可用' } },
    }
    const service = new TsRagService(async () => ({}), engine)
    await expect(service.search({ scopeKey: '', revision: 'r1' }, 'query')).rejects.toThrow('scopeKey')
    await expect(service.search({ scopeKey: 'owner:a', revision: '' }, 'query')).rejects.toThrow('revision')
    await expect(service.search({ scopeKey: 'owner:a', revision: 'r1' }, 'query')).rejects.toThrow('TS RAG 召回失败')
  })
})
