import { describe, expect, it, vi } from 'vitest'
import { createMemorySearch } from '../../../src/agent/rag/memory-search.js'
import { createMemorySearchTool } from '../../../src/agent/tools/memory.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { prepareMemory, type MemoryRagStorageReader } from '../../../src/agent/rag/memory-loader.js'
import { configureRagJieba } from '../../../src/agent/rag/tokenizer.js'

configureRagJieba({ cut: text => [text] })

const owner = 'f17421a3-8520-4c8b-92e5-736882f4bd82'
const other = '08a80873-5266-43b9-a27c-d288b602a9cb'
const identity = { ownerId: owner, sessionId: '11', runId: 'memory-search' }
const parent = 'memory:profile:profile:0'
const store: MemoryRagStorageReader = {
  async readText({ key }) {
    if (key === `${owner}/.agent/rag/memory/index.json`) return JSON.stringify({ schema_version: 1, documents: [
      { document_id: parent, parent_document_id: parent, chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '用户画像', summary: 'coffee', content: 'coffee after lunch',
        version: 'v1', scope: { owner_user_id: owner, scope_type: 'owner', scope_id: '' }, metadata: {} },
      { document_id: 'foreign', parent_document_id: 'foreign', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '不应读取', content: 'foreign coffee', version: 'v1',
        scope: { owner_user_id: other, scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] })
    if (key === `${owner}/.agent/memory_vec.json`) return JSON.stringify({
      'rag:memory:profile:profile:0:v1:0': { v: [1, 0], t: 'test-embedding-v1' },
    })
    return null
  },
}

function createFixture() {
  let allowed = true
  const authorize = vi.fn(async () => allowed)
  const service = createMemorySearch({
    async resolveScopes(runIdentity, requested) {
      expect(requested).toBe('auto')
      return [{ ownerId: runIdentity.ownerId, type: 'owner', id: runIdentity.ownerId }]
    },
    authorize,
    async snapshot() { return { revision: 'snapshot-1', text: '' } },
    storage() { return store },
    scopeState: { async getMemoryScopeState() { return { revision: 'unused', tombstoned: false } } },
  })
  const registry = createToolRegistry({
    groups: [{ id: 'memory', name: '记忆', tools: [createMemorySearchTool({ search: service })] }],
    authorize: async () => allowed,
  })
  return {
    registry,
    setAllowed(value: boolean) { allowed = value },
    authorize,
    async dispatch(input: unknown) {
      return registry.tools.dispatch({ id: 'search', name: 'search_memory', input }, {
        identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
        execute: async () => { throw new Error('不应执行命令') },
      })
    },
  }
}

describe('search_memory 经 Core RAG 和实际工具 dispatch', () => {
  it('加载隔离 owner 记忆、按 BM25 返回 Python 工具结果主字段，并忽略伪造授权身份', async () => {
    const fixture = createFixture()
    const result = await fixture.dispatch({ query: 'coffee', source: 'profile', owner_id: other, group_id: 'forged' })
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false, value: {
      query: 'coffee', has_more: false, candidate_count: 1, engine: 'typescript', strategy: 'bm25',
      fallback_reason: 'embedding_disabled',
      results: [{ source_id: 'profile', text: expect.stringContaining('coffee after lunch') }],
    } })
    expect(JSON.stringify(result)).not.toContain('foreign coffee')
    expect(fixture.authorize).toHaveBeenCalledTimes(2)
    if (result.kind === 'completed') expect(result.value).toHaveProperty('ignored_fields', ['[未声明字段]', 'owner_id'])
    if (result.kind === 'completed') {
      const row = (result.value as { results: Array<Record<string, unknown>> }).results[0]!
      expect(row).toMatchObject({ source: 'memory', source_id: 'profile', title: '用户画像', summary: 'coffee',
        text: '用户画像\ncoffee after lunch', version: 'v1', document_version: 'v1',
        citation: { source_type: 'memory', source_id: 'profile', title: '用户画像', version: 'v1' } })
      expect(row.chunk_id).toBe(`${parent}:v1:0`)
      expect(row.content_hash).toMatch(/^[a-f0-9]{64}$/u)
      expect(row.confidence).toEqual(expect.any(Number))
    }
  })

  it('非法范围不调用查询；撤销授权发生在召回期间时不返回命中正文', async () => {
    const fixture = createFixture()
    expect(await fixture.dispatch({ query: 'coffee', scope: 'cross_user' })).toMatchObject({ successful: false, executed: false })
    fixture.authorize.mockImplementationOnce(async () => true).mockImplementationOnce(async () => false)
    const revoked = await fixture.dispatch({ query: 'coffee' })
    expect(revoked).toMatchObject({ successful: false, value: { error: 'RAG 检索授权已撤销' } })
    expect(JSON.stringify(revoked)).not.toContain('coffee after lunch')
  })

  it('使用 owner 索引中的版本匹配向量执行混合召回', async () => {
    const prepared = await prepareMemory({ ownerId: owner,
      scopes: [{ ownerId: owner, type: 'owner', id: owner }], sourceFilter: 'all',
      snapshotRevision: 'snapshot-1', snapshotText: '', vectorVersion: 'test-embedding-v1' },
    { async getMemoryScopeState() { return { revision: 'unused', tombstoned: false } } }, store)
    expect(Object.keys(prepared.vectors)).toEqual(['memory:memory:profile:profile:0:0'])
    const service = createMemorySearch({
      async resolveScopes(runIdentity) {
        return [{ ownerId: runIdentity.ownerId, type: 'owner', id: runIdentity.ownerId }]
      },
      async authorize() { return true },
      async snapshot() { return { revision: 'snapshot-1', text: '' } },
      storage() { return store },
      scopeState: { async getMemoryScopeState() { return { revision: 'unused', tombstoned: false } } },
      async vectors() { return { version: 'test-embedding-v1', async embed() { return [1, 0] } } },
    })
    const registry = createToolRegistry({
      groups: [{ id: 'memory', name: '记忆', tools: [createMemorySearchTool({ search: service })] }],
      async authorize() { return true },
    })
    const result = await registry.tools.dispatch({ id: 'vector-search', name: 'search_memory', input: { query: 'coffee' } }, {
      identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不应执行命令') },
    })
    expect(result).toMatchObject({ kind: 'completed', successful: true, value: {
      strategy: 'hybrid', fallback_reason: null,
      results: [{ source_id: 'profile', text: expect.stringContaining('coffee after lunch') }],
    } })
  })

  it('显式 BM25 标记 lexical_only；有 embedding 但无匹配向量时标记缓存不可用', async () => {
    const fixture = createFixture()
    const bm25 = await fixture.dispatch({ query: 'coffee', strategy: 'bm25' })
    expect(bm25).toMatchObject({ successful: true, value: { strategy: 'bm25', fallback_reason: 'lexical_only' } })

    const service = createMemorySearch({
      async resolveScopes(runIdentity) { return [{ ownerId: runIdentity.ownerId, type: 'owner', id: runIdentity.ownerId }] },
      async authorize() { return true },
      async snapshot() { return { revision: 'snapshot-1', text: '' } },
      storage() { return { async readText() { return JSON.stringify({ schema_version: 1, documents: [
        { document_id: 'memory:uncached:0', parent_document_id: 'memory:uncached', chunk_index: 0, chunk_count: 1,
          source_type: 'memory', source_id: 'uncached', title: '其他记忆', content: 'coffee can be searched lexically', version: 'v1',
          scope: { owner_user_id: owner, scope_type: 'owner', scope_id: '' }, metadata: {} },
      ] }) } } },
      scopeState: { async getMemoryScopeState() { return { revision: 'unused', tombstoned: false } } },
      async vectors() { return { version: 'test-embedding-v1', async embed() { return [1, 0] } } },
    })
    const registry = createToolRegistry({
      groups: [{ id: 'memory', name: '记忆', tools: [createMemorySearchTool({ search: service })] }],
      async authorize() { return true },
    })
    const result = await registry.tools.dispatch({ id: 'uncached', name: 'search_memory', input: { query: 'coffee' } }, {
      identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不应执行命令') },
    })
    expect(result).toMatchObject({ successful: true, value: { strategy: 'bm25', fallback_reason: 'embedding_cache_unavailable' } })
  })

  it('query embedding 失败仍返回授权范围内的 BM25 命中并标记降级', async () => {
    const service = createMemorySearch({
      async resolveScopes(runIdentity) { return [{ ownerId: runIdentity.ownerId, type: 'owner', id: runIdentity.ownerId }] },
      async authorize() { return true },
      async snapshot() { return { revision: 'snapshot-1', text: '' } },
      storage() { return store },
      scopeState: { async getMemoryScopeState() { return { revision: 'unused', tombstoned: false } } },
      async vectors() { return { version: 'test-embedding-v1', async embed() { throw new Error('synthetic provider failure') } } },
    })
    const registry = createToolRegistry({
      groups: [{ id: 'memory', name: '记忆', tools: [createMemorySearchTool({ search: service })] }],
      async authorize() { return true },
    })
    const result = await registry.tools.dispatch({ id: 'failed-embedding', name: 'search_memory', input: { query: 'coffee' } }, {
      identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不应执行命令') },
    })
    expect(result).toMatchObject({ successful: true, value: {
      strategy: 'bm25', fallback_reason: 'embedding_cache_unavailable',
      results: [{ source_id: 'profile', text: expect.stringContaining('coffee after lunch') }],
    } })
    expect(JSON.stringify(result)).not.toContain('synthetic provider failure')
  })

  it('空关键词和非法上限遵循工具边界验证', async () => {
    const fixture = createFixture()
    expect(await fixture.dispatch({ query: '   ' })).toMatchObject({ successful: true, value: { query: '', results: [], has_more: false } })
    expect(await fixture.dispatch({ query: 'coffee', limit: 26 })).toMatchObject({ successful: false, executed: false })
  })
})
