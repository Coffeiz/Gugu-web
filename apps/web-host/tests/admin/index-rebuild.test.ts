import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createAdminIndexRebuildRuntime } from '../../src/modules/admin/index-rebuild.js'
import { registerAdminIndexRebuildRoute } from '../../src/modules/admin/index-rebuild.js'

const ownerA = '00000000-0000-4000-8000-000000000301'
const ownerB = '00000000-0000-4000-8000-000000000302'

test('Admin index rebuild requires authorization and refuses to start without the Node consumer', async () => {
  let started = 0
  const app = createApp({ appName: '合成应用', isReady: async () => true,
    adminAuth: {
      registerRoutes() {}, async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '未授权' })
      },
    },
    adminIndexRebuild: {
      available: () => true,
      canStart: () => false,
      runtime: { async start() { started++; return { ok: true } }, async close() {} },
    },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/config/index-rebuild' })).statusCode, 401)
    const unavailable = await app.inject({ method: 'POST', url: '/api/v1/admin/config/index-rebuild', headers: { authorization: 'admin' } })
    assert.equal(unavailable.statusCode, 503)
    assert.deepEqual(unavailable.json(), { detail: '索引重建 Worker 未就绪' })
    assert.equal(started, 0)
  } finally { await app.close() }
})

test('Admin index rebuild reprojects each owner and source, continues after a source failure, and reports aggregate progress', async () => {
  let globalState: Record<string, unknown> | null = null
  let locked = false
  const progress = new Map<string, { generation: number; completedGeneration: number; status: string }>()
  const enqueued: string[] = []
  let currentKey = ''
  let clock = 1_700_000_000_000
  const runtime = createAdminIndexRebuildRuntime({
    state: {
      available: () => true,
      async read() { return globalState },
      async acquire() { if (locked) return false; locked = true; return true },
      async write(value) { globalState = value as Record<string, unknown> },
      async release() { locked = false },
    },
    async listOwners() { return [ownerA, ownerB] },
    sourceTypes: ['memory', 'project'],
    async enqueue(owner, source) {
      enqueued.push(`${owner}:${source}`)
      const key = `${owner}:${source}`
      const prior = progress.get(key)?.generation ?? 0
      progress.set(key, { generation: prior + 1, completedGeneration: prior, status: 'queued' })
    },
    async readProgress(owner, source) {
      currentKey = `${owner}:${source}`
      return progress.get(currentKey) ?? null
    },
    async countDocuments(owner) { return owner === ownerA ? 1 : 2 },
    async wait() {
      clock += 1_000
      const key = currentKey
      const previous = progress.get(key)!
      if (key === `${ownerA}:project`) progress.set(key, { ...previous, status: 'retrying' })
      else progress.set(key, { ...previous, completedGeneration: previous.generation, status: 'ready' })
    },
    now: () => clock,
    sourceTimeoutMs: 1_000,
  })
  const app = Fastify()
  registerAdminIndexRebuildRoute(app, {
    requireAdmin: async () => undefined,
    available: () => true,
    canStart: () => true,
    runtime,
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/config/index-rebuild' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, message: '索引重建已启动，共 2 个用户', total: 2 })
    for (let attempt = 0; attempt < 30 && globalState?.status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(enqueued, [
      `${ownerA}:memory`, `${ownerA}:project`, `${ownerB}:memory`, `${ownerB}:project`,
    ])
    assert.deepEqual(globalState, {
      status: 'error', done: 2, total: 2, documents: 3, failed_users: 1, failed_sources: 1,
      message: '索引重建完成：3 条文档；失败用户 1 个，失败来源 1 个', ts: 1_700_000_004,
    })
  } finally { await app.close() }
})

test('Admin index rebuild rejects an existing batch and reports no eligible users without enqueuing work', async () => {
  let globalState: Record<string, unknown> | null = { status: 'running', done: 1, total: 2 }
  let enqueued = 0
  const runtime = createAdminIndexRebuildRuntime({
    state: {
      available: () => true,
      async read() { return globalState },
      async acquire() { return true },
      async write(value) { globalState = value as Record<string, unknown> },
      async release() {},
    },
    async listOwners() { return [] }, sourceTypes: ['project'],
    async enqueue() { enqueued++ }, async readProgress() { return null }, async wait() {},
    now: () => 1_700_000_000_000,
  })
  assert.deepEqual(await runtime.start(), { ok: false, message: '已有索引重建任务在跑', status: globalState })
  globalState = null
  assert.deepEqual(await runtime.start(), { ok: true, message: '索引重建已启动，共 0 个用户', total: 0 })
  for (let attempt = 0; attempt < 20 && globalState?.status === 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(globalState, {
    status: 'done', done: 0, total: 0, documents: 0, failed_users: 0, failed_sources: 0,
    message: '索引重建完成：0 条文档', ts: 1_700_000_000,
  })
  assert.equal(enqueued, 0)
  await runtime.close()
})
