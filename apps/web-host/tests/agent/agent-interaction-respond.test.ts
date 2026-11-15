import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { Pool } from 'pg'
import { registerAgentInteractionRespondRoute, createAgentInteractionRespondService } from '../../src/domains/agent-sessions/agent-interaction-respond.js'
import { InteractionConsumeError } from '../../src/domains/agent-sessions/application/agent-interaction-consume.js'

test('路由认证、可信 owner、参数与错误脱敏', async () => {
  const app = Fastify(); let calls = 0
  registerAgentInteractionRespondRoute(app, { async requireUser(request, reply) { if (!request.headers.authorization) return reply.code(401).send() }, userIdFromRequest: () => 'owner', service: { async respond(owner, id, token) {
    calls++; assert.equal(owner, 'owner'); assert.equal(id, 7); assert.equal(token, 'test-token')
    if (calls === 1) throw new InteractionConsumeError('interaction_not_found', 'secret-detail')
    throw new Error('secret-detail')
  } } })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/7/respond', payload: { token: 'test-token' } })).statusCode, 401)
    assert.equal(calls, 0)
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/x/respond', headers: { authorization: 'yes' }, payload: { token: 'test-token' } })).statusCode, 422)
    const hidden = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/7/respond?owner_id=other', headers: { authorization: 'yes' }, payload: { token: 'test-token' } })
    assert.equal(hidden.statusCode, 404); assert.deepEqual(hidden.json(), { detail: '交互不存在' })
    const failure = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/7/respond', headers: { authorization: 'yes' }, payload: { token: 'test-token' } })
    assert.equal(failure.statusCode, 500); assert.doesNotMatch(failure.body, /secret-detail|test-token/)
  } finally { await app.close() }
})

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('真实事务提交一次并原子入恢复队列，唤醒失败不重复消费', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `agent_respond_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE interaction_prompts (id integer PRIMARY KEY,user_id text,session_id integer,kind text,status text,expires_at timestamptz,resolved_at timestamptz,schema_json jsonb); CREATE TABLE interaction_actions (id integer PRIMARY KEY,prompt_id integer,token_hash text,action_type text,option_id text,context_json jsonb,status text,expires_at timestamptz,consumed_at timestamptz,consumed_event_id text); CREATE TABLE jobs(prompt_id integer)')
    await pool.query("INSERT INTO interaction_prompts VALUES (1,'owner',7,'confirm','active',now()+interval '1 hour',NULL,'{}')")
    await pool.query("INSERT INTO interaction_actions VALUES (1,1,$1,'choice','confirm', '{}','pending',now()+interval '1 hour',NULL,NULL)", [createHash('sha256').update('synthetic').digest('hex')])
    await pool.query("UPDATE interaction_actions SET context_json='{\"tool_call_id\":\"tool\"}' WHERE id=1")
    let wake = 0, diagnosed = 0
    const service = createAgentInteractionRespondService({ pool, effects: { async applyCommandAction() { throw new Error('不得调用') }, async redeemConfirmation() { throw new Error('不得调用') } }, async enqueue(client, prompt) { await client.query('INSERT INTO jobs VALUES ($1)', [prompt.id]) }, async wake() { wake++; throw new Error('notification failed') }, diagnose() { diagnosed++ } })
    await assert.rejects(service.respond('other', 1, 'synthetic'), /交互不存在/)
    await assert.rejects(service.respond('owner', 1, 'wrong'), /动作无效/)
    const attempts = await Promise.allSettled([service.respond('owner', 1, 'synthetic'), service.respond('owner', 1, 'synthetic')])
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n), 1)
    assert.equal(wake, 1); assert.equal(diagnosed, 1)
    assert.equal((await pool.query('SELECT status FROM interaction_prompts')).rows[0].status, 'resolved')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
