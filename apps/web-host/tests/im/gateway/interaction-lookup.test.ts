import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import type { ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { createAgentInteractionRespondService } from '../../../src/modules/agent-sessions/agent-interaction-respond.js'
import { consumeInteractionAction } from '@gugu/core/agent/interactions/consume-action'
import { createPostgresInteractionConsumeStore } from '../../../src/modules/agent-sessions/persistence/agent-interaction-consume-postgres.js'
import { createPostgresImTextChoiceConsumer, ImInteractionLookupError, type ImInteractionTarget } from '../../../src/modules/im/gateway/interaction-lookup.js'

const owner = '11111111-1111-4111-8111-111111111111'
const scope: ImPreflightScope = { ownerId: owner, botId: '4', platform: 'telegram', chatType: 'group', chatId: 'group-a', platformUserId: 'member-a', eventId: 'event-a' }
const signal = new AbortController().signal
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

/** 关系读取/事务/恢复队列替身；正式projection、respond、动作及文本消费均实际执行。 */
function fixture(kind = 'choice', gate?: (target?: ImInteractionTarget) => boolean) {
  const expiry = new Date(Date.now() + 60_000), started = new Date()
  let prompt = { id: 7, user_id: owner, session_id: 19, kind, title: '合成选择', body: '', schema_json: {
    source: 'agent', allow_text_input: kind === 'question', options: [{ id: 'yes', label: '继续' }, { id: 'no', label: '停止' }],
    context: { tool_call_id: 'tool-a' },
  } as Record<string, unknown>, status: 'active', expires_at: expiry, resolved_at: null as Date | null, created_at: started }
  let actions = [
    { id: 8, prompt_id: 7, option_id: 'yes', token_hash: hash('button-yes'), action_type: 'choice', context_json: { tool_call_id: 'tool-a' }, status: 'pending', expires_at: expiry, consumed_at: null as Date | null, consumed_event_id: null as string | null },
    { id: 9, prompt_id: 7, option_id: 'no', token_hash: hash('button-no'), action_type: 'choice', context_json: { tool_call_id: 'tool-a' }, status: 'pending', expires_at: expiry, consumed_at: null as Date | null, consumed_event_id: null as string | null },
  ]
  let rotates = 0, resumes = 0, permission = true, anchor = true, storageFailed = false
  let snapshot: { prompt: typeof prompt; actions: typeof actions; resumes: number } | undefined
  const joined = () => ({ ...structuredClone(prompt), run_id: 'run-a', interaction_id: 'interaction-a', tool_call_id: 'tool-a' })
  const client = { release() {}, async query(sql: string, params: unknown[] = []) {
    const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount })
    if (sql === 'BEGIN') { snapshot = { prompt: structuredClone(prompt), actions: structuredClone(actions), resumes }; return result() }
    if (sql === 'COMMIT') return result()
    if (sql === 'ROLLBACK') { prompt = snapshot!.prompt; actions = snapshot!.actions; resumes = snapshot!.resumes; return result() }
    if (storageFailed) throw new Error('synthetic-secret-platform-response')
    if (sql.startsWith('SELECT p.id,p.session_id,p.kind,p.schema_json') || sql.startsWith('SELECT p.schema_json')) {
      const match = anchor && params[0] === owner && params[1] === scope.platform && params[2] === scope.botId && params[3] === scope.chatType && params[4] === scope.platformUserId && params[5] === scope.chatId
      if (!match) return result()
      if (sql.includes('consumed_event_id=$7')) return result(actions.some(action => action.status === 'consumed' && action.consumed_event_id === params[6]) || prompt.schema_json.node_text_consumed_event_id === params[6] ? [joined()] : [])
      return result(prompt.status === 'active' ? [joined()] : [])
    }
    if (sql.startsWith('SELECT option_id')) return result(actions.filter(action => action.status === 'pending').map(action => ({ option_id: action.option_id })))
    if (sql.startsWith('SELECT p.id,p.session_id,p.kind,p.title')) return result([prompt])
    if (sql.startsWith('SELECT id,option_id')) return result(actions)
    if (sql.startsWith('UPDATE interaction_actions SET token_hash')) {
      const found = actions.find(action => action.id === params[1] && action.status === 'pending')
      if (!found) return result()
      found.token_hash = String(params[0]); rotates++; return result([], 1)
    }
    if (sql.startsWith('SELECT id, user_id') || sql.startsWith('SELECT id,user_id')) return result(params[0] === 7 && params[1] === owner ? [prompt] : [])
    if (sql.startsWith('SELECT id, prompt_id')) return result(actions.filter(action => action.prompt_id === params[0] && action.token_hash === params[1]))
    if (sql.startsWith('UPDATE interaction_prompts SET status')) {
      prompt.status = String(params[2]); prompt.resolved_at = params[3] as Date; prompt.schema_json = JSON.parse(String(params[4])); return result([], 1)
    }
    if (sql.startsWith('UPDATE interaction_actions SET status')) {
      const found = actions.find(action => action.id === params[0])!
      found.status = String(params[2]); found.consumed_at = params[3] as Date; found.consumed_event_id = params[4] as string; return result([], 1)
    }
    throw new Error('数据库替身未实现该操作')
  } } as unknown as PoolClient
  const pool = { connect: async () => client } as Pick<Pool, 'connect'>
  const service = createAgentInteractionRespondService({ pool, effects: { applyCommandAction: async () => { throw new Error('未授权命令') }, redeemConfirmation: async () => true },
    enqueue: async () => { resumes++ }, wake: async () => {}, diagnose: () => {} })
  const consumer = createPostgresImTextChoiceConsumer({ pool, service, authorize: async (_scope, _signal, target) => permission && (gate ? gate(target) : true) })
  return { consumer, stats: () => ({ prompt, actions, rotates, resumes }), revoke: () => { permission = false },
    noAnchor: () => { anchor = false }, failStorage: () => { storageFailed = true }, modify: (run: (value: typeof prompt) => void) => run(prompt) }
}
test('普通文本不匹配不轮换按钮；匹配后仅所选动作rotate并经正式respond恢复一次', async () => {
  const f = fixture()
  assert.equal(await f.consumer(scope, '普通问题', signal), null)
  assert.equal(f.stats().rotates, 0); assert.equal(f.stats().actions[0]!.token_hash, hash('button-yes'))
  assert.deepEqual(await f.consumer(scope, '1', signal), { status: 'selected', text: '继续' })
  assert.equal(f.stats().rotates, 1); assert.equal(f.stats().actions[1]!.token_hash, hash('button-no'))
  assert.equal(f.stats().resumes, 1)
  assert.deepEqual(await f.consumer(scope, '1', signal), { status: 'replay' })
  assert.equal(f.stats().rotates, 1); assert.equal(f.stats().resumes, 1)
})
test('自定义文本经正式文本服务保存事件收据，同scope重放不再写恢复任务', async () => {
  const f = fixture('question')
  f.modify(prompt => { prompt.schema_json.options = []; prompt.schema_json.allow_text_input = true })
  assert.deepEqual(await f.consumer(scope, '合成回答', signal), { status: 'selected', text: '合成回答' })
  assert.equal(f.stats().rotates, 0); assert.equal(f.stats().prompt.schema_json.node_text_consumed_event_id, 'event-a')
  assert.deepEqual(await f.consumer(scope, '合成回答', signal), { status: 'replay' })
  assert.equal(f.stats().resumes, 1)
})
test('数据库端口替身下不同owner/Bot/平台/群/speaker均不消费，缺真实run锚点也不消费', async () => {
  for (const change of [{ ownerId: randomUUID() }, { botId: '5' }, { platform: 'qq' as const }, { chatId: 'group-b' }, { platformUserId: 'member-b' }]) {
    const f = fixture()
    assert.equal(await f.consumer({ ...scope, ...change }, '1', signal), null)
    assert.equal(f.stats().rotates, 0); assert.equal(f.stats().resumes, 0)
  }
  const f = fixture(); f.noAnchor()
  assert.equal(await f.consumer(scope, '1', signal), null); assert.equal(f.stats().rotates, 0)
})
test('声明序号不因已消费选项移动；secret prompt不向普通文本服务投影或误记replay', async () => {
  const f = fixture()
  f.stats().actions[0]!.status = 'consumed'
  assert.equal(await f.consumer(scope, '1', signal), null)
  assert.deepEqual(await f.consumer(scope, '2', signal), { status: 'selected', text: '停止' })
  const secret = fixture()
  secret.modify(prompt => { prompt.schema_json.secret_fields = [{ name: 'key' }]; prompt.schema_json.context = { secret_target: { kind: 'mcp_credentials' } }; prompt.schema_json.node_text_consumed_event_id = scope.eventId })
  assert.equal(await secret.consumer(scope, '1', signal), null)
  assert.equal(secret.stats().rotates, 0)
})
test('撤权和取消信号不触发token轮换，错误不暴露底层数据', async () => {
  const f = fixture(); f.revoke()
  await assert.rejects(f.consumer(scope, '1', signal), ImInteractionLookupError)
  assert.equal(f.stats().rotates, 0)
  const controller = new AbortController(), reason = new Error('合成停止'); controller.abort(reason)
  await assert.rejects(f.consumer(scope, '1', controller.signal), error => error === reason)
})
test('匹配后携带真实Run和tool绑定重新授权，撤权发生在投影前不轮换按钮', async () => {
  let checks = 0
  const f = fixture('choice', target => {
    checks++
    if (!target) return true
    assert.deepEqual(target, { identity: { ownerId: owner, sessionId: '19', runId: 'run-a' }, promptId: 7, toolCallId: 'tool-a' })
    return false
  })
  await assert.rejects(f.consumer(scope, '1', signal), ImInteractionLookupError)
  assert.equal(checks, 2); assert.equal(f.stats().rotates, 0); assert.equal(f.stats().resumes, 0)
})
test('关系读取故障保持静态错误，不向上层暴露响应或token', async () => {
  const f = fixture(); f.failStorage()
  await assert.rejects(f.consumer(scope, '1', signal), error => error instanceof ImInteractionLookupError && !error.message.includes('synthetic-secret'))
  assert.equal(f.stats().rotates, 0)
})

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('正式PG lookup：scope、单动作token轮换、文本replay及Web私聊锚点', { skip: !url && '需要显式隔离 PostgreSQL' }, async () => {
  const schema = `im_lookup_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id text,chat_type text,chat_id text,platform_user_id text,updated_at timestamptz);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,run_id text,platform_user_id text,chat_type text);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,platform text,bot_id text,chat_type text,session_id integer,message_id integer,run_id text,state text);
      CREATE TABLE interaction_prompts(id integer PRIMARY KEY,user_id uuid,session_id integer,kind text,title text,body text,schema_json jsonb,status text,expires_at timestamptz,created_at timestamptz,resolved_at timestamptz);
      CREATE TABLE interaction_actions(id integer PRIMARY KEY,prompt_id integer,option_id text,token_hash text,action_type text,context_json jsonb,status text,expires_at timestamptz,consumed_at timestamptz,consumed_event_id text);
      CREATE TABLE agent_interaction_bindings(prompt_id integer,user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text);
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,status text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,cancel_requested boolean);
      CREATE TABLE resumes(prompt_id integer)`)
    await pool.query("INSERT INTO users VALUES($1,true,'active')", [owner])
    await pool.query("INSERT INTO user_bots VALUES(4,$1,'telegram',true)", [owner])
    await pool.query("INSERT INTO conversation_sessions VALUES(19,$1,'telegram','4','group','group-a','other-member',clock_timestamp()),(20,$1,'web',NULL,'c2c',NULL,NULL,clock_timestamp())", [owner])
    for (const id of [19, 20]) {
      const chatType = id === 19 ? 'group' : 'c2c'
      await pool.query('INSERT INTO conversation_messages VALUES($1,$1,\'user\',$2,\'member-a\',$3)', [id, `run-${id}`, chatType])
      await pool.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,'telegram','4',$2,$3,$3,$4,'dispatched')", [owner, chatType, id, `run-${id}`])
      const promptSchema = { source: 'agent', allow_text_input: id === 20, options: id === 19 ? [{ id: 'yes', label: '继续' }, { id: 'no', label: '停止' }] : [], context: { tool_call_id: 'tool-a' } }
      await pool.query("INSERT INTO interaction_prompts VALUES($1,$2,$1,$3,'合成选择','',$4,'active',clock_timestamp()+interval '1 hour',clock_timestamp(),NULL)", [id, owner, id === 19 ? 'choice' : 'question', JSON.stringify(promptSchema)])
      await pool.query("INSERT INTO agent_interaction_bindings VALUES($1,$2,$1,$3,$4,'tool-a')", [id, owner, `run-${id}`, `interaction-${id}`])
      await pool.query("INSERT INTO agent_run_checkpoints VALUES($1,$2,$3,'waiting')", [owner, id, `run-${id}`])
    }
    await pool.query("INSERT INTO interaction_actions VALUES(1,19,'yes',$1,'choice',$3,'pending',clock_timestamp()+interval '1 hour',NULL,NULL),(2,19,'no',$2,'choice',$3,'pending',clock_timestamp()+interval '1 hour',NULL,NULL)", [hash('button-yes'), hash('button-no'), JSON.stringify({ tool_call_id: 'tool-a' })])
    const service = createAgentInteractionRespondService({ pool, effects: { applyCommandAction: async () => { throw new Error('不应执行命令') }, redeemConfirmation: async () => true },
      enqueue: async (client, prompt) => { await client.query('INSERT INTO resumes VALUES($1)', [prompt.id]) }, wake: async () => {}, diagnose: () => {} })
    const consume = createPostgresImTextChoiceConsumer({ pool, service, authorize: async () => true })
    const beforeCreation = { ...scope, admissionCutoff: '2000-01-01 00:00:00.000001+00' }
    assert.equal(await consume(beforeCreation, '1', signal), null)
    assert.equal((await pool.query('SELECT token_hash FROM interaction_actions WHERE id=1')).rows[0].token_hash, hash('button-yes'))
    const admissionCutoff = (await pool.query('SELECT clock_timestamp()::text AS value')).rows[0].value as string
    // 同一prompt后来进入自定义输入阶段，不得接收该阶段之前准入的旧普通文本。
    await pool.query("UPDATE interaction_prompts SET schema_json=jsonb_set(schema_json,'{custom_input_active}','true'::jsonb) WHERE id=20")
    await pool.query("INSERT INTO interaction_actions VALUES(3,20,'__custom_reply__',$1,'custom_reply','{}','consumed',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 second','phase-event')", [hash('custom-phase')])
    const privateBeforePhase = { ...scope, chatType: 'c2c' as const, chatId: null, eventId: 'old-text', admissionCutoff }
    assert.equal(await consume(privateBeforePhase, '旧普通文本', signal), null)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM resumes')).rows[0].n), 0)
    await pool.query("UPDATE interaction_actions SET consumed_at=$1::timestamptz-interval '1 microsecond' WHERE id=3", [admissionCutoff])
    assert.equal(await consume(scope, '普通问题', signal), null)
    assert.equal((await pool.query('SELECT token_hash FROM interaction_actions WHERE id=1')).rows[0].token_hash, hash('button-yes'))
    for (const change of [{ ownerId: randomUUID() }, { botId: '5' }, { platform: 'qq' as const }, { chatId: 'group-b' }, { platformUserId: 'other-member' }])
      assert.equal(await consume({ ...scope, ...change }, '1', signal), null)
    await pool.query("UPDATE interaction_actions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=1")
    assert.equal(await consume(scope, '1', signal), null)
    await pool.query("UPDATE interaction_actions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=1")
    // 一个Run包含同一发言人的多条输入，JOIN得到多个等价锚点仍须允许该发起者恢复。
    await pool.query("INSERT INTO conversation_messages VALUES(119,19,'user','run-19','member-a','group')")
    await pool.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,'telegram','4','group',19,119,'run-19','dispatched')", [owner])
    assert.deepEqual(await consume({ ...scope, admissionCutoff }, '1', signal), { status: 'selected', text: '继续' })
    assert.equal((await pool.query('SELECT token_hash FROM interaction_actions WHERE id=2')).rows[0].token_hash, hash('button-no'))
    assert.deepEqual(await consume(scope, '1', signal), { status: 'replay' })
    await pool.query("UPDATE interaction_prompts SET schema_json=jsonb_set(schema_json,'{custom_input_active}','false'::jsonb) WHERE id=20")
    await pool.query("UPDATE interaction_actions SET status='pending',consumed_at=NULL,consumed_event_id=NULL WHERE id=3")
    const beforePhase = (await pool.query('SELECT clock_timestamp()::text AS value')).rows[0].value as string
    const actionStore = createPostgresInteractionConsumeStore(pool, { applyCommandAction: async () => { throw new Error('不应执行命令') }, redeemConfirmation: async () => true })
    const phase = await consumeInteractionAction(actionStore, { ownerId: owner, promptId: 20, token: 'custom-phase', eventId: 'activate-custom' }, () => new Date(0))
    assert.equal(phase.result.status, 'awaiting_text')
    assert.equal((await pool.query('SELECT consumed_at>$1::timestamptz AS newer FROM interaction_actions WHERE id=3', [beforePhase])).rows[0].newer, true)
    assert.equal(await consume({ ...privateBeforePhase, admissionCutoff: beforePhase }, '阶段前普通文本', signal), null)
    const afterPhase = (await pool.query('SELECT clock_timestamp()::text AS value')).rows[0].value as string
    const privateScope = { ...scope, chatType: 'c2c' as const, chatId: null, eventId: 'private-event', admissionCutoff: afterPhase }
    assert.deepEqual(await consume(privateScope, '合成回答', signal), { status: 'selected', text: '合成回答' })
    assert.deepEqual(await consume(privateScope, '合成回答', signal), { status: 'replay' })
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM resumes')).rows[0].n), 2)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
