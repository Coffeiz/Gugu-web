import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAgentSessionToolEventDetailsRoute } from '../../src/domains/agent-sessions/agent-session-tool-event-details-route.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('工具详情 wrapper 先认证，再访问可信 owner 或 PostgreSQL', async () => {
  const app = Fastify()
  let queries = 0
  const pool = { async query() { queries++; throw new Error('未认证时不得查询') } } as never
  registerAgentSessionToolEventDetailsRoute(app, {
    pool,
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取身份') },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline&message_id=9&timeline_index=0' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { detail: '未认证' })
    assert.equal(queries, 0)
  } finally { await app.close() }
})

test('工具详情 wrapper validates source and required identifiers before database access', async () => {
  const app = Fastify()
  let queries = 0
  const pool = { async query() { queries++; throw new Error('参数校验前不得查询') } } as never
  registerAgentSessionToolEventDetailsRoute(app, {
    pool,
    async requireUser() {},
    userIdFromRequest() { return 'owner' },
  })
  try {
    const invalidSource = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=other&message_id=9&timeline_index=0' })
    assert.equal(invalidSource.statusCode, 422)
    const missing = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline' })
    assert.equal(missing.statusCode, 400)
    assert.equal(queries, 0)
  } finally { await app.close() }
})

test('PostgreSQL route 只给 prompt 所属 owner 返回 tool 详情，并沿用媒体安全投影与 404 语义', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_tool_detail_route_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const app = Fastify()
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid NOT NULL);
      CREATE TABLE conversation_messages (
        id integer PRIMARY KEY, session_id integer NOT NULL REFERENCES conversation_sessions(id),
        display_timeline jsonb
      )
    `)
    const owner = randomUUID(), otherOwner = randomUUID()
    await pool.query('INSERT INTO conversation_sessions VALUES (7,$1),(8,$2)', [owner, otherOwner])
    await pool.query(`INSERT INTO conversation_messages VALUES
      (9,7,'[{"kind":"tool","toolInput":{"query":"合成查询"},"toolResult":[{"type":"video","source":{"type":"base64","data":"private-media"}}]}]'::jsonb),
      (10,7,'[{"kind":"assistant","text":"不是工具"}]'::jsonb),
      (11,8,'[{"kind":"tool","toolResult":"other owner"}]'::jsonb)`)
    registerAgentSessionToolEventDetailsRoute(app, {
      pool,
      async requireUser() {},
      userIdFromRequest() { return owner },
    })
    const details = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline&message_id=9&timeline_index=0' })
    assert.equal(details.statusCode, 200)
    assert.deepEqual(details.json(), {
      toolInput: { query: '合成查询' },
      toolResult: [{ type: 'text', text: '[视频已查看]' }],
    })
    assert.doesNotMatch(details.body, /private-media/)
    const nonTool = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline&message_id=10&timeline_index=0' })
    assert.equal(nonTool.statusCode, 404)
    const foreignSession = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/8/tool-event-details?source=timeline&message_id=11&timeline_index=0' })
    assert.equal(foreignSession.statusCode, 404)
  } finally {
    await app.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
