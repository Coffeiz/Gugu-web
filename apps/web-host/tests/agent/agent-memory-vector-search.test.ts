import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createAgentMemoryContextLoader } from '../../src/modules/agent-sessions/memory-context.js'
import { createAgentMemoryVectorSearchFactory } from '../../src/modules/agent-sessions/memory-vector-search.js'
import { createPostgresAgentRagEmbeddingPort } from '../../src/domains/agent-sessions/tools/agent-rag-vectors.js'

test('Agent context uses owner-scoped persisted vectors and the configured embedding model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-memory-vector-search-'))
  const owner = randomUUID(), other = randomUUID()
  const patterns = Array.from({ length: 51 }, (_, index) => ({
    id: `pattern-${index}`, text: `pattern ${index}`, kind: 'observed', conf: 0.9, imp: 3, ts: 100,
  }))
  const modelTag = 'synthetic:embedding-v1:2'
  const sqlOwners: unknown[][] = []
  let requestedUrl = '', requestedAuth = '', decryptCalls = 0, gateCalls = 0
  try {
    for (const id of [owner, other]) await mkdir(join(root, id, '.agent'), { recursive: true })
    await writeFile(join(root, owner, '.agent', 'pattern.json'), JSON.stringify(patterns))
    await writeFile(join(root, owner, '.agent', 'pattern_vec.json'), JSON.stringify({
      'pattern-50': { t: modelTag, v: [0, 1] },
      ...Object.fromEntries(patterns.slice(0, 50).map(row => [row.id, { t: modelTag, v: [1, 0] }])),
    }))
    await writeFile(join(root, other, '.agent', 'pattern_vec.json'), JSON.stringify({
      'pattern-50': { t: modelTag, v: [1, 0] },
    }))

    const embedding = createPostgresAgentRagEmbeddingPort({
      async query(_sql: string, values: unknown[]) {
        sqlOwners.push(values)
        return { rows: [{ provider: 'synthetic', base_url: 'https://embedding.example/v1', model: 'embedding-v1', dimensions: 2,
          encrypted_value: 'cipher', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 1 }] }
      },
    } as unknown as Parameters<typeof createPostgresAgentRagEmbeddingPort>[0], {
      async enabled() { gateCalls += 1; return true },
      async decrypt(row) { decryptCalls += 1; assert.equal(row.encrypted_value, 'cipher'); return 'mock-only' },
      createTransport() {
        return { request: async (request, signal) => {
              signal.throwIfAborted()
              requestedUrl = request.url
              requestedAuth = request.headers.authorization ?? ''
              return { status: 200, headers: {}, body: (async function* () {
                yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [0, 1] }] }))
              })(), cancel: async () => {} }
          } }
      },
    })
    const vectorSearch = createAgentMemoryVectorSearchFactory({ storageRoot: root, embedding })
    const load = createAgentMemoryContextLoader(root, () => 125_000, vectorSearch)
    const result = await load({ ownerId: owner, sessionId: '1' }, new AbortController().signal, 'target query')
    assert.ok(result && typeof result === 'object' && !Array.isArray(result))
    const pattern = (result as Record<string, unknown>).pattern

    assert.deepEqual(sqlOwners, [[owner]])
    assert.equal(decryptCalls, 1)
    assert.equal(gateCalls, 3)
    assert.equal(requestedUrl, 'https://embedding.example/v1/embeddings')
    assert.equal(requestedAuth, 'Bearer mock-only')
    assert.match(String(pattern), /pattern 50/u)
    assert.doesNotMatch(String(pattern), /other/u)
    const ownerBound = vectorSearch(owner)
    await assert.rejects(ownerBound.read(other, 'pattern'), /owner 不匹配/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Agent context keeps lexical memory selection when BYOK embedding is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-memory-vector-fallback-'))
  const owner = randomUUID()
  const patterns = Array.from({ length: 51 }, (_, index) => ({
    id: `pattern-${index}`, text: `pattern ${index}`, kind: 'observed', conf: 0.9, imp: 3, ts: 100,
  }))
  let transportCreated = false
  try {
    await mkdir(join(root, owner, '.agent'), { recursive: true })
    await writeFile(join(root, owner, '.agent', 'pattern.json'), JSON.stringify(patterns))
    const vectorSearch = createAgentMemoryVectorSearchFactory({
      storageRoot: root,
      embedding: {
        async resolve() { return null },
        createTransport() { transportCreated = true; throw new Error('未配置凭据时不能创建 Provider') },
      },
    })
    const load = createAgentMemoryContextLoader(root, () => 125_000, vectorSearch)
    const result = await load({ ownerId: owner, sessionId: '1' }, new AbortController().signal, 'target query')
    assert.ok(result && typeof result === 'object' && !Array.isArray(result))
    const pattern = (result as Record<string, unknown>).pattern
    assert.equal(transportCreated, false)
    assert.match(String(pattern), /pattern 49/u)
    assert.doesNotMatch(String(pattern), /pattern 50/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Agent context cancellation reaches the embedding request instead of degrading to lexical success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-memory-vector-cancel-'))
  const owner = randomUUID()
  const patterns = Array.from({ length: 51 }, (_, index) => ({
    id: `pattern-${index}`, text: `pattern ${index}`, kind: 'observed', conf: 0.9, imp: 3, ts: 100,
  }))
  const controller = new AbortController()
  try {
    await mkdir(join(root, owner, '.agent'), { recursive: true })
    await writeFile(join(root, owner, '.agent', 'pattern.json'), JSON.stringify(patterns))
    const vectorSearch = createAgentMemoryVectorSearchFactory({
      storageRoot: root,
      embedding: {
        async resolve() { return { provider: 'synthetic', baseUrl: 'https://embedding.example/v1', model: 'embedding-v1', apiKey: 'mock-only', dimensions: 2 } },
        createTransport() {
          return { request: async (_request, signal) => {
            controller.abort()
            signal.throwIfAborted()
            throw new Error('transport should observe abort')
          } }
        },
      },
    })
    const load = createAgentMemoryContextLoader(root, () => 125_000, vectorSearch)
    // 每个向量行为用例使用独立 query，避免 Core 成功 embedding 缓存跳过取消测试的 transport。
    await assert.rejects(load({ ownerId: owner, sessionId: '1' }, controller.signal, 'cancel target query'), /abort/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
