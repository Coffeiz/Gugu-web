import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'
import {
  createImMemoryMaintenancePreviewStarter, createImMemoryMaintenancePreviewWorker, createStandaloneImMemoryModelCaller, IM_MEMORY_MODEL_PREVIEW_LOCK_KEY,
  ImMemoryMaintenancePreviewError, registerImMemoryMaintenancePreviewRoute,
} from '../../src/modules/admin/im-memory-maintenance-preview.js'

const stateKey = 'im_memory:maintenance:model_preview'
const planKey = 'im_memory:maintenance:model_preview:plan'

function memoryState(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial)), locks = new Map<string, string>()
  return {
    values, locks,
    async get(key: string) { return values.get(key) ?? null },
    async set(key: string, value: string) { values.set(key, value) },
    async delete(key: string) { values.delete(key) },
    async acquire(key: string, value: string) { if (locks.has(key)) return false; locks.set(key, value); return true },
    async release(key: string, value: string) { if (locks.get(key) === value) locks.delete(key) },
  }
}

test('preview start refuses an active run without deleting its plan or replacing progress', async () => {
  const state = memoryState({ [stateKey]: JSON.stringify({ status: 'running', done: 2 }), [planKey]: '[{"keep":true}]' })
  const start = createImMemoryMaintenancePreviewStarter({ state, async listCursors() { throw new Error('must not enumerate') }, async run() {} })
  assert.deepEqual(await start(), { ok: false, message: '已有模型预览正在运行', status: { status: 'running', done: 2 } })
  assert.equal(state.values.get(planKey), '[{"keep":true}]')
})

test('preview start atomically claims the worker, clears stale plans and publishes only count state', async () => {
  const state = memoryState({ [stateKey]: JSON.stringify({ status: 'done' }), [planKey]: '[{"stale":true}]' })
  const cursors = [{ owner_user_id: 'synthetic-owner', platform: 'qq', bot_id: 'synthetic-bot', scope_type: 'group' as const, scope_id: 'synthetic-group', first_message_id: 0, last_message_id: 0 }]
  let launch: (() => Promise<void>) | undefined
  const start = createImMemoryMaintenancePreviewStarter({ state, async listCursors() { return cursors }, run(rows) { assert.deepEqual(rows, cursors); return new Promise(resolve => { launch = async () => resolve() }) }, now: () => 100 })
  assert.deepEqual(await start(), { ok: true, total: 1 })
  const current = JSON.parse(state.values.get(stateKey)!)
  assert.deepEqual(current, { status: 'running', done: 0, total: 1, needs_review: 0, failed: 0, plan_ready: false, ts: 100 })
  assert.equal(state.values.has(planKey), false)
  assert.ok(state.locks.has(IM_MEMORY_MODEL_PREVIEW_LOCK_KEY))
  await launch?.()
})

test('preview route authenticates first and maps unavailable launch errors', async () => {
  const app = Fastify()
  registerImMemoryMaintenancePreviewRoute(app, {
    requireAdmin: async (request, reply) => { if (request.headers.authorization !== 'synthetic-admin') return reply.code(401).send({ detail: '需要管理员身份' }) },
    async start() { throw new ImMemoryMaintenancePreviewError(503, 'Redis 维护计划服务不可用') },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview' })).statusCode, 401)
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview', headers: { authorization: 'synthetic-admin' } })
    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), { detail: 'Redis 维护计划服务不可用' })
  } finally { await app.close() }
})

test('preview worker stores revisions and plans while progress excludes owner and scope identifiers', async () => {
  const values = new Map<string, string>()
  const progress: Array<Record<string, unknown>> = []
  const cursor = { owner_user_id: 'synthetic-owner', platform: 'qq', bot_id: 'synthetic-bot', scope_type: 'group' as const, scope_id: 'synthetic-group', first_message_id: 3, last_message_id: 4 }
  const worker = createImMemoryMaintenancePreviewWorker({
    state: { async set(key, value) { values.set(key, value); if (key === stateKey) progress.push(JSON.parse(value)) } },
    async listCursors() { return [cursor] },
    async messages() { return [{ id: 4, conversation_seq: 4, role: 'user', content: '合成消息', platform_user_id: 'member-1', platform_user_name: '小北', created_at: new Date('2026-01-01T00:00:00.000Z') }] },
    storage: { async read() { return null } },
    readModelSettings() { return { provider: 'synthetic', model: 'synthetic', context_tokens: 4096, max_tokens: 1000 } },
    async readPrompt() { return '合成提示' },
    async complete(request) { assert.equal(request.system, '合成提示'); return { daily: ['合成记忆'] } },
    now: () => 200,
  })
  await worker([cursor])
  const status = JSON.parse(values.get(stateKey)!)
  const plans = JSON.parse(values.get(planKey)!)
  assert.equal(status.status, 'done')
  assert.equal(status.plan_ready, true)
  assert.equal(status.needs_review, 1)
  assert.equal(status.completed_batches, 1)
  assert.equal(progress[0]?.status, 'running')
  assert.equal(progress[0]?.plan_ready, true)
  assert.doesNotMatch(values.get(stateKey)!, /synthetic-owner|synthetic-group/u)
  assert.equal(plans[0].source_message_ids[0], '4')
  assert.equal(plans[0].source_revision, '2be3592b66aa3f40d3ccbe3f3192fadab37ac6f3070d811e8a8b0022c1cb52f4')
  assert.deepEqual(plans[0].output, { daily: ['合成记忆'] })
})

test('standalone preview caller uses the shared OpenAI driver and closes its injected transport', async () => {
  let captured: ProviderHttpRequest | undefined, closed = false
  const transport: ProviderTransport & { close(): Promise<void> } = {
    async request(request) {
      captured = request
      return {
        status: 200, headers: { 'content-type': 'application/json' },
        body: (async function* () { yield new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: '{"daily":["合成记录"]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } })) })(),
        async cancel() {},
      }
    },
    async close() { closed = true },
  }
  const caller = createStandaloneImMemoryModelCaller({ environment: {}, createTransport: () => transport })
  assert.deepEqual(await caller({ system: '合成系统提示', prompt: '合成用户提示', maxTokens: 128,
    config: { provider: 'qwen', model: 'qwen3-max', api_key: 'synthetic-key', base_url: 'https://provider.synthetic.invalid/v1' } }), { daily: ['合成记录'] })
  assert.equal(captured?.url, 'https://provider.synthetic.invalid/v1/chat/completions')
  assert.equal(captured?.method, 'POST')
  assert.equal(closed, true)
  assert.equal(JSON.stringify(captured?.body).includes('合成系统提示'), true)
  assert.equal(JSON.stringify(captured?.body).includes('合成用户提示'), true)
  assert.equal((captured?.body as Record<string, unknown>).max_tokens, 128)
  assert.deepEqual((captured?.body as Record<string, unknown>).response_format, { type: 'json_object' })
})
