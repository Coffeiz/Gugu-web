import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createAgentRunner, type AgentRunnerPorts } from '@gugu/core/agent'
import { withPostgresTransaction } from '../../../src/adapters/database/postgres-transaction.js'
import { createAgentDispatchWorker } from '@gugu/core/agent'
import { enqueueAgentRunLocked, createPostgresAgentDispatch } from '../../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { createPostgresAgentRunStore } from '../../../src/modules/agent-sessions/persistence/agent-run-store-postgres.js'
import { createPostgresAgentRunLeasePort } from '../../../src/modules/agent-sessions/persistence/agent-run-lease-postgres.js'
import { createPostgresInteractionActivator } from '../../../src/modules/agent-sessions/persistence/agent-interaction-activate-postgres.js'
import { createPostgresInteractionProjection } from '../../../src/modules/agent-sessions/persistence/agent-interaction-projection-postgres.js'
import { createInteractionResumeEnqueuer } from '../../../src/modules/agent-sessions/persistence/agent-interaction-resume-postgres.js'
import { createAgentInteractionRespondService } from '../../../src/modules/agent-sessions/agent-interaction-respond.js'
import { createImInteractionRecovery } from '../../../src/modules/im/gateway/interaction-recovery.js'

const pgUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
test('隔离PG：正式DispatchWorker等待结束后，真实交互收据重新取得原Run fence并resume，Web收据不被消费', {
  skip: !pgUrl && '需要显式隔离PG；模型/上下文业务源为明确替身，无平台或付费Provider', timeout: 30000,
}, async () => {
  const { Pool } = await import('pg'), schema = `im_resume_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), secret = randomUUID()
  const admin = new Pool({ connectionString: pgUrl }), pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}`, max: 8 })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,execution_state text DEFAULT 'idle',active_run_id text,pending_message_count integer DEFAULT 0);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,run_id text);
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id text,state text,message_id integer,nonce bytea,payload bytea,request_expires_at timestamptz,token text,fence bigint DEFAULT 0,lease_expires_at timestamptz,cancel_requested boolean DEFAULT false,blocked_reason text,UNIQUE(user_id,session_id,run_id));
      CREATE UNIQUE INDEX selected_session ON agent_run_dispatch(user_id,session_id) WHERE state='selected';
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,token text,fence bigint,expires_at timestamptz,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id));
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,status text,version bigint,sequence bigint,phase text,nonce bytea,payload bytea,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_events(user_id uuid,session_id integer,run_id text,event_id text,sequence bigint,nonce bytea,payload bytea,created_at timestamptz,acknowledged_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,event_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text,created_at timestamptz);
      CREATE TABLE interaction_prompts(id serial PRIMARY KEY,user_id uuid,session_id integer,kind text,title text,body text,schema_json jsonb,status text,expires_at timestamptz,created_at timestamptz,resolved_at timestamptz);
      CREATE TABLE interaction_actions(id serial PRIMARY KEY,prompt_id integer,token_hash text,action_type text,option_id text,context_json jsonb,status text,expires_at timestamptz,created_at timestamptz,consumed_at timestamptz,consumed_event_id text);
      CREATE TABLE agent_interaction_bindings(prompt_id integer PRIMARY KEY,user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text);
      CREATE TABLE agent_interaction_resumes(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,receipt text,created_at timestamptz,completed_at timestamptz,claim_token text,claim_expires_at timestamptz);
      CREATE TABLE mcp_secret_inputs(user_id uuid,session_id integer,status text,encrypted_payload text,payload_nonce text,encrypted_data_key text);
      CREATE TABLE gugu_im_inbound_receipts(user_id uuid,session_id integer,run_id text,state text);
      CREATE TABLE histories(run_id text PRIMARY KEY,body text)`)
    await pool.query('INSERT INTO users VALUES($1)', [owner])
    await pool.query('INSERT INTO conversation_sessions(id,user_id)VALUES(1,$1),(2,$1),(3,$1)', [owner])
    await pool.query("INSERT INTO conversation_messages VALUES(1,1,'user','im-run'),(2,2,'user','web-run'),(3,3,'user','cancelled-run')")
    const identity = { ownerId: owner, sessionId: '1', runId: 'im-run' }
    await pool.query("INSERT INTO agent_run_startups VALUES($1,1,'im-run','pending',clock_timestamp(),clock_timestamp())", [owner])
    await withPostgresTransaction(pool, client => enqueueAgentRunLocked(client, secret, identity, { v: 3, source: 'im', origin: null, userMessageId: 1,
      locale: null, accessVersion: 'a'.repeat(64), im: { platform: 'telegram', botId: '71', chatType: 'c2c', chatId: null, platformUserId: '8181' } }, 3600))
    await pool.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,1,'im-run','dispatched')", [owner])
    const dispatch = createPostgresAgentDispatch(pool, secret, 30000, ['im'])
    const store = createPostgresAgentRunStore<string[]>(pool, secret, { async writeHistory(client, id, history) {
      await client.query('INSERT INTO histories VALUES($1,$2)', [id.runId, history.text])
    } })
    let activeLease: { token: string; fence: number } | null = null, streams = 0, toolExecutions = 0
    let resumeStarted!: () => void, releaseResume!: () => void
    const resumed = new Promise<void>(resolve => { resumeStarted = resolve }), released = new Promise<void>(resolve => { releaseResume = resolve })
    const pending = { id: 'question', kind: 'question' as const, toolCall: { id: 'ask-call', name: 'ask_user_question', input: {} } }
    const cancellations = new Set<string>()
    const ports: AgentRunnerPorts<string[]> = { clock: { now: () => new Date().toISOString() }, store,
      leases: createPostgresAgentRunLeasePort(pool, { dispatchLease: () => activeLease }),
      cancellation: { async isRequested(id) { return cancellations.has(id.runId) }, async request(id) { cancellations.add(id.runId) }, async notify() {}, async subscribe() { return () => {} } },
      provider: { async *stream() { streams++; if (streams === 1) yield { type: 'complete', text: '', calls: [pending.toolCall] }
        else { resumeStarted(); await released; yield { type: 'complete', text: '合成恢复结果', calls: [] } } } },
      context: { async prepare() { return ['合成可信业务源'] }, assertIdentity() {}, async checkpointToolResult(_id, value) { return value }, async restoreToolResult(_id, value) { return value },
        async afterRound(c) { return c }, async afterTool(c) { return c }, async resumeInteraction(c) { return c }, async afterUsage(c) { return { context: c, applied: false } }, async recoverOverflow(c) { return { context: c, applied: false } } },
      tools: { async dispatch() { toolExecutions++; return { kind: 'waiting', interaction: pending } }, async reconcile() { return { kind: 'unknown' } } },
      interactions: createPostgresInteractionActivator(pool, { async describe() { return { kind: 'choice', title: '合成选择', body: '', options: [{ id: 'yes', label: '继续', actionType: 'choice' }], context: {} } } }),
      execution: { async execute() { assert.fail('不应执行外部进程') } }, reply: { async evaluate() { return 'accept' } }, sanitizeText: v => v,
      createStreamSanitizer: () => ({ feed: v => v, flush: () => '' }), presentError: () => ({ code: 'failed', text: '合成失败' }), async presentToolResult(v) { return v }, async publish() {}, diagnose() {} }
    const harness = createAgentRunner(ports)
    const reconstruct = async (lease: Parameters<Parameters<typeof createAgentDispatchWorker<string[]>>[0]['reconstruct']>[0]) => {
      activeLease = lease
      return { harness, cancellation: ports.cancellation, async close() { activeLease = null } }
    }
    assert.equal(await createAgentDispatchWorker({ dispatch, failStart: dispatch.failStart, reconstruct }).runOnce(owner, '1'), 'settled')
    assert.equal((await store.read(identity))?.status, 'waiting')
    assert.equal((await pool.query('SELECT state FROM agent_run_dispatch WHERE run_id=\'im-run\'')).rows[0].state, 'done')
    const interaction = (await store.readEventsAfter(identity, 0)).find(e => e.type === 'interaction_required')!
    const prompt = await createPostgresInteractionProjection(pool).interaction(interaction)
    const respond = createAgentInteractionRespondService({ pool, effects: {
      async applyCommandAction() { assert.fail('普通问题没有命令副作用') }, async redeemConfirmation() { assert.fail('普通问题不兑换确认') },
    }, enqueue: createInteractionResumeEnqueuer(store), async wake() {}, diagnose() {} })
    await respond.respond(owner, prompt.prompt_id, prompt.options[0]!.token, 'synthetic-answer')
    // 独立Web恢复条目不带IM事实，IM pump必须保持它完全未认领。
    await pool.query("INSERT INTO agent_interaction_resumes(user_id,session_id,run_id,prompt_id,interaction_id,receipt,created_at)VALUES($1,2,'web-run',999,'web-question','web-receipt',clock_timestamp())", [owner])
    const recovery = createImInteractionRecovery({ pool, secretKey: secret, dispatch,
      store: store as unknown as Parameters<typeof createImInteractionRecovery>[0]['store'], reconstruct: reconstruct as unknown as Parameters<typeof createImInteractionRecovery>[0]['reconstruct'],
      async invalidateCredential() { assert.fail('普通问题没有MCP凭据') } })
    const signal = new AbortController().signal, running = recovery.pump(signal)
    await resumed; await recovery.pump(signal); releaseResume(); await running
    assert.equal((await store.read(identity))?.status, 'completed'); assert.equal(streams, 2); assert.equal(toolExecutions, 1)
    assert.equal((await pool.query('SELECT body FROM histories')).rows[0].body, '合成恢复结果')
    const im = (await pool.query('SELECT completed_at FROM agent_interaction_resumes WHERE run_id=\'im-run\'')).rows[0]
    assert.ok(im.completed_at)
    const web = (await pool.query('SELECT claim_token,completed_at FROM agent_interaction_resumes WHERE run_id=\'web-run\'')).rows[0]
    assert.equal(web.claim_token, null); assert.equal(web.completed_at, null)
    await recovery.pump(signal); assert.equal(streams, 2)
    const cancelledIdentity = { ...identity, sessionId: '3', runId: 'cancelled-run' }
    await pool.query("INSERT INTO agent_run_startups VALUES($1,3,'cancelled-run','pending',clock_timestamp(),clock_timestamp())", [owner])
    await withPostgresTransaction(pool, client => enqueueAgentRunLocked(client, secret, cancelledIdentity, { v: 3, source: 'im', origin: null, userMessageId: 3,
      locale: null, accessVersion: 'a'.repeat(64), im: { platform: 'telegram', botId: '71', chatType: 'c2c', chatId: null, platformUserId: '8181' } }, 3600))
    await pool.query("INSERT INTO gugu_im_inbound_receipts VALUES($1,3,'cancelled-run','dispatched')", [owner])
    streams = 0
    await createAgentDispatchWorker({ dispatch, failStart: dispatch.failStart, reconstruct }).runOnce(owner, '3')
    assert.equal((await store.read(cancelledIdentity))?.status, 'waiting')
    assert.equal((await pool.query("SELECT state FROM agent_run_dispatch WHERE run_id='cancelled-run'")).rows[0].state, 'done')
    await pool.query("UPDATE agent_run_dispatch SET cancel_requested=true WHERE run_id='cancelled-run'")
    await recovery.pump(signal)
    assert.equal((await store.read(cancelledIdentity))?.status, 'cancelled'); assert.equal(streams, 1)
    assert.equal((await pool.query("SELECT state FROM agent_run_dispatch WHERE run_id='cancelled-run'")).rows[0].state, 'done')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end() }
})
