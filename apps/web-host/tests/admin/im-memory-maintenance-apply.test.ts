import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { scopeRevision } from '@gugu/core/im-memory-maintenance-batches'
import {
  createImMemoryMaintenanceApplier, ImMemoryMaintenanceApplyError,
  IM_MEMORY_MODEL_PREVIEW_KEY, IM_MEMORY_MODEL_PREVIEW_PLAN_KEY,
  registerImMemoryMaintenanceApplyRoute,
} from '../../src/modules/admin/im-memory-maintenance-apply.js'

const current = { profile: {}, summary: {}, daily: '', memory: '', members: {} }
const scope = (scope_id: string) => ({ owner_user_id: '00000000-0000-0000-0000-000000000001', platform: 'qq', bot_id: 'synthetic-bot', scope_type: 'group' as const, scope_id })
const plan = (scope_id: string, revision = scopeRevision(current, [], '')) => ({ ...scope(scope_id), first_message_id: 0, last_message_id: 0, source_message_ids: [], source_revision: revision, output: { daily: `合成记录 ${scope_id}` } })

test('apply requires confirmation and preserves Python missing, running and failed-preview errors', async () => {
  const data = new Map<string, string>()
  const applier = createImMemoryMaintenanceApplier({
    state: { async get(key) { return data.get(key) ?? null }, async delete(key) { data.delete(key) } },
    async messages() { return [] }, async isTombstoned() { return false }, storage: { async read() { return null }, async write() {} }, now: () => 100,
  })
  await assert.rejects(applier(false), (error: unknown) => error instanceof ImMemoryMaintenanceApplyError && error.statusCode === 400 && /confirm=true/u.test(error.message))
  await assert.rejects(applier(true), (error: unknown) => error instanceof ImMemoryMaintenanceApplyError && /没有可执行/u.test(error.message))
  data.set(IM_MEMORY_MODEL_PREVIEW_KEY, JSON.stringify({ status: 'running' }))
  data.set(IM_MEMORY_MODEL_PREVIEW_PLAN_KEY, '[]')
  await assert.rejects(applier(true), (error: unknown) => error instanceof ImMemoryMaintenanceApplyError && /尚未完成/u.test(error.message))
  data.set(IM_MEMORY_MODEL_PREVIEW_KEY, JSON.stringify({ status: 'done', plan_ready: false }))
  await assert.rejects(applier(true), (error: unknown) => error instanceof ImMemoryMaintenanceApplyError && /失败或超长/u.test(error.message))
})

test('all scope revisions are checked before writing and stale plans remain available', async () => {
  const data = new Map<string, string>([
    [IM_MEMORY_MODEL_PREVIEW_KEY, JSON.stringify({ status: 'done', plan_ready: true })],
    [IM_MEMORY_MODEL_PREVIEW_PLAN_KEY, JSON.stringify([plan('g1'), plan('g2', 'stale')])],
  ])
  const writes: string[] = []
  const applier = createImMemoryMaintenanceApplier({
    state: { async get(key) { return data.get(key) ?? null }, async delete(key) { data.delete(key) } },
    async messages() { return [] }, async isTombstoned() { return false }, storage: { async read() { return null }, async write(key) { writes.push(key) } }, now: () => 100,
  })
  await assert.rejects(applier(true), (error: unknown) => error instanceof ImMemoryMaintenanceApplyError && error.statusCode === 409 && /预览已过期/u.test(error.message))
  assert.deepEqual(writes, [])
  assert.ok(data.has(IM_MEMORY_MODEL_PREVIEW_PLAN_KEY))
})

test('valid confirmed plan is applied through Core rules and deleted after Local writes', async () => {
  const data = new Map<string, string>([
    [IM_MEMORY_MODEL_PREVIEW_KEY, JSON.stringify({ status: 'done', plan_ready: true })],
    [IM_MEMORY_MODEL_PREVIEW_PLAN_KEY, JSON.stringify([plan('g1')])],
  ])
  const writes: Array<[string, string]> = []
  const applier = createImMemoryMaintenanceApplier({
    state: { async get(key) { return data.get(key) ?? null }, async delete(key) { data.delete(key) } },
    async messages() { return [] }, async isTombstoned() { return false }, storage: { async read() { return null }, async write(key, value) { writes.push([key, value]) } }, now: () => 100,
  })
  assert.deepEqual(await applier(true), { ok: true, applied: 1, queued: 1 })
  assert.deepEqual(writes, [[
    '00000000-0000-0000-0000-000000000001/.agent/im/qq/synthetic-bot/groups/g1/daily.md',
    '## 1970-01-01\n- 合成记录 g1\n',
  ]])
  assert.equal(data.has(IM_MEMORY_MODEL_PREVIEW_PLAN_KEY), false)
})

test('apply route keeps Admin auth in front of DTO handling and maps business errors', async () => {
  const app = Fastify()
  registerImMemoryMaintenanceApplyRoute(app, {
    requireAdmin: async (request, reply) => { if (request.headers.authorization !== 'synthetic-admin') return reply.code(401).send({ detail: '需要管理员身份' }) },
    async apply(confirm) { if (confirm !== true) throw new ImMemoryMaintenanceApplyError(400, '执行 IM 记忆维护需要 confirm=true'); return { ok: true, applied: 0, queued: 0 } },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/agent/memory/im-scopes/maintenance/apply', payload: { confirm: true } })).statusCode, 401)
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/memory/im-scopes/maintenance/apply', headers: { authorization: 'synthetic-admin' }, payload: { confirm: false } })
    assert.equal(rejected.statusCode, 400)
    assert.deepEqual(rejected.json(), { detail: '执行 IM 记忆维护需要 confirm=true' })
  } finally { await app.close() }
})
