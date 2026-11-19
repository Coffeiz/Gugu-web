import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import type { ImPreflightScope, ImSecretAction } from '@gugu/core/im/inbound-preflight'
import { createPostgresImSecretInput, ImSecretInputError, stageImSecretPromptLocked, type ImSecretInputPorts } from '../../../src/modules/agent-sessions/persistence/agent-im-secret-input-postgres.js'
import { createPostgresInteractionActivator } from '../../../src/modules/agent-sessions/persistence/agent-interaction-activate-postgres.js'
import { decryptByokCredential, encryptByokEnvelope } from '../../../src/modules/agent/model-config/byok.js'

const owner = '11111111-1111-4111-8111-111111111111', server = '22222222-2222-4222-8222-222222222222'
const scope: ImPreflightScope = { ownerId: owner, botId: '4', platform: 'telegram', chatType: 'c2c', chatId: null, platformUserId: 'member-a', eventId: 'start-a' }
const signal = new AbortController().signal
const fields = [{ name: 'login', label: '账号', type: 'secret' }, { name: 'key', label: '密钥', type: 'secret' }]
const schemaJson = { secret_fields: fields, context: { secret_target: { kind: 'mcp_credentials', server_id: server }, tool_call_id: 'tool-a' } }
function cryptoPorts(): Pick<ImSecretInputPorts, 'encrypt' | 'decrypt'> {
  return { encrypt: values => encryptByokEnvelope(JSON.stringify(values), 'synthetic-only-master', 1),
    decrypt: envelope => decryptByokCredential({ encrypted_value: envelope.ciphertext, nonce: envelope.nonce,
      encrypted_data_key: envelope.encryptedDataKey, key_version: envelope.keyVersion }, () => 'synthetic-only-master') }
}

/** 每条新控制消息先观察，再显式传reference；终态只用于验证服务重放/拒绝边界。 */
async function applyObserved(service: ReturnType<typeof createPostgresImSecretInput>, current: ImPreflightScope, action: ImSecretAction, currentSignal: AbortSignal) {
  const observed = await service.inspectSecret(current, currentSignal)
  return service.applySecret(current, 'reference' in observed ? observed.reference : 'terminal-event-no-active-reference', action, currentSignal)
}

