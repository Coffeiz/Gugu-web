import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import {
  AgentPendingQueueConflictError,
  AgentPendingQueueSessionNotFoundError,
  mergePendingQueueItems,
  createPostgresAgentPendingQueuePatch,
  registerAgentPendingQueuePatchRoute,
} from '../../src/domains/agent-sessions/agent-pending-queue-patch.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('PATCH 合并保留历史队列中的非标准 key 项，避免增量更新丢弃已有数据', () => {
  assert.deepEqual(mergePendingQueueItems([
    { text: '历史无 key 项' },
    { key: null, text: '历史空 key 项' },
    { key: 4, text: '待更新', _claim_token: 'lease' },
  ], [{ key: 4, text: '更新' }], []), [
    { text: '历史无 key 项' },
    { key: null, text: '历史空 key 项' },
    { key: 4, text: '更新', _claim_token: 'lease' },
  ])
})

test('PATCH 队列路由先鉴权，拒绝伪造 owner 且不发布内容事件', async () => {
  const app = Fastify()
  registerAgentPendingQueuePatchRoute(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取 owner') },
    async patch() { throw new Error('未认证时不得写队列') },
    async publishChanged() { throw new Error('未认证时不得发布') },
  })
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/agent/pending-queues/session-3',
      payload: { session_id: 3, items: [{ key: 4, text: 'secret' }], owner_id: 'attacker' },
    })
    assert.equal(response.statusCode, 401)
  } finally { await app.close() }
})

test('PATCH 合并 upsert/remove 后提交，再只发布 owner/session/origin 元数据', async () => {
  const app = Fastify(), calls: unknown[][] = []
  registerAgentPendingQueuePatchRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'trusted-owner' },
    async patch(...args) { calls.push(['patch', ...args]) },
    async publishChanged(...args) { calls.push(['event', ...args]) },
  })
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/agent/pending-queues/session-3',
      headers: { 'x-client-id': 'tab-a' },
      payload: {
        session_id: 3,
        items: [{ key: 7, text: '正文不得进入事件', references: [{ type: 'project', id: 4, label: '项目' }] }],
        remove_keys: [6],
      },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, count: 1 })
    assert.deepEqual(calls, [
      ['patch', 'trusted-owner', 'session-3', 3, [{ key: 7, text: '正文不得进入事件', attachments: [], references: [{ type: 'project', id: 4, label: '项目' }] }], [6]],
      ['event', 'trusted-owner', 3, 'tab-a'],
    ])
    assert.doesNotMatch(JSON.stringify(calls.find(([kind]) => kind === 'event')), /正文不得进入事件|项目/)
  } finally { await app.close() }
})

test('空 patch 不创建或发布，错队列/越权保持 409/404，非法 payload 返回 422', async () => {
  const app = Fastify(), calls: string[] = []
  registerAgentPendingQueuePatchRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner' },
    async patch(_owner, queueId, sessionId) {
      calls.push(`patch:${queueId}:${sessionId}`)
      if (sessionId === 404) throw new AgentPendingQueueSessionNotFoundError()
      if (queueId !== `session-${sessionId}`) throw new AgentPendingQueueConflictError()
    },
    async publishChanged() { calls.push('event') },
  })
  try {
    const empty = await app.inject({ method: 'PATCH', url: '/api/v1/agent/pending-queues/session-3', payload: { session_id: 3 } })
    assert.deepEqual(empty.json(), { ok: true, count: 0 })
    assert.equal(calls.length, 1)
    const mismatch = await app.inject({ method: 'PATCH', url: '/api/v1/agent/pending-queues/old', payload: { session_id: 3 } })
    assert.equal(mismatch.statusCode, 409)
    const absent = await app.inject({ method: 'PATCH', url: '/api/v1/agent/pending-queues/session-404', payload: { session_id: 404 } })
    assert.equal(absent.statusCode, 404)
    const invalid = await app.inject({ method: 'PATCH', url: '/api/v1/agent/pending-queues/session-3', payload: { session_id: 3, items: [{ key: 0, text: 'bad' }] } })
    assert.equal(invalid.statusCode, 422)
    assert.ok(Array.isArray(invalid.json().detail))
    assert.deepEqual(invalid.json().detail[0], {
      type: 'greater_than', loc: ['body', 'items', 0, 'key'],
      msg: 'Input should be greater than 0', input: 0, ctx: { gt: 0 },
    })
    const wrongType = await app.inject({ method: 'PATCH', url: '/api/v1/agent/pending-queues/session-3', payload: { session_id: 3, items: [{ key: 1, text: 7 }] } })
    assert.deepEqual(wrongType.json().detail, [{
      type: 'string_type', loc: ['body', 'items', 0, 'text'],
      msg: 'Input should be a valid string', input: 7,
    }])
    const extraReferenceField = await app.inject({ method: 'PATCH', url: '/api/v1/agent/pending-queues/session-3', payload: {
      session_id: 3, items: [{ key: 1, text: 'x', references: [{ type: 'project', id: 2, label: 'p', extra: 1 }] }],
    } })
    assert.deepEqual(extraReferenceField.json().detail, [{
      type: 'extra_forbidden', loc: ['body', 'items', 0, 'references', 0, 'extra'],
      msg: 'Extra inputs are not permitted', input: 1,
    }])
  } finally { await app.close() }
})

