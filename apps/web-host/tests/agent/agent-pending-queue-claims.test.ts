import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import {
  AgentPendingQueueConflictError,
  AgentPendingQueueSessionNotFoundError,
  createPostgresAgentPendingQueueClaims,
  registerAgentPendingQueueClaimRoutes,
} from '../../src/domains/agent-sessions/agent-pending-queue-claims.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('claim/release 路由先认证，且不会从请求输入接受 owner', async () => {
  const app = Fastify()
  registerAgentPendingQueueClaimRoutes(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取身份') },
    async claim() { throw new Error('未认证时不得认领') },
    async release() { throw new Error('未认证时不得释放') },
    async publishChanged() { throw new Error('未认证时不得发布') },
  })
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/agent/pending-queues/session-3/items/4/claim',
      payload: { session_id: 3, owner_id: 'attacker' },
    })
    assert.equal(response.statusCode, 401)
  } finally { await app.close() }
})

test('active session blocks claim and successful release publishes only after token match', async () => {
  const app = Fastify(), calls: string[] = []
  let active = true
  registerAgentPendingQueueClaimRoutes(app, {
    async requireUser() {},
    userIdFromRequest() { return 'trusted-owner' },
    async claim(owner, session, queue, key) {
      calls.push(`claim:${owner}:${session}:${queue}:${key}`)
      return active ? { claimToken: null, reason: 'session_active' } : { claimToken: 'opaque-token' }
    },
    async release(owner, session, queue, key, token) {
      calls.push(`release:${owner}:${session}:${queue}:${key}:${token}`)
      return token === 'opaque-token'
    },
    async publishChanged(_owner, _session, origin) { calls.push(`publish:${origin ?? ''}`) },
  })
  try {
    const blocked = await app.inject({
      method: 'POST', url: '/api/v1/agent/pending-queues/session-3/items/4/claim', payload: { session_id: 3 },
    })
    assert.equal(blocked.statusCode, 200)
    assert.deepEqual(blocked.json(), { claim_token: null, reason: 'session_active' })
    active = false
    const claimed = await app.inject({
      method: 'POST', url: '/api/v1/agent/pending-queues/session-3/items/4/claim', payload: { session_id: 3 },
    })
    assert.deepEqual(claimed.json(), { claim_token: 'opaque-token' })
    const rejected = await app.inject({
      method: 'POST', url: '/api/v1/agent/pending-queues/session-3/items/4/release',
      headers: { 'x-client-id': 'client-a' }, payload: { session_id: 3, claim_token: 'wrong' },
    })
    assert.deepEqual(rejected.json(), { released: false })
    assert.equal(calls.some((call) => call.startsWith('publish:')), false)
    const released = await app.inject({
      method: 'POST', url: '/api/v1/agent/pending-queues/session-3/items/4/release',
      headers: { 'x-client-id': 'client-a' }, payload: { session_id: 3, claim_token: 'opaque-token' },
    })
    assert.deepEqual(released.json(), { released: true })
    assert.equal(calls.at(-1), 'publish:client-a')
  } finally { await app.close() }
})

test('队列 ID 必须与 owner 会话的规范 ID 匹配，越权和错队列保持不同错误', async () => {
  const app = Fastify()
  registerAgentPendingQueueClaimRoutes(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner' },
    async claim(_owner, sessionId, queueId) {
      if (sessionId === 404) throw new AgentPendingQueueSessionNotFoundError()
      if (queueId !== `session-${sessionId}`) throw new AgentPendingQueueConflictError()
      return { claimToken: null }
    },
    async release() { return false },
    async publishChanged() {},
  })
  try {
    const mismatch = await app.inject({ method: 'POST', url: '/api/v1/agent/pending-queues/old/items/1/claim', payload: { session_id: 3 } })
    assert.equal(mismatch.statusCode, 409)
    const absent = await app.inject({ method: 'POST', url: '/api/v1/agent/pending-queues/session-404/items/1/claim', payload: { session_id: 404 } })
    assert.equal(absent.statusCode, 404)
    const malformed = await app.inject({ method: 'POST', url: '/api/v1/agent/pending-queues/bad%2Fid/items/1/claim', payload: { session_id: 3 } })
    assert.equal(malformed.statusCode, 422)
    const extraField = await app.inject({ method: 'POST', url: '/api/v1/agent/pending-queues/session-3/items/1/claim', payload: { session_id: 3, owner_id: 'spoofed' } })
    assert.equal(extraField.statusCode, 422)
  } finally { await app.close() }
})

test('PostgreSQL claim 使用行锁保持单一活动 token，60 秒到期可重领且 token release', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_pending_claim_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 6 })
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
    await pool.query('INSERT INTO conversation_sessions VALUES (3,$1)', [owner])
    await pool.query(`INSERT INTO conversation_pending_queues(user_id,queue_id,session_id,items,updated_at)
      VALUES ($1,'session-3',3,'[{"key":4,"text":"正文不得进入事件"}]',now())`, [owner])
    let now = 1000
    let tokenId = 0
    const store = createPostgresAgentPendingQueueClaims(pool, {
      async isSessionActive() { return false },
      nowSeconds() { return now },
      createToken() { tokenId += 1; return `token-${tokenId}` },
    })
    const concurrent = await Promise.all([
      store.claim(owner, 3, 'session-3', 4),
      store.claim(owner, 3, 'session-3', 4),
    ])
    assert.equal(concurrent.filter((claim) => claim.claimToken).length, 1)
    assert.equal(concurrent.filter((claim) => claim.claimToken === null).length, 1)
    now = 1059
    assert.equal((await store.claim(owner, 3, 'session-3', 4)).claimToken, null)
    now = 1060
    const reclaimed = await store.claim(owner, 3, 'session-3', 4)
    assert.ok(reclaimed.claimToken)
    assert.equal(await store.release(owner, 3, 'session-3', 4, 'wrong-token'), false)
    assert.equal(await store.release(owner, 3, 'session-3', 4, reclaimed.claimToken!), true)
    const { rows: [row] } = await pool.query<{ items: Array<Record<string, unknown>> }>(
      'SELECT items FROM conversation_pending_queues WHERE user_id=$1 AND queue_id=$2', [owner, 'session-3'],
    )
    assert.deepEqual(row!.items, [{ key: 4, text: '正文不得进入事件' }])
    await assert.rejects(store.claim(randomUUID(), 3, 'session-3', 4), AgentPendingQueueSessionNotFoundError)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
