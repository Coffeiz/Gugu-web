import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { registerAdminEmbeddingRebuildRoutes, createAdminEmbeddingRebuildRuntime } from '../../src/modules/admin/embedding-rebuild.js'

const ownerA = '00000000-0000-4000-8000-000000000201'
const ownerB = '00000000-0000-4000-8000-000000000202'

test('Admin embedding rebuild requires authorization and refuses an unavailable Node RAG consumer', async () => {
  const app = createApp({ appName: '合成应用', isReady: async () => true,
    adminAuth: {
      registerRoutes() {}, async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '未授权' })
      },
    },
    adminEmbeddingRebuild: {
      state: { available: () => true },
      canStart: () => false,
      runtime: { async start() { started++; return { ok: true, message: 'started' } }, async close() {} },
    },
  })
  let started = 0
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/config/embedding-rebuild' })).statusCode, 401)
    const unavailable = await app.inject({ method: 'POST', url: '/api/v1/admin/config/embedding-rebuild', headers: { authorization: 'admin' } })
    assert.equal(unavailable.statusCode, 503)
    assert.deepEqual(unavailable.json(), { detail: 'Node RAG Worker 未就绪' })
    assert.equal(started, 0)
  } finally { await app.close() }
})

test('Admin rebuild queues eligible owners, waits for persisted per-owner outcomes, and exposes aggregate counts only', async () => {
  const ownerStates = new Map<string, Record<string, unknown>>()
  let globalState: Record<string, unknown> | null = null
  let locked = false
  const runtime = createAdminEmbeddingRebuildRuntime({
    state: {
      available: () => true,
      async read() { return globalState },
      async acquire() { if (locked) return false; locked = true; return true },
      async write(value) { globalState = value as Record<string, unknown> },
      async release() { locked = false },
    },
    async listOwners() { return [ownerA, ownerB] },
    async resolve(owner) { return owner === ownerA ? { provider: 'synthetic', model: 'embed-a' } : null },
    async startOwner(owner) {
      ownerStates.set(owner, { status: 'running' })
      return { ok: true, message: 'started' }
    },
    async readOwner(owner) { return ownerStates.get(owner) ?? { status: 'idle' } },
    async wait() {
      ownerStates.set(ownerA, { status: 'done', pattern_vectors: 3, memory_vectors: 2, with_patterns: 1, failed_users: 0 })
    },
    now: () => 1_700_000_000_000,
  })
  const app = Fastify()
  registerAdminEmbeddingRebuildRoutes(app, {
    requireAdmin: async () => undefined,
    state: { available: () => true },
    canStart: () => true,
    runtime,
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/config/embedding-rebuild' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, message: '重建已启动，共 2 个用户', total: 2 })
    for (let attempt = 0; attempt < 20 && globalState?.status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(globalState, {
      status: 'error', done: 2, total: 2, pattern_vectors: 3, memory_vectors: 2,
      with_patterns: 1, failed_users: 1, rag_failed_users: 0, message: '重建完成：pattern 3 条，memory 2 块；失败用户 1 个',
      tag: 'synthetic:embed-a:default', ts: 1_700_000_000,
    })
    assert.equal(JSON.stringify(globalState).includes(ownerA), false)
    assert.equal(JSON.stringify(globalState).includes(ownerB), false)
  } finally { await app.close() }
})

test('Admin rebuild rejects duplicate batches and reports missing embedding configuration without starting owners', async () => {
  let globalState: Record<string, unknown> | null = { status: 'running', done: 1, total: 2 }
  let started = 0
  const runtime = createAdminEmbeddingRebuildRuntime({
    state: {
      available: () => true,
      async read() { return globalState },
      async acquire() { return true },
      async write(value) { globalState = value as Record<string, unknown> },
      async release() {},
    },
    async listOwners() { return [ownerA] },
    async resolve() { return null },
    async startOwner() { started++; return { ok: true, message: 'started' } },
    async readOwner() { return { status: 'done' } },
    async wait() {},
    now: () => 1_700_000_000_000,
  })
  assert.deepEqual(await runtime.start(), { ok: false, message: '已有重建任务在跑', status: globalState })
  globalState = null
  assert.deepEqual(await runtime.start(), { ok: false, message: '请先启用并配置 embedding 模型（平台配置或用户 BYOK 凭据至少其一）' })
  assert.equal(started, 0)
  await runtime.close()
})

test('A per-owner RAG failure remains separate from vector rebuild failures in the shared admin status', async () => {
  let globalState: Record<string, unknown> | null = null
  let locked = false
  let ownerState: Record<string, unknown> = { status: 'running' }
  const runtime = createAdminEmbeddingRebuildRuntime({
    state: {
      available: () => true,
      async read() { return globalState },
      async acquire() { if (locked) return false; locked = true; return true },
      async write(value) { globalState = value as Record<string, unknown> },
      async release() { locked = false },
    },
    async listOwners() { return [ownerA] },
    async resolve() { return { provider: 'synthetic', model: 'embed-a' } },
    async startOwner() { return { ok: true, message: 'started' } },
    async readOwner() { return ownerState },
    async wait() { ownerState = { status: 'error', failed_users: 0, message: '重建完成；RAG 索引失败' } },
    now: () => 1_700_000_000_000,
  })
  try {
    assert.deepEqual(await runtime.start(), { ok: true, message: '重建已启动，共 1 个用户', total: 1 })
    for (let attempt = 0; attempt < 20 && globalState?.status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(globalState?.status, 'error')
    assert.equal(globalState?.failed_users, 0)
    assert.equal(globalState?.rag_failed_users, 1)
  } finally { await runtime.close() }
})