/** 仅替代PG事务/关系读取，SQL过滤和并发锁仍须下方opt-in真实PG验证。 */
function databaseDouble() {
  const initial = { id: 1, prompt_id: 7, session_id: 19, server_id: server, status: 'pending_choice', next_field_index: 0,
    run_id: 'run-a', interaction_id: 'interaction-a', tool_call_id: 'tool-a',
    consumed_event_ids: [] as string[], encrypted_payload: '', payload_nonce: '', encrypted_data_key: '', key_version: 1,
    revision: '2026-11-18T00:00:00.123456Z', admitted: true, schema_json: structuredClone(schemaJson) as Record<string, unknown>, live: true, ended: false }
  let row = structuredClone(initial), promptStatus = 'active', stored: unknown = null, invalidations = 0, resumes = 0, stageReads = 0
  const ordinaryEvents = new Set<string>()
  let transaction: ReturnType<typeof snapshot> | undefined, savepoint: ReturnType<typeof snapshot> | undefined
  const snapshot = () => ({ row: structuredClone(row), promptStatus, stored, invalidations, resumes })
  const restore = (value: ReturnType<typeof snapshot>) => { row = value.row; promptStatus = value.promptStatus; stored = value.stored; invalidations = value.invalidations; resumes = value.resumes }
  const client = { release() {}, async query(sql: string, params: unknown[] = []) {
    const answer = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount })
    if (sql === 'BEGIN') { transaction = snapshot(); return answer() }
    if (sql === 'COMMIT') return answer()
    if (sql === 'ROLLBACK') { restore(transaction!); return answer() }
    if (sql === 'SAVEPOINT im_secret_finish') { savepoint = snapshot(); return answer() }
    if (sql === 'RELEASE SAVEPOINT im_secret_finish') return answer()
    if (sql === 'ROLLBACK TO SAVEPOINT im_secret_finish') { restore(savepoint!); return answer() }
    if (sql.startsWith('SELECT p.schema_json')) return answer(params[0] === owner && params[1] === scope.platform && params[2] === scope.botId &&
      params[3] === 'c2c' && params[4] === scope.platformUserId && params[5] === null && ordinaryEvents.has(String(params[6])) ? [{ schema_json: {} }] : [])
    if (sql.startsWith('SELECT i.id')) {
      stageReads++
      if (sql.includes('AND i.id=$6') && params[5] !== row.id) return answer()
      return answer([{ ...structuredClone(row), admitted: params[4] == null || row.revision <= String(params[4]) }])
    }
    if (sql.startsWith('SELECT id FROM')) return answer([{ id: 1 }])
    if (sql.startsWith('SELECT id,user_id,session_id,kind,status,expires_at,schema_json')) return answer([{ id: 7, user_id: owner, session_id: 19, kind: 'form', status: promptStatus, expires_at: new Date(Date.now() + 60_000), schema_json: row.schema_json }])
    if (sql.startsWith('SELECT id,scope,credential_slots,')) return answer([{ id: server, scope: 'user', credential_slots: [{ id: 'login', target: 'header' }, { id: 'key', target: 'header', prefix: 'Bearer ' }] }])
    if (sql.startsWith('UPDATE user_mcp_servers')) { stored = { ciphertext: params[2], nonce: params[3], encryptedDataKey: params[4], keyVersion: params[5] }; return answer([], 1) }
    if (sql.startsWith('UPDATE interaction_prompts')) {
      promptStatus = 'resolved'; row.live = false
      row.schema_json = JSON.parse(String(params[4] ?? params[2])); return answer([], 1)
    }
    if (sql.startsWith('UPDATE mcp_secret_inputs SET status=$3,encrypted_payload=')) { row.status = String(params[2]); row.encrypted_payload = ''; row.payload_nonce = ''; row.encrypted_data_key = ''; return answer([], 1) }
    if (sql.includes("SET status='awaiting_secret'")) { row.status = 'awaiting_secret'; row.consumed_event_ids = JSON.parse(String(params[1])); return answer([], 1) }
    if (sql.includes("SET status='failed'")) { row.status = 'failed'; row.encrypted_payload = ''; row.payload_nonce = ''; row.encrypted_data_key = ''; row.consumed_event_ids = JSON.parse(String(params[1])); return answer([], 1) }
    if (sql.includes('SET next_field_index=next_field_index+1')) {
      row.next_field_index++; row.consumed_event_ids = JSON.parse(String(params[1])); row.encrypted_payload = String(params[2]); row.payload_nonce = String(params[3]); row.encrypted_data_key = String(params[4]); row.key_version = Number(params[5]); return answer([], 1)
    }
    if (sql.includes('SET next_field_index=$2')) { row.next_field_index = Number(params[1]); row.consumed_event_ids = JSON.parse(String(params[2])); return answer([], 1) }
    if (sql.includes('SET consumed_event_ids=$2')) { row.consumed_event_ids = JSON.parse(String(params[1])); return answer([], 1) }
    throw new Error('数据库替身未实现该操作')
  } } as unknown as PoolClient
  const ports: ImSecretInputPorts = { ...cryptoPorts(), enqueue: async () => { resumes++ }, invalidate: async () => { invalidations++ }, wake: async () => {}, diagnose: () => {} }
  return { pool: { connect: async () => client } as Pick<Pool, 'connect'>, ports, snapshot, stageReads: () => stageReads,
    ordinaryReplay: (eventId: string) => { ordinaryEvents.add(eventId) }, setEnded: () => { row.ended = true }, corrupt: () => { row.encrypted_payload = 'invalid-cipher' },
    mutate: (change: (value: typeof initial) => void) => { change(row) } }
}
test('逐字段秘密输入使用真实envelope及正式业务写入；只提交密文，重放不重复恢复（数据库替身）', async () => {
  const db = databaseDouble(), input = createPostgresImSecretInput(db.pool, db.ports)
  assert.equal((await input.inspectSecret(scope, signal)).status, 'pending_choice')
  assert.deepEqual(await applyObserved(input, scope, { action: 'start' }, signal), { status: 'awaiting_secret', fieldLabel: '账号' })
  assert.deepEqual(await applyObserved(input, { ...scope, eventId: 'field-a' }, { action: 'value', value: 'synthetic-login' }, signal), { status: 'awaiting_secret', fieldLabel: '密钥' })
  assert.doesNotMatch(JSON.stringify(db.snapshot()), /synthetic-login/)
  assert.equal(db.snapshot().row.next_field_index, 1)
  assert.deepEqual(await input.inspectSecret({ ...scope, eventId: 'field-a' }, signal), { status: 'replay' })
  assert.deepEqual(await applyObserved(input, { ...scope, eventId: 'field-b' }, { action: 'value', value: 'synthetic-password' }, signal), { status: 'completed' })
  const final = db.snapshot()
  assert.equal(final.row.encrypted_payload, ''); assert.equal(final.row.payload_nonce, ''); assert.equal(final.row.encrypted_data_key, '')
  assert.equal(final.invalidations, 1); assert.equal(final.resumes, 1)
  assert.deepEqual(await cryptoPorts().decrypt(final.stored as Parameters<ImSecretInputPorts['decrypt']>[0]), JSON.stringify({ login: 'synthetic-login', key: 'synthetic-password' }))
  assert.doesNotMatch(JSON.stringify(final), /synthetic-login|synthetic-password/)
  assert.deepEqual(await applyObserved(input, { ...scope, eventId: 'field-b' }, { action: 'value', value: 'synthetic-password' }, signal), { status: 'replay' })
  assert.equal(db.snapshot().resumes, 1)
})
test('已取消Run不接收秘密；解密失败清空暂存且原异常不外泄（数据库替身）', async () => {
  const db = databaseDouble(), input = createPostgresImSecretInput(db.pool, db.ports)
  db.setEnded()
  assert.deepEqual(await input.inspectSecret(scope, signal), { status: 'ended' })
  await assert.rejects(applyObserved(input, scope, { action: 'start' }, signal), ImSecretInputError)
  const damaged = databaseDouble(), capture = createPostgresImSecretInput(damaged.pool, damaged.ports)
  await applyObserved(capture, scope, { action: 'start' }, signal)
  damaged.corrupt()
  assert.deepEqual(await applyObserved(capture, { ...scope, eventId: 'damaged-a' }, { action: 'value', value: 'synthetic-secret' }, signal), { status: 'failed' })
  assert.equal(damaged.snapshot().row.status, 'failed'); assert.equal(damaged.snapshot().row.encrypted_payload, '')
  assert.doesNotMatch(JSON.stringify(damaged.snapshot()), /synthetic-secret/)
})
test('用户取消走正式恢复事务，失败恢复/失效事务全部回滚（数据库替身）', async () => {
  const db = databaseDouble(), input = createPostgresImSecretInput(db.pool, db.ports)
  assert.deepEqual(await applyObserved(input, scope, { action: 'cancel' }, signal), { status: 'cancelled' })
  assert.equal(db.snapshot().resumes, 1); assert.equal(db.snapshot().row.encrypted_payload, '')
  const broken = databaseDouble(), failing = createPostgresImSecretInput(broken.pool, { ...broken.ports, enqueue: async () => { throw new Error('synthetic-secret') } })
  await assert.rejects(applyObserved(failing, scope, { action: 'cancel' }, signal), error => error instanceof ImSecretInputError && !error.message.includes('synthetic-secret'))
  assert.equal(broken.snapshot().row.status, 'pending_choice'); assert.equal(broken.snapshot().promptStatus, 'active')
})
test('群聊、c2c伪chatId和缺少事件ID不触碰私聊暂存', async () => {
  const db = databaseDouble(), input = createPostgresImSecretInput(db.pool, db.ports)
  for (const other of [{ ...scope, chatType: 'group' as const, chatId: 'group-a' }, { ...scope, chatId: 'private-network-chat-id' }]) {
    assert.deepEqual(await input.inspectSecret(other, signal), { status: 'none' })
    await assert.rejects(applyObserved(input, other, { action: 'start' }, signal), ImSecretInputError)
  }
  await assert.rejects(applyObserved(input, { ...scope, eventId: '' }, { action: 'start' }, signal), ImSecretInputError)
})
test('最终Header凭据校验失败清除已有密文，事务失效失败保留可重试状态（数据库替身）', async () => {
  const db = databaseDouble(), input = createPostgresImSecretInput(db.pool, db.ports)
  await applyObserved(input, scope, { action: 'start' }, signal)
  await applyObserved(input, { ...scope, eventId: 'first-a' }, { action: 'value', value: 'synthetic-login' }, signal)
  assert.deepEqual(await applyObserved(input, { ...scope, eventId: 'invalid-a' }, { action: 'value', value: '无效Header值' }, signal), { status: 'failed' })
  assert.equal(db.snapshot().row.encrypted_payload, ''); assert.equal(db.snapshot().stored, null)
  const retry = databaseDouble(), capture = createPostgresImSecretInput(retry.pool, { ...retry.ports, invalidate: async () => { throw new Error('synthetic-secret') } })
  await applyObserved(capture, scope, { action: 'start' }, signal)
  await applyObserved(capture, { ...scope, eventId: 'first-a' }, { action: 'value', value: 'synthetic-login' }, signal)
  await assert.rejects(applyObserved(capture, { ...scope, eventId: 'last-a' }, { action: 'value', value: 'synthetic-key' }, signal), ImSecretInputError)
  assert.equal(retry.snapshot().row.status, 'awaiting_secret'); assert.equal(retry.snapshot().row.next_field_index, 1)
  assert.equal(retry.snapshot().stored, null); assert.equal(retry.snapshot().resumes, 0)
})
test('加密期间收到取消信号不提交下一字段；清理批量不接受无限或负数', async () => {
  const db = databaseDouble(), controller = new AbortController(), reason = new Error('合成停止')
  const input = createPostgresImSecretInput(db.pool, { ...db.ports, encrypt: values => { if (Object.hasOwn(values, 'login')) controller.abort(reason); return cryptoPorts().encrypt(values) } })
  await applyObserved(input, scope, { action: 'start' }, signal)
  await assert.rejects(applyObserved(input, { ...scope, eventId: 'field-a' }, { action: 'value', value: 'synthetic-login' }, controller.signal), error => error === reason)
  assert.equal(db.snapshot().row.next_field_index, 0); assert.equal(db.snapshot().row.encrypted_payload, '')
  await assert.rejects(input.cleanupExpired(0), RangeError)
  await assert.rejects(input.cleanupExpired(Infinity), RangeError)
})
test('Web及群prompt先跳过IMstage规则，不收紧原Web凭据目标校验', async () => {
  for (const session of [{ source: 'web' }, { source: 'telegram', chat_type: 'group', chat_id: 'group-a', bot_id: '4', platform_user_id: 'member-a' }]) {
    let queries = 0
    const client = { query: async () => { queries++; return { rows: [session] } } } as unknown as PoolClient
    assert.equal(await stageImSecretPromptLocked(client, { ownerId: owner, sessionId: '19', runId: 'run-a' }, 7, 'unchanged-web-target'), false)
    assert.equal(queries, 1)
  }
})
test('旧普通交互事件在新秘密stage期间重放，不捕获值、不推进字段或读取秘密stage', async () => {
  const db = databaseDouble(), input = createPostgresImSecretInput(db.pool, db.ports)
  await applyObserved(input, scope, { action: 'start' }, signal)
  await applyObserved(input, { ...scope, eventId: 'field-a' }, { action: 'value', value: 'synthetic-login' }, signal)
  const original = db.snapshot(), reads = db.stageReads(), replay = { ...scope, eventId: 'old-confirm-event' }
  db.ordinaryReplay(replay.eventId)
  assert.deepEqual(await input.inspectSecret(replay, signal), { status: 'replay' })
  assert.deepEqual(await applyObserved(input, replay, { action: 'value', value: '1' }, signal), { status: 'replay' })
  assert.deepEqual(db.snapshot(), original); assert.equal(db.stageReads(), reads)
})
test('inspect之后普通动作才提交时，apply再次复核收据而不把旧选择当秘密字段', async () => {
  const db = databaseDouble(), input = createPostgresImSecretInput(db.pool, db.ports)
  await applyObserved(input, scope, { action: 'start' }, signal)
  const pending = { ...scope, eventId: 'late-ordinary-event' }
  assert.equal((await input.inspectSecret(pending, signal)).status, 'awaiting_secret')
  db.ordinaryReplay(pending.eventId)
  assert.deepEqual(await applyObserved(input, pending, { action: 'value', value: '继续' }, signal), { status: 'replay' })
  assert.equal(db.snapshot().row.next_field_index, 0); assert.equal(db.snapshot().row.encrypted_payload, '')
})

