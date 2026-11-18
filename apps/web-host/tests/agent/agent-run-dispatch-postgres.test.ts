import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { withPostgresTransaction } from '../../src/adapters/postgres-transaction.js'
import { lockAgentRunSession } from '../../src/domains/agent-sessions/persistence/agent-run-startup-postgres.js'
import { createPostgresAgentDispatch, enqueueAgentRunLocked } from '../../src/domains/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createPostgresAgentRunLeasePort } from '../../src/domains/agent-sessions/persistence/agent-run-lease-postgres.js'

test('聊天运行定位限定 owner，区分不存在、空闲及运行中会话', async () => {
  let rows: Array<{ run_id: string | null }> = []
  const calls: unknown[][] = []
  const pool = { async query(_sql: string, args: unknown[]) { calls.push(args); return { rows } } }
  const dispatch = createPostgresAgentDispatch(pool as never, 'synthetic-key')
  assert.equal(await dispatch.active('owner-a', 1), null)
  rows = [{ run_id: null }]
  assert.deepEqual(await dispatch.active('owner-a', 1), { identity: null })
  rows = [{ run_id: 'run-a' }]
  assert.deepEqual(await dispatch.active('owner-a', 1), { identity: { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' } })
  assert.deepEqual(calls, [['owner-a', 1], ['owner-a', 1], ['owner-a', 1]])
  await assert.rejects(dispatch.active('owner-a', 0))
})
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const interactionTables = `CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text,created_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(user_id,session_id,run_id,receipt));
      CREATE TABLE interaction_prompts(id integer PRIMARY KEY,user_id uuid,session_id integer,kind text,schema_json jsonb,status text,expires_at timestamptz);
      CREATE TABLE agent_interaction_resumes(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,receipt text,created_at timestamptz,completed_at timestamptz,claim_token text,claim_expires_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,prompt_id));`


test('运行定位优先当前运行和选中队列，再恢复等待交互，并隔离 owner', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `active_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,active_run_id text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text);
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,status text,updated_at timestamptz)`)
    const owner = randomUUID(), other = randomUUID(), dispatch = createPostgresAgentDispatch(pool, 'synthetic-key')
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1,NULL)', [owner])
    assert.equal(await dispatch.active(other, 1), null)
    assert.deepEqual(await dispatch.active(owner, 1), { identity: null })
    await pool.query("INSERT INTO agent_run_checkpoints VALUES ($1,1,'waiting','waiting',clock_timestamp())", [owner])
    assert.equal((await dispatch.active(owner, 1))?.identity?.runId, 'waiting')
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,1,'selected','selected')", [owner])
    assert.equal((await dispatch.active(owner, 1))?.identity?.runId, 'selected')
    await pool.query("UPDATE conversation_sessions SET active_run_id='running' WHERE id=1")
    assert.equal((await dispatch.active(owner, 1))?.identity?.runId, 'running')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('调度租约并发仅一人选中，过期只接管原 run，密文绑定 owner 和消息', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `dispatch_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL,execution_state text NOT NULL DEFAULT 'idle',active_run_id text,pending_message_count integer NOT NULL DEFAULT 0);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,run_outcome jsonb);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,token text,fence bigint,expires_at timestamptz,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id));
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,status text);
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,updated_at timestamptz);
      ${interactionTables}
      CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id text,state text,message_id integer,nonce bytea,payload bytea,request_expires_at timestamptz,token text,fence bigint NOT NULL DEFAULT 0,lease_expires_at timestamptz,cancel_requested boolean NOT NULL DEFAULT false,blocked_reason text,UNIQUE(user_id,session_id,run_id));
      CREATE UNIQUE INDEX uq_selected ON agent_run_dispatch(user_id,session_id) WHERE state='selected'`)
    const owner = randomUUID(), other = randomUUID(), identity = { ownerId: owner, sessionId: '1', runId: 'run-one' }
    await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES (1,$1),(2,$2)', [owner, other])
    await pool.query("INSERT INTO conversation_messages(id,session_id,role) VALUES (9,1,'user'),(10,1,'user'),(11,2,'user')")
    const add = (runId: string, userMessageId: number) => withPostgresTransaction(pool, async client => {
      const id = { ...identity, runId }; assert.equal(await lockAgentRunSession(client, id), true)
      await enqueueAgentRunLocked(client, 'synthetic-key', id, { userMessageId, locale: 'zh-CN', origin: 'client-opaque', accessVersion: 'a'.repeat(64), v: 2, source: 'web' }, 60)
    })
    await add('run-one', 9); await add('run-two', 10)
    await add('run-one', 9)
    await assert.rejects(add('run-one', 10), /调度身份冲突/)
    await assert.rejects(add('wrong-message', 11), /调度消息不存在/)
    const stored = await pool.query('SELECT state,payload FROM agent_run_dispatch ORDER BY sequence')
    assert.deepEqual(stored.rows.map(row => row.state), ['selected', 'queued'])
    assert.equal(stored.rows[0].payload.includes(Buffer.from('client-opaque')), false)
    assert.equal((await pool.query('SELECT pending_message_count FROM conversation_sessions WHERE id=1')).rows[0].pending_message_count, 1)
    const service = createPostgresAgentDispatch(pool, 'synthetic-key', 1000)
    assert.deepEqual(await service.listReady(), [{ ownerId: owner, sessionId: '1' }])
    const foreign = { ownerId: other, sessionId: '2', runId: 'foreign-run' }
    await withPostgresTransaction(pool, async client => {
      assert.equal(await lockAgentRunSession(client, foreign), true)
      await enqueueAgentRunLocked(client, 'synthetic-key', foreign, { userMessageId: 11, locale: null, origin: null, accessVersion: 'b'.repeat(64), v: 2, source: 'web' }, 60)
    })
    await pool.query("UPDATE agent_run_dispatch SET nonce=(SELECT nonce FROM agent_run_dispatch WHERE run_id='run-one'),payload=(SELECT payload FROM agent_run_dispatch WHERE run_id='run-one') WHERE run_id='foreign-run'")
    await assert.rejects(service.claim(other, '2'), /无法安全解密/)
    const attempts = await Promise.all([service.claim(owner, '1'), service.claim(owner, '1')])
    const first = attempts.find(Boolean)!
    assert.equal((await service.listReady()).some(item => item.ownerId === owner), false)
    assert.equal(attempts.filter(Boolean).length, 1); assert.equal(first.identity.runId, 'run-one'); assert.equal(first.input.userMessageId, 9); assert.equal(first.mode, 'start')
    assert.deepEqual(await service.requestCancel(owner, '1'), identity)
    assert.equal((await pool.query("SELECT cancel_requested FROM agent_run_dispatch WHERE run_id='run-two'")).rows[0].cancel_requested, false)
    assert.equal(await service.claim(other, '1'), null)
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='run-one'")
    const recovered = await service.claim(owner, '1')
    assert.equal(recovered?.identity.runId, 'run-one'); assert.equal(recovered?.fence, first.fence + 1)
    assert.equal(recovered?.cancelRequested, true)
    await pool.query("INSERT INTO agent_run_startups VALUES ($1,1,'run-one','pending',clock_timestamp())", [owner])
    assert.equal(await service.failStart(first), false)
    assert.equal((await pool.query("SELECT status FROM agent_run_startups WHERE run_id='run-one'")).rows[0].status, 'pending')
    await pool.query("DELETE FROM agent_run_startups WHERE run_id='run-one'")
    assert.equal(await service.renew(first), false); assert.equal(await service.renew(recovered!), true)
    const badCore = createPostgresAgentRunLeasePort(pool, { dispatchLease: () => first })
    assert.equal(await badCore.acquire(identity), null)
    const goodCore = createPostgresAgentRunLeasePort(pool, { dispatchLease: () => recovered })
    const coreLease = await goodCore.acquire(identity)
    assert.ok(coreLease)
    assert.equal(await service.finish(recovered!), false)
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='run-one'")
    assert.equal(await service.renew(recovered!), false)
    assert.equal(await service.claim(owner, '1'), null)
    assert.equal(await service.settleExpired(owner, '1'), false)
    assert.equal((await service.listReady()).some(item => item.ownerId === owner), false)
    await goodCore.release(identity, coreLease)
    // 后半段检查尚未回答的交互；取消请求本身会唤醒等待中的 Run。
    await pool.query("UPDATE agent_run_dispatch SET cancel_requested=false WHERE run_id='run-one'")
    await pool.query("INSERT INTO agent_run_checkpoints VALUES ($1,1,'run-one','waiting')", [owner])
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='run-one'")
    assert.equal(await service.claim(owner, '1'), null)
    await pool.query("UPDATE agent_run_checkpoints SET status='running' WHERE run_id='run-one'")
    const resumed = await service.claim(owner, '1')
    assert.equal(resumed?.mode, 'resume')
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second',request_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='run-one'")
    const expiredResume = await service.claim(owner, '1')
    assert.equal(expiredResume?.mode, 'resume')
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='run-one'")
    assert.equal(await service.settleExpired(owner, '1'), false)
    assert.equal((await pool.query("SELECT state FROM agent_run_dispatch WHERE run_id='run-two'")).rows[0].state, 'queued')
    await pool.query("UPDATE agent_run_dispatch SET request_expires_at=clock_timestamp()+interval '1 minute' WHERE run_id='run-one'")
    const settled = await service.claim(owner, '1')
    assert.ok(settled)
    await pool.query("UPDATE agent_run_checkpoints SET status='completed' WHERE run_id='run-one'")
    assert.equal(await service.finish(resumed!), false)
    assert.equal(await service.finish(settled), true)
    assert.equal((await pool.query("SELECT state FROM agent_run_dispatch WHERE run_id='run-two'")).rows[0].state, 'selected')
    assert.equal((await pool.query('SELECT pending_message_count FROM conversation_sessions WHERE id=1')).rows[0].pending_message_count, 0)
    const second = await service.claim(owner, '1')
    assert.equal(second?.identity.runId, 'run-two')
    await pool.query("INSERT INTO agent_run_checkpoints VALUES ($1,1,'run-two','waiting')", [owner])
    assert.equal(await service.settleExpired(owner, '1'), false)
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='run-two'")
    assert.equal(await service.settleExpired(other, '1'), false)
    assert.equal(await service.settleExpired(owner, '1'), false)
    assert.equal((await pool.query("SELECT state FROM agent_run_dispatch WHERE run_id='run-two'")).rows[0].state, 'selected')
    await pool.query("UPDATE agent_run_dispatch SET request_expires_at=clock_timestamp()-interval '1 second' WHERE run_id IN ('run-one','run-two')")
    assert.equal((await service.listReady()).some(item => item.ownerId === owner && item.sessionId === '1'), true)
    const cleanup = await Promise.all([service.settleExpired(owner, '1'), service.settleExpired(owner, '1')])
    assert.equal(cleanup.filter(Boolean).length, 1)
    const retained = await pool.query("SELECT run_id,octet_length(payload) AS size FROM agent_run_dispatch WHERE run_id IN ('run-one','run-two') ORDER BY run_id")
    assert.equal(retained.rows[0].size, 0)
    assert.ok(retained.rows[1].size > 0) // waiting 仍需恢复材料。
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM conversation_messages WHERE id IN (9,10)')).rows[0].count, 2)
    await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES (3,$1)', [owner])
    await pool.query("INSERT INTO conversation_messages(id,session_id,role) VALUES (12,3,'user'),(13,3,'user')")
    await pool.query("INSERT INTO agent_run_startups VALUES ($1,3,'expired','pending',now()),($1,3,'after-expired','pending',now())", [owner])
    for (const [runId, userMessageId] of [['expired', 12], ['after-expired', 13]] as const) {
      const id = { ownerId: owner, sessionId: '3', runId }
      await withPostgresTransaction(pool, async client => { assert.equal(await lockAgentRunSession(client, id), true); await enqueueAgentRunLocked(client, 'synthetic-key', id, { userMessageId, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2, source: 'web' }, 60) })
    }
    await pool.query("UPDATE agent_run_dispatch SET request_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='expired'")
    const expiry = await Promise.all([service.settleExpired(owner, '3'), service.settleExpired(owner, '3')])
    assert.equal(expiry.filter(Boolean).length, 1)
    const outcome = (await pool.query('SELECT run_outcome FROM conversation_messages WHERE id=12')).rows[0].run_outcome
    assert.equal(outcome.status, 'failed'); assert.equal(outcome.runId, 'expired'); assert.equal(outcome.errorCode, 'dispatch_expired')
    const expiredRow = (await pool.query("SELECT state,octet_length(payload) AS size FROM agent_run_dispatch WHERE run_id='expired'")).rows[0]
    assert.deepEqual(expiredRow, { state: 'done', size: 0 })
    assert.equal((await pool.query("SELECT status FROM agent_run_startups WHERE run_id='expired'")).rows[0].status, 'failed')
    assert.equal((await pool.query("SELECT state FROM agent_run_dispatch WHERE run_id='after-expired'")).rows[0].state, 'selected')
    await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES (4,$1)', [owner])
    await pool.query("INSERT INTO conversation_messages(id,session_id,role) VALUES (14,4,'user')")
    const blockedId = { ownerId: owner, sessionId: '4', runId: 'blocked' }
    await withPostgresTransaction(pool, async client => { assert.equal(await lockAgentRunSession(client, blockedId), true); await enqueueAgentRunLocked(client, 'synthetic-key', blockedId, { userMessageId: 14, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2, source: 'web' }, 60) })
    await pool.query("INSERT INTO agent_run_checkpoints VALUES ($1,4,'blocked','running')", [owner])
    const original = await service.claim(owner, '4'); assert.ok(original)
    assert.equal(await service.setReconstructionStatus(original, 'version_conflict'), true)
    assert.equal(await service.setReconstructionStatus(original, null), false)
    assert.equal(await service.readReconstructionStatus(blockedId), 'version_conflict')
    assert.equal(await service.readReconstructionStatus({ ...blockedId, ownerId: other }), null)
    assert.equal(await service.claim(owner, '4'), null)
    assert.equal(await service.retryReconstruction({ ...blockedId, ownerId: other }), false)
    const retries = await Promise.all([service.retryReconstruction(blockedId), service.retryReconstruction(blockedId)])
    assert.equal(retries.filter(Boolean).length, 1)
    const resumedBlocked = await service.claim(owner, '4'); assert.equal(resumedBlocked?.mode, 'resume')
    assert.equal(await service.setReconstructionStatus(resumedBlocked!, 'unavailable'), true)
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='blocked'")
    const automatic = await service.claim(owner, '4'); assert.equal(automatic?.mode, 'resume')
    assert.equal(await service.setReconstructionStatus(automatic!, null), true)
    assert.equal(await service.readReconstructionStatus(blockedId), null)
    assert.equal((await pool.query("SELECT status FROM agent_run_checkpoints WHERE run_id='blocked'")).rows[0].status, 'running')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

test('旧调度载荷在 Harness 活跃时不标记，释放后阻塞且保留密文和消息', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `dispatch_legacy_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL,execution_state text NOT NULL DEFAULT 'idle',pending_message_count integer NOT NULL DEFAULT 0);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,run_outcome jsonb);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,expires_at timestamptz);
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,status text);
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,updated_at timestamptz);
      ${interactionTables}
      CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id text,state text,message_id integer,nonce bytea,payload bytea,request_expires_at timestamptz,token text,fence bigint NOT NULL DEFAULT 0,lease_expires_at timestamptz,cancel_requested boolean NOT NULL DEFAULT false,blocked_reason text,UNIQUE(user_id,session_id,run_id))`)
    const owner = randomUUID(), id = { ownerId: owner, sessionId: '1', runId: 'legacy' }
    await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES (1,$1)', [owner])
    await pool.query("INSERT INTO conversation_messages(id,session_id,role) VALUES (9,1,'user')")
    await withPostgresTransaction(pool, async client => { assert.equal(await lockAgentRunSession(client, id), true); await enqueueAgentRunLocked(client, 'synthetic-key', id, { userMessageId: 9, locale: null, origin: null, accessVersion: 'a'.repeat(64) }, 60) })
    await pool.query("INSERT INTO agent_run_leases VALUES ($1,1,'legacy',clock_timestamp()+interval '1 minute')", [owner])
    const dispatch = createPostgresAgentDispatch(pool, 'synthetic-key', 1000)
    assert.equal(await dispatch.claim(owner, '1'), null)
    assert.equal((await pool.query('SELECT blocked_reason FROM agent_run_dispatch')).rows[0].blocked_reason, null)
    await pool.query('DELETE FROM agent_run_leases')
    assert.equal(await dispatch.claim(owner, '1'), null)
    const row = (await pool.query('SELECT state,blocked_reason,octet_length(payload) AS bytes FROM agent_run_dispatch')).rows[0]
    assert.equal(row.state, 'selected'); assert.equal(row.blocked_reason, 'version_conflict'); assert.ok(row.bytes > 0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_messages')).rows[0].n, 1)
    assert.deepEqual(await dispatch.listReady(), [])
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})