test('PATCH payload 保持 Pydantic 的常见 JSON 类型强制与附件 extra 忽略语义', async () => {
  const app = Fastify(), accepted: unknown[][] = []
  registerAgentPendingQueuePatchRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner' },
    async patch(...args) { accepted.push(args) },
    async publishChanged() {},
  })
  try {
    const response = await app.inject({ method: 'PATCH', url: '/api/v1/agent/pending-queues/session-3', payload: {
      session_id: '3',
      items: [{ key: '4', text: '接受 JSON 数字字符串', attachments: [{ file_id: '7', duration: '1.25', quoted: 'true', extra: '忽略' }] }],
      remove_keys: [],
    } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(accepted[0], [
      'owner', 'session-3', 3,
      [{ key: 4, text: '接受 JSON 数字字符串', attachments: [{ file_id: 7, duration: 1.25, quoted: true }], references: [] }],
      [],
    ])
    const booleanInteger = await app.inject({ method: 'PATCH', url: '/api/v1/agent/pending-queues/session-1', payload: {
      session_id: true, items: [{ key: true, text: 'Pydantic int 接受 bool' }],
    } })
    assert.equal(booleanInteger.statusCode, 200)
    assert.equal((accepted[1]?.[2] as number), 1)
    assert.equal(((accepted[1]?.[3] as Array<Record<string, unknown>>)[0]?.key), 1)
  } finally { await app.close() }
})

test('PostgreSQL patch 合并时保留 claim lease，删除最后一项则移除队列行', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_pending_patch_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid NOT NULL);
      CREATE TABLE conversation_pending_queues (
        id serial PRIMARY KEY, user_id uuid NOT NULL, queue_id varchar(64) NOT NULL,
        session_id integer, items jsonb NOT NULL, updated_at timestamptz NOT NULL,
        UNIQUE(user_id, queue_id)
      )
    `)
    const owner = randomUUID()
    const otherOwner = randomUUID()
    await pool.query('INSERT INTO conversation_sessions VALUES (3,$1),(4,$2)', [owner, otherOwner])
    const patch = createPostgresAgentPendingQueuePatch(pool)
    await assert.rejects(patch(owner, 'session-4', 4, [{ key: 1, text: '越权' }], []), AgentPendingQueueSessionNotFoundError)
    await assert.rejects(patch(owner, 'wrong-queue', 3, [{ key: 1, text: '错队列' }], []), AgentPendingQueueConflictError)
    await patch(owner, 'session-3', 3, [{ key: 4, text: '原正文', _claim_token: 'lease', _claim_until: 500 }], [])
    await patch(owner, 'session-3', 3, [{ key: 4, text: '更新正文' }], [])
    const { rows: [row] } = await pool.query<{ items: Array<Record<string, unknown>> }>(
      'SELECT items FROM conversation_pending_queues WHERE user_id=$1 AND queue_id=$2', [owner, 'session-3'],
    )
    assert.deepEqual(row!.items, [{ key: 4, text: '更新正文', _claim_token: 'lease', _claim_until: 500 }])
    await Promise.all([
      patch(owner, 'session-3', 3, [{ key: 7, text: '并发 A' }], []),
      patch(owner, 'session-3', 3, [{ key: 8, text: '并发 B' }], []),
    ])
    const { rows: [concurrent] } = await pool.query<{ items: Array<Record<string, unknown>> }>(
      'SELECT items FROM conversation_pending_queues WHERE user_id=$1 AND queue_id=$2', [owner, 'session-3'],
    )
    assert.deepEqual(concurrent!.items.map((item) => item.key), [4, 7, 8])
    await patch(owner, 'session-3', 3, [], [4])
    await patch(owner, 'session-3', 3, [], [7, 8])
    assert.equal((await pool.query('SELECT 1 FROM conversation_pending_queues WHERE user_id=$1', [owner])).rowCount, 0)
    await patch(owner, 'session-3', 3, [], [])
    assert.equal((await pool.query('SELECT 1 FROM conversation_pending_queues WHERE user_id=$1', [owner])).rowCount, 0)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
