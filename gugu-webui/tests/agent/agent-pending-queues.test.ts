import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import {
  createPostgresAgentImportedDraftQueueReader,
  createPostgresAgentPendingQueueReader,
  registerAgentImportedDraftQueueRoute,
  registerAgentPendingQueueReadRoute,
} from '../../src/domains/agent-sessions/agent-pending-queues.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('未认证时不读取用户待发队列', async () => {
  const app = Fastify()
  registerAgentPendingQueueReadRoute(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取 owner') },
    async readQueue() { throw new Error('未认证时不得查询队列') },
  })
  try {
    const response = await app.inject({ url: '/api/v1/agent/pending-queues/session-7' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { detail: '未认证' })
  } finally { await app.close() }
})

test('读取只返回可信 owner 的队列并移除认领令牌', async () => {
  const app = Fastify()
  const calls: unknown[][] = []
  registerAgentPendingQueueReadRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'trusted-owner' },
    nowSeconds: () => 100,
    async readQueue(...args) {
      calls.push(args)
      return {
        sessionId: 7,
        items: [
          { key: 3, text: '合成消息', attachment: { attach_id: 'a-synthetic' }, _claim_token: 'private-token', _claim_until: 101 },
          { key: 4, text: '已过期', _claim_token: 'expired-token', _claim_until: 99 },
        ],
      }
    },
  })
  try {
    const response = await app.inject({ url: '/api/v1/agent/pending-queues/session-7?ownerId=attacker' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      sessionId: 7,
      items: [
        { key: 3, text: '合成消息', attachment: { attach_id: 'a-synthetic' }, queue_id: 'session-7', session_id: 7, claimed: true },
        { key: 4, text: '已过期', queue_id: 'session-7', session_id: 7, claimed: false },
      ],
    })
    assert.deepEqual(calls, [['trusted-owner', 'session-7']])
    assert.doesNotMatch(response.body, /private-token|expired-token/)
  } finally { await app.close() }
})

test('不存在或属于其他用户的队列都返回空快照；非法队列 id 返回 422', async () => {
  const app = Fastify()
  let reads = 0
  registerAgentPendingQueueReadRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner' },
    async readQueue(_owner, queueId) {
      reads += 1
      return queueId === 'foreign-key' ? null : { sessionId: null, items: [] }
    },
  })
  try {
    const missing = await app.inject({ url: '/api/v1/agent/pending-queues/missing-key' })
    const foreign = await app.inject({ url: '/api/v1/agent/pending-queues/foreign-key' })
    const invalid = await app.inject({ url: '/api/v1/agent/pending-queues/has%20space' })
    assert.deepEqual(missing.json(), { sessionId: null, items: [] })
    assert.deepEqual(foreign.json(), { sessionId: null, items: [] })
    assert.equal(invalid.statusCode, 422)
    assert.equal(reads, 2)
  } finally { await app.close() }
})

test('归档恢复草稿只列出可信 owner 的非空导入队列并隐藏 claim 凭据', async () => {
  const app = Fastify()
  const owners: string[] = []
  registerAgentImportedDraftQueueRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'trusted-owner' },
    nowSeconds: () => 100,
    async readImportedDrafts(ownerId) {
      owners.push(ownerId)
      return [
        { queueId: 'import-a', items: [{ key: 1, text: '合成草稿', _claim_token: 'private', _claim_until: 101 }] },
        { queueId: 'import-empty', items: [] },
      ]
    },
  })
  try {
    const response = await app.inject({ url: '/api/v1/agent/pending-queues/imported-drafts?ownerId=attacker' })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      queues: [{
        queue_id: 'import-a',
        items: [{ key: 1, text: '合成草稿', queue_id: 'import-a', session_id: null, claimed: true }],
      }],
    })
    assert.deepEqual(owners, ['trusted-owner'])
    assert.doesNotMatch(response.body, /private/)
  } finally { await app.close() }
})

test('PostgreSQL 队列读取按 owner 和 queue id 联合隔离', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_pending_queue_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE conversation_pending_queues (
        user_id uuid NOT NULL, queue_id text NOT NULL, session_id integer,
        items jsonb NOT NULL, UNIQUE (user_id, queue_id)
      )
    `)
    const owner = randomUUID(), other = randomUUID()
    await pool.query(
      'INSERT INTO conversation_pending_queues VALUES ($1,$3,7,$4),($2,$3,8,$5)',
      [owner, other, 'session-7', '[{"key":1,"text":"owner"}]', '[{"key":1,"text":"private"}]'],
    )
    const readQueue = createPostgresAgentPendingQueueReader(pool)
    assert.deepEqual(await readQueue(owner, 'session-7'), {
      sessionId: 7, items: [{ key: 1, text: 'owner' }],
    })
    assert.equal(await readQueue(other, 'absent'), null)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})

test('PostgreSQL 导入草稿只读 owner 所有的未绑定 import 队列并按更新时间排序', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_import_queue_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE conversation_pending_queues (
        user_id uuid NOT NULL, queue_id text NOT NULL, session_id integer,
        items jsonb NOT NULL, updated_at timestamptz NOT NULL, id serial PRIMARY KEY
      )
    `)
    const owner = randomUUID(), other = randomUUID()
    await pool.query(`INSERT INTO conversation_pending_queues(user_id,queue_id,session_id,items,updated_at) VALUES
      ($1,'import-old',NULL,'[{"key":1,"text":"old"}]','2026-11-12T00:00:00Z'),
      ($1,'import-new',NULL,'[{"key":2,"text":"new"}]','2026-11-13T00:00:00Z'),
      ($1,'import-bound',7,'[{"key":3,"text":"bound"}]','2026-11-14T00:00:00Z'),
      ($1,'other-key',NULL,'[{"key":4,"text":"other"}]','2026-11-15T00:00:00Z'),
      ($2,'import-foreign',NULL,'[{"key":5,"text":"foreign"}]','2026-11-16T00:00:00Z')`, [owner, other])
    const readDrafts = createPostgresAgentImportedDraftQueueReader(pool)
    assert.deepEqual(await readDrafts(owner), [
      { queueId: 'import-old', items: [{ key: 1, text: 'old' }] },
      { queueId: 'import-new', items: [{ key: 2, text: 'new' }] },
    ])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
