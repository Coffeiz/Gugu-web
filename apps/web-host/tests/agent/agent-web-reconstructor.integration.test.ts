import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { contextAccessScopeHash, stableJson } from '@gugu/core/agent'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { createRedisAgentCancellationCommands } from '../../src/adapters/redis-events.js'
import { createRedisLiveSubscription } from '../../src/adapters/redis-live-subscription.js'
import { withPostgresTransaction } from '../../src/adapters/postgres-transaction.js'
import { createAgentDispatchWorker } from '../../src/domains/agent-sessions/agent-dispatch-worker.js'
import { createWebAgentReconstructor, createWebImMemoryLoader, type WebAgentReconstructionResources } from '../../src/domains/agent-sessions/agent-web-reconstructor.js'
import { createPostgresAgentDispatch, enqueueAgentRunLocked } from '../../src/domains/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { lockAgentRunSession } from '../../src/domains/agent-sessions/persistence/agent-run-startup-postgres.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL, redis = process.env.GUGU_WEBUI_TEST_REDIS_URL
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

test('重启后以持久用户锚点及可信作用域重建 Harness，缺服务时保留运行', { skip: !(url && redis) && '需要隔离 PG 和 Redis', timeout: 30000 }, async () => {
  const schema = `web_rebuild_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6 })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL,source text NOT NULL,execution_state text NOT NULL DEFAULT 'idle',active_run_id text,pending_message_count integer NOT NULL DEFAULT 0,context_epoch integer NOT NULL DEFAULT 0,session_context jsonb,snapshot_hash text,session_info_hash text,snapshot_expires_at timestamptz,baseline_message_seq bigint NOT NULL DEFAULT 0,baseline_message_hash text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,content text,content_json jsonb,files jsonb,references_json jsonb,conversation_seq bigint,history_anchor_seq bigint,covers_until_seq bigint,run_id text,round_id text,canonical_batch_id bigint,im_platform_sent_ms bigint,im_event_received_ms bigint,created_at timestamptz,sent_at timestamptz,quoted_text text,platform_user_id text,platform_user_name text,chat_type text);
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,token text,fence bigint,expires_at timestamptz,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id));
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,version bigint,sequence bigint,status text,phase text,nonce bytea,payload bytea,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_events(user_id uuid,session_id integer,run_id text,event_id text,sequence bigint,nonce bytea,payload bytea,created_at timestamptz,acknowledged_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,event_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text,created_at timestamptz);
      CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id text,state text,message_id integer,nonce bytea,payload bytea,request_expires_at timestamptz,token text,fence bigint NOT NULL DEFAULT 0,lease_expires_at timestamptz,cancel_requested boolean NOT NULL DEFAULT false,blocked_reason text,UNIQUE(user_id,session_id,run_id));
      CREATE UNIQUE INDEX selected ON agent_run_dispatch(user_id,session_id) WHERE state='selected';`)
    await pool.query("INSERT INTO conversation_sessions(id,user_id,source) VALUES (1,$1,'qq')", [owner])
    await pool.query("INSERT INTO conversation_messages(id,session_id,role,content,conversation_seq) VALUES (9,1,'user','持久合成问题',1)")
    const identity = { ownerId: owner, sessionId: '1', runId: 'run' }, accessVersion = 'a'.repeat(64)
    await withPostgresTransaction(pool, async client => { assert.equal(await lockAgentRunSession(client, identity), true); await enqueueAgentRunLocked(client, 'synthetic-key', identity, { userMessageId: 9, locale: 'zh-CN', origin: null, accessVersion, v: 2, source: 'web' }, 60) })
    const dispatch = createPostgresAgentDispatch(pool, 'synthetic-key', 1000)
    let available = false, wrongModel = false, releases = 0, calls = 0
    const reconstruct = createWebAgentReconstructor({ pool, secretKey: 'synthetic-key', redis: createRedisAgentCancellationCommands(redis!), subscribe: createRedisLiveSubscription(redis!), readReconstructionStatus: dispatch.readReconstructionStatus, history: { async writeHistory() {} },
      async bind(lease, checkpoint) {
        const selection = { modelIdentity: wrongModel ? 'different-model' : checkpoint?.modelIdentity ?? 'synthetic-model', contextWindow: 10000, locale: 'zh-CN', groupChat: false, contextScopeKey: accessVersion, workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
        const hash = contextAccessScopeHash(lease.identity, selection, digest)
        return { selection, async resolve() { return { modelIdentity: selection.modelIdentity, accessScopeHash: hash, config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '系统' } }, release() { releases++ } }
      },
      async resources() {
        if (!available) return null
        const resources: WebAgentReconstructionResources = {
          source: { now: () => 0, currentRevision: async () => 0, data: { loadTimezone: async () => 'UTC', loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [], loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}), loadMemory: async () => ({}), loadKnowledge: async () => [] }, builder: { buildSnapshot: () => ({ systemPrompt: '系统', snapshotContext: '快照', sessionInfo: {}, userTimezone: 'UTC' }), buildRequest: () => ({ systemPrompt: '系统', systemInMessages: false, fixedPrefix: [] }) } },
          context: { digest, nextId: randomUUID, preparation: { buildRag: async () => ({ tail: [] }) }, prepareRequest: async () => ({ prefix: [], dynamicTail: [] }), references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message }, compaction: { summarize: async () => { throw new Error('意外摘要') } }, finalization: { complete: async () => {} }, currentRequest: () => null, stageContinuation: async () => { throw new Error('意外续接') }, releaseContinuations: async () => {}, diagnoseCompactionFailure() {} },
          preparation: { configuration: async id => ({ identity: { ownerId: id.ownerId, subject: { kind: 'session', id: id.sessionId }, workspaceId: null }, source: 'web', toolNames: [] }), discover: async () => [], capabilities: { workspaceSupported: false, filterConfigured: async values => values, shellPolicy: async () => ({ allowed: false, needsConfirmation: false }), shellState: async () => null, appendShellProtocol: value => value, catalog: async () => null }, formatPrefix: () => [] },
          materialize: async (_id, message) => ({ currentUser: { persistedMessageId: message.id, message: { role: 'user', content: message.content } } }),
          executor: { authorize: async () => { throw new Error('不应执行') }, executor: { execute: async () => { throw new Error('不应执行') } } },
          runtime: { clock: { now: () => new Date().toISOString() }, tools: { dispatch: async () => { throw new Error('不应执行') }, reconcile: async () => ({ kind: 'unknown' }) }, interactions: { activate: async (_id, value) => value }, sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(), presentError: () => ({ code: 'failed', text: '失败' }), presentToolResult: async value => value, publish: async () => {}, diagnose: () => {} },
          provider: { transport: { async request(request) { calls++; assert.match(JSON.stringify(request.body), /持久合成问题/); return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })(), cancel: async () => {} } } } },
        }
        return resources
      },
    })
    const worker = createAgentDispatchWorker({ dispatch, reconstruct, async failStart() { return false } })
    assert.equal(await worker.runOnce(owner, '1'), 'unavailable'); assert.equal(calls, 0); assert.equal(releases, 1)
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='run'")
    available = true
    const claim = await dispatch.claim(owner, '1')
    assert.ok(claim)
    await assert.rejects(reconstruct({ ...claim, input: { ...claim.input, accessVersion: 'b'.repeat(64), v: 2, source: 'web' } }), /版本不匹配/)
    await assert.rejects(reconstruct({ ...claim, identity: { ...identity, ownerId: randomUUID() } }), /消息锚点不存在/)
    assert.equal(calls, 0)
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='run'")
    assert.equal(await worker.runOnce(owner, '1'), 'settled'); assert.equal(calls, 1); assert.equal(releases, 3)
    assert.equal((await pool.query("SELECT status FROM agent_run_checkpoints WHERE run_id='run'")).rows[0].status, 'completed')
    await pool.query("INSERT INTO conversation_sessions(id,user_id,source) VALUES (2,$1,'web')", [owner])
    await pool.query("INSERT INTO conversation_messages(id,session_id,role,content,conversation_seq) VALUES (10,2,'user','持久合成问题',1)")
    const second = { ownerId: owner, sessionId: '2', runId: 'resume-run' }
    await withPostgresTransaction(pool, async client => { assert.equal(await lockAgentRunSession(client, second), true); await enqueueAgentRunLocked(client, 'synthetic-key', second, { userMessageId: 10, locale: 'zh-CN', origin: null, accessVersion, v: 2, source: 'web' }, 60) })
    const initialLease = await dispatch.claim(owner, '2'); assert.ok(initialLease)
    const initial = await reconstruct(initialLease); assert.ok(initial)
    const stream = initial.harness.start(second)
    for (;;) { const event = await stream.next(); if (event.done || event.value.type === 'round_start') break }
    await stream.return(undefined as never); await initial.close()
    assert.equal((await pool.query("SELECT status FROM agent_run_checkpoints WHERE run_id='resume-run'")).rows[0].status, 'running')
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='resume-run'")
    wrongModel = true
    assert.equal(await worker.runOnce(owner, '2'), 'unavailable')
    assert.equal(await dispatch.readReconstructionStatus(second), 'version_conflict')
    assert.equal((await pool.query("SELECT status FROM agent_run_checkpoints WHERE run_id='resume-run'")).rows[0].status, 'running')
    wrongModel = false
    assert.equal(await dispatch.retryReconstruction(second), true)
    assert.equal(await worker.runOnce(owner, '2'), 'settled')
    // 中断发生在 provider 阶段边界；没有可验证的 Provider 恢复点时必须 unknown，不能重发请求。
    assert.equal((await pool.query("SELECT status FROM agent_run_checkpoints WHERE run_id='resume-run'")).rows[0].status, 'unknown')
    assert.equal(calls, 1)
    await pool.query("INSERT INTO conversation_sessions(id,user_id,source) VALUES (3,$1,'web')", [owner])
    await pool.query("INSERT INTO conversation_messages(id,session_id,role,content,conversation_seq) VALUES (11,3,'user','持久合成问题',1)")
    const third = { ownerId: owner, sessionId: '3', runId: 'prepare-resume' }
    await withPostgresTransaction(pool, async client => { assert.equal(await lockAgentRunSession(client, third), true); await enqueueAgentRunLocked(client, 'synthetic-key', third, { userMessageId: 11, locale: 'zh-CN', origin: null, accessVersion, v: 2, source: 'web' }, 60) })
    const preparedLease = await dispatch.claim(owner, '3'); assert.ok(preparedLease)
    const prepared = await reconstruct(preparedLease); assert.ok(prepared)
    const interrupted = prepared.harness.start(third)
    const firstStep = await interrupted.next()
    assert.equal(firstStep.done, false)
    if (!firstStep.done) assert.equal(firstStep.value.type, 'run_started')
    await interrupted.return(undefined as never); await prepared.close()
    assert.equal((await pool.query("SELECT status FROM agent_run_checkpoints WHERE run_id='prepare-resume'")).rows[0].status, 'preparing')
    await pool.query("UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE run_id='prepare-resume'")
    assert.equal(await worker.runOnce(owner, '3'), 'settled')
    assert.equal((await pool.query("SELECT status FROM agent_run_checkpoints WHERE run_id='prepare-resume'")).rows[0].status, 'completed')
    assert.equal(calls, 2)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})


test('可信 Web 请求仅对绑定 owner 与 session 提供空 IM memory，支持取消', async () => {
  const lease = { identity: { ownerId: 'owner', sessionId: '1', runId: 'run' }, token: 'token', fence: 1, mode: 'start' as const, cancelRequested: false, input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64) } }
  const load = createWebImMemoryLoader(lease)
  assert.deepEqual(await load({ ownerId: 'owner', sessionId: '1' }), {})
  await assert.rejects(load({ ownerId: 'other', sessionId: '1' }))
  await assert.rejects(load({ ownerId: 'owner', sessionId: '2' }))
  const controller = new AbortController(); controller.abort()
  await assert.rejects(load({ ownerId: 'owner', sessionId: '1' }, controller.signal))
  assert.throws(() => createWebImMemoryLoader({ ...lease, input: { ...lease.input, v: undefined, source: undefined } }))
})
