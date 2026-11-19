import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { Pool } from 'pg'
import { consumeInteractionText } from '@gugu/core/agent'
import { InteractionConsumeError } from '@gugu/core/agent/interactions/consume-action'
import { registerAgentInteractionRespondRoute, createAgentInteractionRespondService } from '../../src/modules/agent/interactions/respond.js'
import { createPostgresInteractionTextStore } from '../../src/modules/agent/interactions/consume.js'

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

test('恢复选择与文本回答通过认证并只返回可恢复原 Run 的结果', async () => {
  const app = Fastify(); const calls: unknown[][] = []
  registerAgentInteractionRespondRoute(app, { async requireUser(request, reply) { if (!request.headers.authorization) return reply.code(401).send() }, userIdFromRequest: () => 'trusted-owner', service: {
    async respond(owner, id, token, eventId) {
      calls.push(['respond', owner, id, token, eventId])
      return { prompt_id: id, session_id: 12, kind: 'confirm', option_id: 'confirm', action_type: 'choice', context: { tool_call_id: 'call-a' }, result: { status: 'confirmed' }, run_id: 'original-run' } as never
    },
    async resumeText(owner, id, text, eventId) {
      calls.push(['resumeText', owner, id, text, eventId])
      return { prompt_id: id, session_id: 12, kind: 'question', context: { tool_call_id: 'call-b' }, result: { status: 'answered' }, event_id: eventId } as never
    },
  } })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/7/resume', payload: { token: 'choice-token' } })).statusCode, 401)
    const choice = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/7/resume', headers: { authorization: 'yes' }, payload: { token: 'choice-token', event_id: 'event-a' } })
    assert.equal(choice.statusCode, 200)
    assert.deepEqual(choice.json(), { ok: true, session_id: 12, status: 'confirmed', option_id: 'confirm', run_id: 'original-run' })
    const text = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/8/resume-text', headers: { authorization: 'yes' }, payload: { text: '回答', event_id: 'event-b' } })
    assert.equal(text.statusCode, 200)
    assert.deepEqual(text.json(), { ok: true, session_id: 12 })
    assert.deepEqual(calls, [['respond', 'trusted-owner', 7, 'choice-token', 'event-a'], ['resumeText', 'trusted-owner', 8, '回答', 'event-b']])
  } finally { await app.close() }
})

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('真实事务提交一次并原子入恢复队列，唤醒失败不重复消费', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `agent_respond_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE interaction_prompts (id integer PRIMARY KEY,user_id text,session_id integer,kind text,status text,expires_at timestamptz,resolved_at timestamptz,schema_json jsonb); CREATE TABLE interaction_actions (id integer PRIMARY KEY,prompt_id integer,token_hash text,action_type text,option_id text,context_json jsonb,status text,expires_at timestamptz,consumed_at timestamptz,consumed_event_id text); CREATE TABLE jobs(prompt_id integer)')
    await pool.query("CREATE TABLE agent_interaction_bindings (user_id text,session_id integer,run_id text,prompt_id integer); INSERT INTO agent_interaction_bindings VALUES ('owner',7,'original-run',1)")
    await pool.query("INSERT INTO interaction_prompts VALUES (1,'owner',7,'confirm','active',now()+interval '1 hour',NULL,'{}')")
    await pool.query("INSERT INTO interaction_actions VALUES (1,1,$1,'choice','confirm', '{}','pending',now()+interval '1 hour',NULL,NULL)", [createHash('sha256').update('synthetic').digest('hex')])
    await pool.query("UPDATE interaction_actions SET context_json='{\"tool_call_id\":\"tool\"}' WHERE id=1")
    let wake = 0, diagnosed = 0
    const service = createAgentInteractionRespondService({ pool, effects: { async applyCommandAction() { throw new Error('不得调用') }, async redeemConfirmation() { throw new Error('不得调用') } }, async enqueue(client, prompt, _action, onEnqueued) { await client.query('INSERT INTO jobs VALUES ($1)', [prompt.id]); onEnqueued?.('original-run') }, async wake() { wake++; throw new Error('notification failed') }, diagnose() { diagnosed++ } })
    await assert.rejects(service.respond('other', 1, 'synthetic'), /交互不存在/)
    await assert.rejects(service.respond('owner', 1, 'wrong'), /动作无效/)
    const attempts = await Promise.allSettled([service.respond('owner', 1, 'synthetic'), service.respond('owner', 1, 'synthetic')])
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(attempts.find(item => item.status === 'fulfilled')?.value.run_id, 'original-run')
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n), 1)
    assert.equal(wake, 1); assert.equal(diagnosed, 1)
    assert.equal((await pool.query('SELECT status FROM interaction_prompts')).rows[0].status, 'resolved')
    const app = Fastify()
    registerAgentInteractionRespondRoute(app, { async requireUser() {}, userIdFromRequest: () => 'owner', service })
    try {
      const retry = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/1/resume', payload: { token: 'synthetic' } })
      assert.deepEqual(retry.json(), { ok: true, session_id: 7, run_id: 'original-run', status: 'confirmed', option_id: 'confirm' })
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/1/resume', payload: { token: 'wrong' } })).statusCode, 409)
      assert.equal(await service.findResolvedRun?.('other', 1, 'synthetic'), null)
      assert.equal(Number((await pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n), 1)
    } finally { await app.close() }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('文本恢复的 owner 校验、回答和 Run 恢复入队共用事务', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `agent_text_resume_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE interaction_prompts (id integer PRIMARY KEY,user_id text,session_id integer,kind text,status text,expires_at timestamptz,resolved_at timestamptz,schema_json jsonb); CREATE TABLE jobs(prompt_id integer,event_id text)')
    await pool.query("INSERT INTO interaction_prompts VALUES (1,'owner',12,'question','active',clock_timestamp()+interval '1 hour',NULL,$1)", [JSON.stringify({ source: 'agent', allow_text_input: true, context: { tool_call_id: 'call-a' } })])
    await pool.query("INSERT INTO interaction_prompts VALUES (2,'owner',12,'question','active',clock_timestamp()+interval '1 hour',NULL,$1)", [JSON.stringify({ source: 'agent', allow_text_input: true, context: {} })])
    const store = createPostgresInteractionTextStore(pool, async (client, prompt, eventId) => { await client.query('INSERT INTO jobs VALUES ($1,$2)', [prompt.id, eventId ?? null]) })
    await assert.rejects(consumeInteractionText(store, { ownerId: 'other', promptId: 1, text: '回答' }), /交互不存在/)
    await assert.rejects(consumeInteractionText(store, { ownerId: 'owner', promptId: 2, text: '回答' }, () => new Date(Date.now() + 3_600_001)))
    assert.equal((await pool.query('SELECT status FROM interaction_prompts WHERE id=2')).rows[0].status, 'expired')
    const failingStore = createPostgresInteractionTextStore(pool, async () => { throw new Error('enqueue failed') })
    await assert.rejects(consumeInteractionText(failingStore, { ownerId: 'owner', promptId: 1, text: '回答', eventId: 'event-a' }), /enqueue failed/)
    assert.equal((await pool.query('SELECT status FROM interaction_prompts WHERE id=1')).rows[0].status, 'active')
    const answered = await consumeInteractionText(store, { ownerId: 'owner', promptId: 1, text: '合成回答', eventId: 'event-a' })
    assert.equal(answered.result.text, '合成回答')
    assert.equal((await pool.query('SELECT status FROM interaction_prompts WHERE id=1')).rows[0].status, 'resolved')
    assert.deepEqual((await pool.query('SELECT prompt_id,event_id FROM jobs')).rows, [{ prompt_id: 1, event_id: 'event-a' }])
    await assert.rejects(consumeInteractionText(store, { ownerId: 'owner', promptId: 1, text: '重复回答' }), /交互已过期/)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n), 1)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