for (const prompt of [
  { kind: 'confirm', answer: { status: 'confirmed', option_id: 'confirm', confirm: 'true' }, status: 'confirmed' },
  { kind: 'choice', answer: { status: 'selected', option_id: 'option-a', value: 'option-a', text: '选项甲' }, status: 'answered' },
  { kind: 'question', answer: { status: 'selected', option_id: 'option-a', value: 'option-a', text: '选项甲' }, status: 'answered' },
]) test(`等待中的 ${prompt.kind} 只随同一 owner/run 的 dispatch lease 恢复，消费收据后才放行后续消息`, { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `dispatch_interaction_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL,execution_state text NOT NULL DEFAULT 'idle',pending_message_count integer NOT NULL DEFAULT 0);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,run_outcome jsonb);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,expires_at timestamptz);
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,status text,updated_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,updated_at timestamptz);
      ${interactionTables}
      CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id text,state text,message_id integer,nonce bytea,payload bytea,request_expires_at timestamptz,token text,fence bigint NOT NULL DEFAULT 0,lease_expires_at timestamptz,cancel_requested boolean NOT NULL DEFAULT false,blocked_reason text,UNIQUE(user_id,session_id,run_id));
      CREATE UNIQUE INDEX uq_selected ON agent_run_dispatch(user_id,session_id) WHERE state='selected'`)
    const owner = randomUUID(), other = randomUUID(), identity = { ownerId: owner, sessionId: '1', runId: 'waiting-run' }
    await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES (1,$1)', [owner])
    await pool.query("INSERT INTO conversation_messages(id,session_id,role) VALUES (9,1,'user'),(10,1,'user')")
    const add = (runId: string, userMessageId: number) => withPostgresTransaction(pool, async client => {
      const target = { ...identity, runId }
      assert.equal(await lockAgentRunSession(client, target), true)
      await enqueueAgentRunLocked(client, 'synthetic-key', target, { userMessageId, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2, source: 'web' }, 60)
    })
    await add('waiting-run', 9)
    await add('queued-run', 10)
    await pool.query("INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,status) VALUES ($1,1,'waiting-run','waiting')", [owner])
    await pool.query("INSERT INTO interaction_prompts(id,user_id,session_id,kind,schema_json,status,expires_at) VALUES (5,$1,1,$2,$3,'resolved',clock_timestamp()+interval '5 minutes')", [owner, prompt.kind, JSON.stringify({ resolved_result: prompt.answer })])
    await pool.query("INSERT INTO agent_interaction_resumes(user_id,session_id,run_id,prompt_id,interaction_id,receipt,created_at) VALUES ($1,1,'waiting-run',5,'interaction-5','web-prompt:5',clock_timestamp())", [owner])
    const dispatch = createPostgresAgentDispatch(pool, 'synthetic-key', 1000)
    assert.deepEqual(await dispatch.listReady(), [{ ownerId: owner, sessionId: '1' }])
    assert.equal(await dispatch.claim(other, '1'), null)
    const lease = await dispatch.claim(owner, '1')
    assert.equal(lease?.identity.runId, 'waiting-run')
    assert.equal(lease?.mode, 'resume')
    assert.deepEqual(lease?.resolution, { interactionId: 'interaction-5', receiptId: 'web-prompt:5', status: prompt.status, value: prompt.kind === 'confirm' ? null : prompt.answer })
    assert.deepEqual(lease?.interactionResume && { promptId: lease.interactionResume.promptId, receipt: lease.interactionResume.receipt }, { promptId: 5, receipt: 'web-prompt:5' })
    await pool.query("UPDATE agent_interaction_resumes SET claim_expires_at=clock_timestamp()+interval '2 seconds' WHERE prompt_id=5")
    const beforeRenewal = (await pool.query<{ expires_at: Date }>("SELECT claim_expires_at AS expires_at FROM agent_interaction_resumes WHERE prompt_id=5")).rows[0]!.expires_at.getTime()
    assert.equal(await dispatch.renew(lease!), true)
    const afterRenewal = (await pool.query<{ expires_at: Date }>("SELECT claim_expires_at AS expires_at FROM agent_interaction_resumes WHERE prompt_id=5")).rows[0]!.expires_at.getTime()
    assert.ok(afterRenewal > beforeRenewal)
    assert.equal(await dispatch.claim(owner, '1'), null)
    await pool.query("INSERT INTO agent_run_interaction_receipts(user_id,session_id,run_id,receipt) VALUES ($1,1,'waiting-run','web-prompt:5')", [owner])
    assert.equal(await dispatch.finish(lease!), true)
    const resumed = await pool.query("SELECT state FROM agent_run_dispatch WHERE run_id='waiting-run'")
    assert.equal(resumed.rows[0].state, 'selected')
    const completed = await pool.query('SELECT completed_at,claim_token FROM agent_interaction_resumes WHERE prompt_id=5')
    assert.ok(completed.rows[0].completed_at); assert.equal(completed.rows[0].claim_token, null)
    assert.deepEqual(await dispatch.listReady(), [])
    assert.equal((await pool.query("SELECT state FROM agent_run_dispatch WHERE run_id='queued-run'")).rows[0].state, 'queued')
    await pool.query("UPDATE agent_run_checkpoints SET status='completed' WHERE run_id='waiting-run'")
    assert.equal(await dispatch.settleExpired(owner, '1'), true)
    assert.equal((await pool.query("SELECT state FROM agent_run_dispatch WHERE run_id='queued-run'")).rows[0].state, 'selected')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
