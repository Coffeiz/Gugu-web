import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import {
  createPostgresAgentSessionRenamer,
  registerAgentSessionRenameRoute,
} from '../../src/domains/agent-sessions/agent-session-rename.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('会话重命名先认证，并且不读取身份或调用写入端口', async () => {
  const app = Fastify()
  registerAgentSessionRenameRoute(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取身份') },
    async rename() { throw new Error('未认证时不得写入') },
  })
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/agent/sessions/7', payload: { title: '改名' },
    })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { detail: '未认证' })
  } finally {
    await app.close()
  }
})

test('会话重命名只使用可信 owner，裁剪标题并返回 title_locked', async () => {
  const app = Fastify()
  const calls: Array<{ ownerId: string; sessionId: number; title: string }> = []
  const ownerId = '8f5048f4-8e16-43d0-9a8d-3c08087f5131'
  registerAgentSessionRenameRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return ownerId },
    async rename(requestOwner, sessionId, title) {
      calls.push({ ownerId: requestOwner, sessionId, title })
      return { id: sessionId, title, title_locked: true }
    },
  })
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/agent/sessions/7?ownerId=00000000-0000-4000-8000-000000000000',
      headers: { 'x-user-id': '00000000-0000-4000-8000-000000000000' },
      payload: { title: '  用户标题  ' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { id: 7, title: '用户标题', title_locked: true })
    assert.deepEqual(calls, [{ ownerId, sessionId: 7, title: '用户标题' }])
  } finally {
    await app.close()
  }
})

test('会话重命名拒绝空白、超过 300 个 Unicode 字符和无效会话 ID', async () => {
  const app = Fastify()
  let writes = 0
  registerAgentSessionRenameRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return '8f5048f4-8e16-43d0-9a8d-3c08087f5131' },
    async rename() { writes += 1; return { id: 7, title: '不应写入', title_locked: true } },
  })
  try {
    for (const [url, title] of [
      ['/api/v1/agent/sessions/7', '   '],
      ['/api/v1/agent/sessions/7', '😀'.repeat(301)],
      ['/api/v1/agent/sessions/not-an-id', '有效标题'],
      ['/api/v1/agent/sessions/1e0', '有效标题'],
    ] as const) {
      const response = await app.inject({ method: 'PATCH', url, payload: { title } })
      assert.equal(response.statusCode, 422)
      assert.equal(typeof response.json().detail, 'string')
    }
    assert.equal(writes, 0)
  } finally {
    await app.close()
  }
})

test('不存在或不属于当前用户的会话统一返回 404', async () => {
  const app = Fastify()
  const lookedUp: number[] = []
  registerAgentSessionRenameRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return '8f5048f4-8e16-43d0-9a8d-3c08087f5131' },
    async rename(_ownerId, sessionId) { lookedUp.push(sessionId); return null },
  })
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/agent/sessions/99', payload: { title: '有效标题' },
    })
    assert.equal(response.statusCode, 404)
    assert.deepEqual(response.json(), { detail: '对话不存在' })

    const zeroId = await app.inject({
      method: 'PATCH', url: '/api/v1/agent/sessions/0', payload: { title: '有效标题' },
    })
    assert.equal(zeroId.statusCode, 404, '有效整数 ID 的不存在记录沿用 Python 404 语义')
    assert.deepEqual(lookedUp, [99, 0])
  } finally {
    await app.close()
  }
})

test('PostgreSQL 会话改名 owner 隔离并持久锁定手动标题', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_agent_rename_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        title varchar(300) NOT NULL,
        title_locked boolean NOT NULL DEFAULT false
      )
    `)
    const ownerId = randomUUID(), otherOwnerId = randomUUID()
    const { rows: [own] } = await pool.query<{ id: number }>(
      "INSERT INTO conversation_sessions (user_id,title) VALUES ($1,'旧标题') RETURNING id", [ownerId],
    )
    const { rows: [foreign] } = await pool.query<{ id: number }>(
      "INSERT INTO conversation_sessions (user_id,title) VALUES ($1,'他人标题') RETURNING id", [otherOwnerId],
    )
    const rename = createPostgresAgentSessionRenamer(pool)

    assert.deepEqual(await rename(ownerId, own.id, '用户标题'), {
      id: own.id, title: '用户标题', title_locked: true,
    })
    assert.equal(await rename(ownerId, foreign.id, '越权改名'), null)

    const autoTitle = await pool.query(
      `UPDATE conversation_sessions SET title = 'LLM 自动标题'
       WHERE id = $1 AND user_id = $2 AND title_locked = false`, [own.id, ownerId],
    )
    assert.equal(autoTitle.rowCount, 0, '手动标题必须阻止异步自动标题覆盖')

    const { rows } = await pool.query(
      'SELECT user_id, title, title_locked FROM conversation_sessions ORDER BY id',
    )
    assert.deepEqual(rows, [
      { user_id: ownerId, title: '用户标题', title_locked: true },
      { user_id: otherOwnerId, title: '他人标题', title_locked: false },
    ])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