test('inspect的opaque reference不可缺失/篡改或跨事件复用，重启后同一真实envelope仍可认证', async () => {
  const db = databaseDouble(), first = createPostgresImSecretInput(db.pool, db.ports)
  const observed = await first.inspectSecret(scope, signal)
  if (!('reference' in observed)) throw new Error('缺少活动stage引用')
  assert.match(observed.reference, /^ims1:/)
  assert.doesNotMatch(observed.reference, /synthetic-login|synthetic-password/)
  const before = db.snapshot()
  await assert.rejects(first.applySecret(scope, undefined as unknown as string, { action: 'start' }, signal), ImSecretInputError)
  await assert.rejects(first.applySecret(scope, observed.reference.slice(0, -2) + 'AA', { action: 'start' }, signal), ImSecretInputError)
  await assert.rejects(first.applySecret({ ...scope, eventId: 'different-arrival' }, observed.reference, { action: 'start' }, signal), ImSecretInputError)
  assert.deepEqual(db.snapshot(), before)
  const restarted = createPostgresImSecretInput(db.pool, db.ports)
  assert.equal((await restarted.applySecret(scope, observed.reference, { action: 'start' }, signal)).status, 'awaiting_secret')
})

test('inspect后目标prompt或phase切换不重定向旧值，DB微秒revision单独改变同样拒绝', async () => {
  for (const change of [
    (row: ReturnType<ReturnType<typeof databaseDouble>['snapshot']>['row']) => { row.id++; row.prompt_id++; row.status = 'awaiting_secret' },
    (row: ReturnType<ReturnType<typeof databaseDouble>['snapshot']>['row']) => { row.status = 'awaiting_secret' },
    (row: ReturnType<ReturnType<typeof databaseDouble>['snapshot']>['row']) => { row.revision = '2026-11-18T00:00:00.123457Z' },
    (row: ReturnType<ReturnType<typeof databaseDouble>['snapshot']>['row']) => { row.run_id = 'another-run'; row.interaction_id = 'another-interaction' },
  ]) {
    const db = databaseDouble(), service = createPostgresImSecretInput(db.pool, db.ports)
    const observed = await service.inspectSecret(scope, signal)
    if (!('reference' in observed)) throw new Error('缺少活动stage引用')
    db.mutate(change)
    const changed = db.snapshot()
    await assert.rejects(service.applySecret(scope, observed.reference, { action: 'value', value: 'synthetic-old-secret' }, signal), ImSecretInputError)
    assert.deepEqual(db.snapshot(), changed)
    assert.equal(db.snapshot().stored, null)
  }
})

