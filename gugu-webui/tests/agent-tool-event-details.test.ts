import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import {
  AgentToolEventDetailsNotFoundError,
  AgentToolEventSessionNotFoundError,
  createPostgresAgentToolEventDetails,
  registerAgentToolEventDetailsRoute,
} from '../src/domains/agent-sessions/agent-tool-event-details.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('工具详情路由先认证，不读取 owner 或查询事件', async () => {
  const app = Fastify()
  registerAgentToolEventDetailsRoute(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取 owner') },
    async readDetails() { throw new Error('未认证时不得查询') },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline&message_id=9&timeline_index=0' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { detail: '未认证' })
  } finally {
    await app.close()
  }
})

test('工具详情路由使用可信 owner，保留文本并将内嵌媒体转换为占位', async () => {
  const app = Fastify()
  const calls: unknown[][] = []
  registerAgentToolEventDetailsRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner-trusted' },
    async readDetails(...args) {
      calls.push(args)
      return {
        toolInput: { query: '合成查询', image: { type: 'image', source: { type: 'base64', data: 'private-bytes' } } },
        toolResult: [{ type: 'video', source: { type: 'base64', data: 'private-bytes' } }],
      }
    },
  })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline&message_id=9&timeline_index=0&ownerId=attacker',
      headers: { 'x-user-id': 'attacker' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      toolInput: { query: '合成查询', image: { type: 'text', text: '[图片已查看]' } },
      toolResult: [{ type: 'text', text: '[视频已查看]' }],
    })
    assert.deepEqual(calls, [['owner-trusted', 7, 9, 0]])
    assert.doesNotMatch(response.body, /private-bytes/)
  } finally {
    await app.close()
  }
})

test('缺少或无效工具事件标识返回 400/422，非工具与不存在事件返回 404', async () => {
  const app = Fastify()
  const calls: unknown[][] = []
  registerAgentToolEventDetailsRoute(app, {
    async requireUser() {},
    userIdFromRequest() { return 'owner' },
    async readDetails(...args) {
      calls.push(args)
      if (args[2] === 404) throw new AgentToolEventDetailsNotFoundError()
      if (args[2] === 405) throw new AgentToolEventSessionNotFoundError()
      return null
    },
  })
  try {
    const missing = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline' })
    assert.equal(missing.statusCode, 400)
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline&message_id=9&timeline_index=-1' })
    assert.equal(invalid.statusCode, 422)
    const nonTool = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline&message_id=9&timeline_index=0' })
    assert.equal(nonTool.statusCode, 404)
    const noEvent = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline&message_id=404&timeline_index=0' })
    assert.equal(noEvent.statusCode, 404)
    const foreign = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/7/tool-event-details?source=timeline&message_id=405&timeline_index=0' })
    assert.equal(foreign.statusCode, 404)
    assert.equal(calls.length, 3)
  } finally {
    await app.close()
  }
})

test('PostgreSQL 工具详情先校验会话 owner，再按 session/message/index 读取安全时间线', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_agent_tool_details_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid NOT NULL);
      CREATE TABLE conversation_messages (
        id integer PRIMARY KEY, session_id integer NOT NULL REFERENCES conversation_sessions(id),
        display_timeline jsonb
      )
    `)
    const owner = randomUUID(), foreignOwner = randomUUID()
    await pool.query('INSERT INTO conversation_sessions VALUES (7,$1),(8,$2)', [owner, foreignOwner])
    await pool.query(`INSERT INTO conversation_messages VALUES
      (9,7,'[{"kind":"tool","toolInput":{"query":"合成"},"toolResult":[{"type":"image","source":{"type":"base64","data":"secret"}}]}]'::jsonb),
      (10,7,'[{"kind":"assistant","text":"非工具"}]'::jsonb),
      (11,8,'[{"kind":"tool","toolResult":"foreign"}]'::jsonb)`)
    const read = createPostgresAgentToolEventDetails(pool)
    assert.deepEqual(await read(owner, 7, 9, 0), {
      toolInput: { query: '合成' },
      toolResult: [{ type: 'image', source: { type: 'base64', data: 'secret' } }],
    })
    await assert.rejects(read(owner, 8, 11, 0), AgentToolEventSessionNotFoundError)
    await assert.rejects(read(owner, 7, 10, 0), AgentToolEventDetailsNotFoundError)
    await assert.rejects(read(owner, 7, 9, 1), AgentToolEventDetailsNotFoundError)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
