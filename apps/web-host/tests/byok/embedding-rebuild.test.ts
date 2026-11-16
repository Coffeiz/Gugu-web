import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerEmbeddingRebuildRoute, createUserEmbeddingRebuildRuntime, createRedisUserEmbeddingRebuildState } from '../../src/modules/byok/embedding-rebuild.js'
import type { ScheduledTaskRedisCommands } from '../../src/modules/scheduled-tasks/persistence/redis-lease.js'

const owner = '00000000-0000-4000-8000-000000000101'
const foreignOwner = '00000000-0000-4000-8000-000000000103'

test('BYOK 向量重建路由要求认证并且 owner 只来自可信身份', async () => {
  const app = Fastify()
  const started: string[] = []
  registerEmbeddingRebuildRoute(app, {
    requireUser: async (request, reply) => {
      if (request.headers.authorization !== 'user') return reply.code(401).send({ detail: '未授权' })
    },
    ownerIdFromRequest: () => owner,
    state: { available: () => true },
    canStart: () => true,
    start: async id => { started.push(id); return { ok: true, message: '重建已启动' } },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/byok/embedding-rebuild', payload: { user_id: 'foreign' } })).statusCode, 401)
    assert.deepEqual(started, [])
    const response = await app.inject({ method: 'POST', url: '/api/v1/byok/embedding-rebuild?user_id=foreign', headers: { authorization: 'user' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, message: '重建已启动' })
    assert.deepEqual(started, [owner])
  } finally { await app.close() }
})

test('RAG 持久任务无 Node Worker 消费者时返回 503 且不入队', async () => {
  const app = Fastify()
  let calls = 0
  registerEmbeddingRebuildRoute(app, {
    requireUser: async () => undefined,
    ownerIdFromRequest: () => owner,
    state: { available: () => true },
    canStart: () => false,
    start: async () => { calls += 1; return { ok: true, message: 'unexpected' } },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/byok/embedding-rebuild' })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { detail: 'Node RAG Worker 未就绪' })
    assert.equal(calls, 0)
  } finally { await app.close() }
})

test('BYOK 重建按 owner 互斥、同 owner 重复启动返回运行状态，Host 关闭会取消任务并释放租约', async () => {
  const values = new Map<string, string>()
  const locks = new Map<string, string>()
  const state = {
    available: () => true,
    async read(id: string) { return JSON.parse(values.get(`emb:rebuild:user:${id}`) || '{"status":"idle"}') },
    async acquire(id: string, token: string) {
      if (locks.has(id)) return false
      locks.set(id, token)
      return true
    },
    async write(id: string, value: unknown) { values.set(`emb:rebuild:user:${id}`, JSON.stringify(value)) },
    async release(id: string, token: string) { if (locks.get(id) === token) locks.delete(id) },
  }
  const observedSignals: AbortSignal[] = []
  const runtime = createUserEmbeddingRebuildRuntime({
    state,
    resolve: async () => ({ provider: 'openai', baseUrl: 'https://provider.invalid/v1', model: 'embed-test', apiKey: 'synthetic', dimensions: 0 }),
    now: () => 1_700_000_000_000,
    rebuild: async (_id, _settings, signal) => {
      observedSignals.push(signal)
      return await new Promise<{ patternVectors: number; memoryVectors: number }>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })

  assert.deepEqual(await runtime.start(owner), { ok: true, message: '重建已启动' })
  assert.deepEqual(await runtime.start(foreignOwner), { ok: true, message: '重建已启动' })
  const duplicate = await runtime.start(owner)
  assert.equal(duplicate.ok, false)
  assert.deepEqual(duplicate.status, { status: 'running', ts: 1_700_000_000 })
  await runtime.close()
  assert.deepEqual(observedSignals.map(signal => signal.aborted), [true, true])
  assert.equal(locks.has(owner), false)
  assert.equal(locks.has(foreignOwner), false)
  assert.equal((JSON.parse(values.get(`emb:rebuild:user:${owner}`) || '{}') as { status: string }).status, 'error')
})

test('Redis 状态与锁使用旧 Worker owner 键并设置 token 比较释放', async () => {
  const commands: Array<{ command: string; args: unknown[] }> = []
  const redis: ScheduledTaskRedisCommands = {
    async set(...args: [string, string, ...string[]]) { commands.push({ command: 'set', args }); return 'OK' },
    async eval(...args: [string, number, ...string[]]) { commands.push({ command: 'eval', args }); return 1 },
    async exists(...args: [string]) { commands.push({ command: 'exists', args }); return 1 },
  }
  const state = createRedisUserEmbeddingRebuildState(redis)
  await state.acquire(owner, 'synthetic-token')
  await state.write(owner, { status: 'running' })
  await state.release(owner, 'synthetic-token')
  assert.deepEqual(commands.map(item => item.command), ['set', 'set', 'eval'])
  assert.deepEqual(commands[0]!.args.slice(0, 2), [`emb:rebuild:user:${owner}:lock`, 'synthetic-token'])
  assert.deepEqual(commands[0]!.args.slice(-3), ['EX', '3600', 'NX'])
  assert.equal(commands[1]!.args[0], `emb:rebuild:user:${owner}`)
  assert.equal(String(commands[2]!.args[0]).includes("redis.call('GET',KEYS[1])==ARGV[1]"), true)
})