test('inspect后另一事件推进字段不能把旧值写到下一字段，已消费旧event仍保持replay', async () => {
  const db = databaseDouble(), service = createPostgresImSecretInput(db.pool, db.ports)
  await applyObserved(service, scope, { action: 'start' }, signal)
  const oldScope = { ...scope, eventId: 'waiting-original-value' }, observed = await service.inspectSecret(oldScope, signal)
  if (!('reference' in observed)) throw new Error('缺少活动stage引用')
  await applyObserved(service, { ...scope, eventId: 'other-progress' }, { action: 'value', value: 'synthetic-login' }, signal)
  const advanced = db.snapshot()
  await assert.rejects(service.applySecret(oldScope, observed.reference, { action: 'value', value: 'synthetic-old-secret' }, signal), ImSecretInputError)
  assert.deepEqual(db.snapshot(), advanced)
  assert.equal(db.snapshot().row.next_field_index, 1)
})

test('首次准入时间以数据库微秒精度限制新stage/phase，不能在authorize等待后捕获较早消息', async () => {
  const db = databaseDouble(), service = createPostgresImSecretInput(db.pool, db.ports)
  const cutoff = { ...scope, admissionCutoff: '2026-11-18T00:00:00.123456Z' }
  const initial = await service.inspectSecret(cutoff, signal)
  assert.equal(initial.status, 'pending_choice')
  db.mutate(row => { row.status = 'awaiting_secret'; row.revision = '2026-11-18T00:00:00.123457Z' })
  assert.deepEqual(await service.inspectSecret(cutoff, signal), { status: 'ended' })
  assert.equal((await service.inspectSecret({ ...cutoff, admissionCutoff: '2026-11-18T00:00:00.123457Z' }, signal)).status, 'awaiting_secret')
})

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('正式PG：激活stage、跨scope隔离、并发重复、取消与回滚', { skip: !databaseUrl && '需要显式隔离 PostgreSQL' }, async () => {
  const schema = `im_secret_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean,account_status text);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id text,chat_type text,chat_id text,platform_user_id text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,run_id text,platform_user_id text,chat_type text);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,platform text,bot_id text,chat_type text,session_id integer,message_id integer,run_id text,state text);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean);
      CREATE TABLE user_mcp_servers(id uuid PRIMARY KEY,user_id uuid,scope text,credential_slots jsonb,encrypted_credentials text DEFAULT '',credentials_nonce text DEFAULT '',encrypted_credentials_key text DEFAULT '',credentials_key_version integer DEFAULT 1);
      CREATE TABLE interaction_prompts(id serial PRIMARY KEY,user_id uuid,session_id integer,kind text,title text,body text,schema_json jsonb,status text,expires_at timestamptz,resolved_at timestamptz,created_at timestamptz);
      CREATE TABLE interaction_actions(id serial PRIMARY KEY,prompt_id integer,token_hash text,action_type text,option_id text,context_json jsonb,status text,expires_at timestamptz,created_at timestamptz,consumed_event_id text);
      CREATE TABLE agent_interaction_bindings(prompt_id integer PRIMARY KEY,user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text);
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,status text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,cancel_requested boolean);
      CREATE TABLE mcp_secret_inputs(id serial PRIMARY KEY,prompt_id integer UNIQUE,user_id uuid,server_id uuid,session_id integer,platform text,bot_id text,chat_id text,chat_type text,platform_user_id text,status text,next_field_index integer,consumed_event_ids json,encrypted_payload text,payload_nonce text,encrypted_data_key text,key_version integer,expires_at timestamptz,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE invalidations(owner_id uuid,server_id uuid); CREATE TABLE resumes(prompt_id integer)`)
    await pool.query("INSERT INTO conversation_sessions VALUES(19,$1,'telegram','4','c2c',NULL,'member-a'),(20,$1,'telegram','4','group','group-a','member-a')", [owner])
    await pool.query("INSERT INTO users VALUES($1,true,'active')", [owner])
    await pool.query("INSERT INTO user_bots VALUES(4,$1,'telegram',true)", [owner])
    await pool.query("INSERT INTO user_mcp_servers(id,user_id,scope,credential_slots) VALUES($1,$2,'user',$3)", [server, owner, JSON.stringify([{ id: 'login', target: 'header' }, { id: 'key', target: 'header' }])])
    const activator = createPostgresInteractionActivator(pool, { describe: async () => ({ kind: 'form', title: '凭据', body: '', options: [], context: schemaJson.context, secretFields: fields as Array<{ name: string; label: string; type: 'secret' }> }) })
    const identity = { ownerId: owner, sessionId: '19', runId: 'run-a' }, pending = { id: 'interaction-a', kind: 'credential' as const, toolCall: { id: 'tool-a', name: 'mcp_connect', input: {} } }
    await activator.activate(identity, pending, signal)
    await activator.activate({ ...identity, sessionId: '20', runId: 'group-run' }, { ...pending, id: 'group-interaction' }, signal)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM mcp_secret_inputs')).rows[0].n), 1)
    let wakes = 0
    const input = createPostgresImSecretInput(pool, { ...cryptoPorts(),
      invalidate: async (client, user, target) => { await client.query('INSERT INTO invalidations VALUES($1,$2)', [user, target]) },
      enqueue: async (client, prompt) => { await client.query('INSERT INTO resumes VALUES($1)', [prompt.id]) }, wake: async () => { wakes++ }, diagnose: () => {} })
    for (const change of [{ ownerId: randomUUID() }, { platform: 'qq' as const }, { botId: '5' }, { platformUserId: 'member-b' }])
      assert.deepEqual(await input.inspectSecret({ ...scope, ...change }, signal), { status: 'none' })
    const started = await Promise.all([applyObserved(input, scope, { action: 'start' }, signal), applyObserved(input, scope, { action: 'start' }, signal)])
    assert.deepEqual(started.map(result => result.status).sort(), ['awaiting_secret', 'replay'])
    await applyObserved(input, { ...scope, eventId: 'field-a' }, { action: 'value', value: 'synthetic-login' }, signal)
    assert.doesNotMatch(JSON.stringify((await pool.query('SELECT * FROM mcp_secret_inputs')).rows), /synthetic-login/)
    await applyObserved(input, { ...scope, eventId: 'field-b' }, { action: 'value', value: 'synthetic-key' }, signal)
    assert.equal((await pool.query('SELECT status,encrypted_payload FROM mcp_secret_inputs')).rows[0].status, 'completed')
    assert.equal((await pool.query('SELECT encrypted_payload FROM mcp_secret_inputs')).rows[0].encrypted_payload, '')
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM resumes')).rows[0].n), 1)
    assert.equal(wakes, 1)
    assert.deepEqual(await input.inspectSecret({ ...scope, eventId: 'field-a' }, signal), { status: 'replay' })
    await activator.activate(identity, { ...pending, id: 'expired-interaction' }, signal)
    await pool.query("INSERT INTO interaction_prompts(id,user_id,session_id,kind,schema_json,status,expires_at) VALUES(999,$1,19,'choice','{}','resolved',clock_timestamp()+interval '1 hour')", [owner])
    await pool.query("INSERT INTO agent_interaction_bindings VALUES(999,$1,19,'old-run','old-interaction','old-tool')", [owner])
    await pool.query("INSERT INTO conversation_messages VALUES(99,19,'user','old-run','member-a','c2c')")
    await pool.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,'telegram','4','c2c',19,99,'old-run','dispatched')", [owner])
    await pool.query("INSERT INTO interaction_actions(prompt_id,status,consumed_event_id) VALUES(999,'consumed','old-ordinary-event')")
    assert.deepEqual(await input.inspectSecret({ ...scope, eventId: 'old-ordinary-event' }, signal), { status: 'replay' })
    assert.deepEqual(await applyObserved(input, { ...scope, eventId: 'old-ordinary-event' }, { action: 'value', value: '1' }, signal), { status: 'replay' })
    assert.equal((await pool.query("SELECT next_field_index FROM mcp_secret_inputs WHERE status='pending_choice'")).rows[0].next_field_index, 0)
    // 准入时尚未开始输入的消息，不能因随后start推进phase而捕获为第一个字段。
    const cutoff = (await pool.query('SELECT clock_timestamp()::text AS value')).rows[0].value as string
    const startScope = { ...scope, eventId: 'cutoff-start', admissionCutoff: cutoff }
    const initialStage = await input.inspectSecret(startScope, signal)
    if (!('reference' in initialStage)) throw new Error('活动stage缺少引用')
    await input.applySecret(startScope, initialStage.reference, { action: 'start' }, signal)
    assert.deepEqual(await input.inspectSecret({ ...scope, eventId: 'old-value-arrival', admissionCutoff: cutoff }, signal), { status: 'ended' })
    // 直接调用使用显式新观察；另一事件推进到下一字段后，旧reference不能重定向。
    const staleScope = { ...scope, eventId: 'stale-field-arrival' }, staleStage = await input.inspectSecret(staleScope, signal)
    if (!('reference' in staleStage)) throw new Error('活动stage缺少引用')
    await applyObserved(input, { ...scope, eventId: 'other-field-progress' }, { action: 'value', value: 'synthetic-progress-login' }, signal)
    await assert.rejects(input.applySecret(staleScope, staleStage.reference, { action: 'value', value: 'synthetic-misdirected-secret' }, signal), ImSecretInputError)
    assert.equal((await pool.query("SELECT next_field_index FROM mcp_secret_inputs WHERE status='awaiting_secret'")).rows[0].next_field_index, 1)
    const nextScope = { ...scope, eventId: 'stale-prompt-arrival' }, beforeReplacement = await input.inspectSecret(nextScope, signal)
    if (!('reference' in beforeReplacement)) throw new Error('活动stage缺少引用')
    await activator.activate(identity, { ...pending, id: 'replacement-interaction' }, signal)
    await assert.rejects(input.applySecret(nextScope, beforeReplacement.reference, { action: 'value', value: 'synthetic-misdirected-secret' }, signal), ImSecretInputError)
    assert.equal((await pool.query("SELECT next_field_index FROM mcp_secret_inputs WHERE status='pending_choice'")).rows[0].next_field_index, 0)
    const exactScope = { ...scope, eventId: 'microsecond-revision' }, exactStage = await input.inspectSecret(exactScope, signal)
    if (!('reference' in exactStage)) throw new Error('活动stage缺少引用')
    await pool.query("UPDATE mcp_secret_inputs SET updated_at=updated_at+interval '1 microsecond' WHERE status='pending_choice'")
    await assert.rejects(input.applySecret(exactScope, exactStage.reference, { action: 'start' }, signal), ImSecretInputError)
    await pool.query("UPDATE mcp_secret_inputs SET encrypted_payload='synthetic-cipher',expires_at=clock_timestamp()-interval '1 second' WHERE status='pending_choice'")
    assert.equal(await input.cleanupExpired(), 1)
    assert.equal((await pool.query("SELECT encrypted_payload FROM mcp_secret_inputs WHERE status='expired'")).rows[0].encrypted_payload, '')
    const client = await pool.connect()
    try { await assert.rejects(stageImSecretPromptLocked(client, identity, 999, 'invalid-server')) } finally { client.release() }
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
