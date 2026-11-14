import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import Fastify from 'fastify'
import { createAgentSessionLister, registerAgentSessionRoute } from '../../src/domains/agent-sessions/agent-sessions.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('会话列表路由拒绝未认证请求且不查询数据', async () => {
  const app = Fastify(), list = async () => { throw new Error('未认证时不得访问存储') }
  registerAgentSessionRoute(app, {
    async requireUser(_request, reply) { return reply.code(401).send({ detail: '未认证' }) },
    userIdFromRequest() { throw new Error('未认证时不得读取身份') },
    list,
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/agent/sessions' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { detail: '未认证' })
  } finally {
    await app.close()
  }
})

test('会话列表路由只用 Host 可信身份 accessor 的 owner 并映射列表响应', async () => {
  const app = Fastify(), owners: string[] = [], accessorCalls: number[] = []
  const trustedOwner = '8f5048f4-8e16-43d0-9a8d-3c08087f5131'
  registerAgentSessionRoute(app, {
    async requireUser() {},
    userIdFromRequest() { accessorCalls.push(1); return trustedOwner },
    async list(ownerId) {
      owners.push(ownerId)
      return [{ id: 7, title: '可信会话', source: 'web', isRunning: false, lastAssistantId: 12 }]
    },
  })
  try {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/agent/sessions?ownerId=00000000-0000-4000-8000-000000000000',
      headers: {
        authorization: 'Bearer attacker-controlled',
        'x-user-id': '00000000-0000-4000-8000-000000000000',
      },
      payload: { ownerId: '00000000-0000-4000-8000-000000000000' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), [{
      id: 7, title: '可信会话', source: 'web', isRunning: false, lastAssistantId: 12,
    }])
    assert.deepEqual(owners, [trustedOwner])
    assert.deepEqual(accessorCalls, [1])
  } finally {
    await app.close()
  }
})

test('会话列表只返回 owner 会话，并按 Python 语义投影运行态、可见回复、工作区和授权', {
  skip: !databaseUrl && '需要隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_agent_sessions_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query(`
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE workspaces (id serial PRIMARY KEY, name text NOT NULL);
      CREATE TABLE conversation_sessions (
        id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), title text NOT NULL,
        source text, chat_type text, workspace_id integer REFERENCES workspaces(id),
        session_context jsonb, updated_at timestamptz NOT NULL, created_at timestamptz NOT NULL
      );
      CREATE TABLE conversation_messages (
        id serial PRIMARY KEY, session_id integer NOT NULL REFERENCES conversation_sessions(id),
        role text NOT NULL, content text NOT NULL, content_json jsonb, files jsonb,
        conversation_seq bigint NOT NULL
      );
      CREATE TABLE filesystem_authorization_grants (
        id serial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), subject_type text NOT NULL,
        subject_id text NOT NULL, revoked_at timestamptz, expires_at timestamptz
      );
    `)
    const owner = randomUUID(), other = randomUUID()
    await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [owner, other])
    const { rows: [workspace] } = await pool.query<{ id: number }>(
      "INSERT INTO workspaces (name) VALUES ('合成工作区') RETURNING id",
    )
    const stamp = '2026-11-12T00:00:00Z'
    const { rows: sessions } = await pool.query<{ id: number; title: string }>(
      `INSERT INTO conversation_sessions (user_id,title,source,chat_type,workspace_id,session_context,updated_at,created_at)
       VALUES ($1,'网页会话','web','private',$3,'{"goal_mode":true,"goal_text":"目标","goal_status":"paused"}',$4,$4),
              ($1,'IM 会话','qq','group',NULL,NULL,$5,$4),
              ($2,'他人会话','web','private',NULL,NULL,$6,$4)
       RETURNING id,title`,
      [owner, other, workspace.id, stamp, '2026-11-12T00:00:02Z', '2026-11-12T00:00:01Z'],
    )
    const web = sessions.find((row) => row.title === '网页会话')!
    const im = sessions.find((row) => row.title === 'IM 会话')!
    const foreign = sessions.find((row) => row.title === '他人会话')!
    await pool.query(
      `INSERT INTO conversation_messages (session_id,role,content,content_json,files,conversation_seq) VALUES
       ($1,'assistant','可见回复',NULL,NULL,1),
       ($1,'assistant','',NULL,'[]',2),
       ($1,'assistant','工具事件', '[{"kind":"tool"}]',NULL,3),
       ($1,'assistant','',NULL,'[{"file_id":7}]',4),
       ($2,'assistant','IM 回复',NULL,NULL,1),
       ($3,'assistant','外部回复',NULL,NULL,1)`,
      [web.id, im.id, foreign.id],
    )
    await pool.query(
      `INSERT INTO filesystem_authorization_grants (user_id,subject_type,subject_id,expires_at)
       VALUES ($1,'session',$3,NULL),($1,'session',$4,now() - interval '1 hour'),
              ($2,'session',$5,NULL)`,
      [owner, other, String(web.id), String(im.id), String(foreign.id)],
    )
    const activeCalls: number[][] = []
    const list = createAgentSessionLister(pool, {
      activeStatuses: async (ids) => { activeCalls.push(ids); return new Map([[web.id, true], [im.id, false]]) },
      filesystemAuthorizationEnabled: () => true,
      workspaceShellSupported: () => true,
    })
    const result = await list(owner)
    assert.deepEqual(result.map((row) => row.id), [im.id, web.id])
    assert.equal(result.some((row) => row.id === foreign.id), false)
    assert.equal(result.find((row) => row.id === web.id)?.lastAssistantId, 4)
    assert.equal(result.find((row) => row.id === im.id)?.lastAssistantId, undefined)
    assert.equal(result.find((row) => row.id === web.id)?.isRunning, true)
    assert.equal(result.find((row) => row.id === im.id)?.isRunning, false)
    assert.equal(result.find((row) => row.id === web.id)?.workspaceName, '合成工作区')
    assert.equal(result.find((row) => row.id === web.id)?.filesystemAuthorized, true)
    assert.equal(result.find((row) => row.id === im.id)?.filesystemAuthorized, false)
    assert.equal(result.find((row) => row.id === web.id)?.goalStatus, 'paused')
    assert.deepEqual(activeCalls, [[im.id, web.id]])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
