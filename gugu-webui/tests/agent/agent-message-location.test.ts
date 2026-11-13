import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import {
  createPostgresAgentMessageLocator,
  registerAgentMessageLocationRoute,
} from '../../src/domains/agent-sessions/agent-message-location.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('消息定位先认证，不读取身份或查询存储', async () => {
  const app = Fastify()
  registerAgentMessageLocationRoute(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取身份') },
    locate() { throw new Error('未认证时不得查询消息') },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/messages/7' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { detail: '未认证' })
  } finally {
    await app.close()
  }
})

test('消息定位只使用可信 owner，并返回展示正文所在会话', async () => {
  const app = Fastify()
  const calls: Array<{ ownerId: string; messageId: number }> = []
  const ownerId = '8f5048f4-8e16-43d0-9a8d-3c08087f5131'
  registerAgentMessageLocationRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return ownerId },
    async locate(requestOwner, messageId) {
      calls.push({ ownerId: requestOwner, messageId })
      return { id: messageId, sessionId: 42 }
    },
  })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/messages/+7?ownerId=00000000-0000-4000-8000-000000000000',
      headers: { 'x-user-id': '00000000-0000-4000-8000-000000000000' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { id: 7, sessionId: 42 })
    assert.deepEqual(calls, [{ ownerId, messageId: 7 }])
  } finally {
    await app.close()
  }
})

test('非整数消息 ID 返回 422，整数但不存在的消息返回 404', async () => {
  const app = Fastify()
  const calls: number[] = []
  registerAgentMessageLocationRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return '8f5048f4-8e16-43d0-9a8d-3c08087f5131' },
    async locate(_ownerId, messageId) { calls.push(messageId); return null },
  })
  try {
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/agent/messages/1e0' })
    assert.equal(invalid.statusCode, 422)
    const missing = await app.inject({ method: 'GET', url: '/api/v1/agent/messages/0' })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: '消息不存在' })
    assert.deepEqual(calls, [0])
  } finally {
    await app.close()
  }
})

test('PostgreSQL 消息定位只返回 owner 的展示正文并隐藏 timeline 与 summary 行', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_message_location_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL
      );
      CREATE TABLE conversation_messages (
        id serial PRIMARY KEY,
        session_id integer NOT NULL REFERENCES conversation_sessions(id),
        role text NOT NULL,
        content_json jsonb
      )
    `)
    const ownerId = randomUUID(), otherOwnerId = randomUUID()
    const { rows: ownerSessions } = await pool.query<{ id: number }>(
      'INSERT INTO conversation_sessions (user_id) VALUES ($1) RETURNING id', [ownerId],
    )
    const { rows: otherSessions } = await pool.query<{ id: number }>(
      'INSERT INTO conversation_sessions (user_id) VALUES ($1) RETURNING id', [otherOwnerId],
    )
    const ownerSession = ownerSessions[0]!.id, otherSession = otherSessions[0]!.id
    const { rows: [visible] } = await pool.query<{ id: number }>(
      "INSERT INTO conversation_messages (session_id,role,content_json) VALUES ($1,'user',NULL) RETURNING id",
      [ownerSession],
    )
    const { rows: [timeline] } = await pool.query<{ id: number }>(
      "INSERT INTO conversation_messages (session_id,role,content_json) VALUES ($1,'assistant','[]'::jsonb) RETURNING id",
      [ownerSession],
    )
    const { rows: [summary] } = await pool.query<{ id: number }>(
      "INSERT INTO conversation_messages (session_id,role,content_json) VALUES ($1,'summary',NULL) RETURNING id",
      [ownerSession],
    )
    const { rows: [foreign] } = await pool.query<{ id: number }>(
      "INSERT INTO conversation_messages (session_id,role,content_json) VALUES ($1,'user',NULL) RETURNING id",
      [otherSession],
    )

    const locate = createPostgresAgentMessageLocator(pool)
    assert.deepEqual(await locate(ownerId, visible!.id), { id: visible!.id, sessionId: ownerSession })
    assert.equal(await locate(ownerId, timeline!.id), null)
    assert.equal(await locate(ownerId, summary!.id), null)
    assert.equal(await locate(ownerId, foreign!.id), null)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
