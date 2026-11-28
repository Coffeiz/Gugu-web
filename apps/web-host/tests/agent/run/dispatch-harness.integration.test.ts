import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createAgentDispatchRuntime, createAgentRunner, type AgentRunnerPorts } from '@gugu/core/agent'
import { createRedisAgentCancellationCommands } from '../../../src/adapters/cache/redis-events.js'
import { createRedisLiveSubscription } from '../../../src/adapters/cache/redis-live-subscription.js'
import { withPostgresTransaction } from '../../../src/adapters/database/postgres-transaction.js'
import { createAgentRunEventStream } from '../../../src/modules/agent/run/stream.js'
import { createPostgresAgentDispatch, enqueueAgentRunLocked, type AgentDispatchLease } from '../../../src/modules/agent/run/dispatch.js'
import { lockAgentRunSession } from '../../../src/modules/agent/run/start.js'
import { createPostgresAgentRunLeasePort } from '../../../src/modules/agent/run/lease.js'
import { createPostgresAgentRunStore } from '../../../src/modules/agent/run/store.js'
import { createRedisAgentRunCancellationPort } from '../../../src/modules/agent/run/cancel.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL, redis = process.env.GUGU_WEBUI_TEST_REDIS_URL

test('持久调度经真实 PG、Redis 与 Harness 按顺序取消首轮并执行后续运行', { skip: !(url && redis) && '需要隔离 PG 和 Redis', timeout: 30000 }, async () => {
  const schema = `dispatch_harness_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 5 })
  try {
    await pool.query(`CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL,execution_state text NOT NULL DEFAULT 'idle',active_run_id text,pending_message_count integer NOT NULL DEFAULT 0);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text);
      CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,token text,fence bigint,expires_at timestamptz,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id));
      CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,version bigint,sequence bigint,status text,phase text,nonce bytea,payload bytea,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
      CREATE TABLE agent_run_events(user_id uuid,session_id integer,run_id text,event_id text,sequence bigint,nonce bytea,payload bytea,created_at timestamptz,acknowledged_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,event_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text,created_at timestamptz);
      CREATE TABLE interaction_prompts(id integer PRIMARY KEY,user_id uuid,session_id integer,status text);
      CREATE TABLE agent_interaction_resumes(user_id uuid,session_id integer,run_id text,prompt_id integer,receipt text,completed_at timestamptz,claim_expires_at timestamptz);
      CREATE TABLE agent_run_dispatch(sequence bigserial PRIMARY KEY,user_id uuid,session_id integer,run_id text,state text,message_id integer,nonce bytea,payload bytea,request_expires_at timestamptz,token text,fence bigint NOT NULL DEFAULT 0,lease_expires_at timestamptz,cancel_requested boolean NOT NULL DEFAULT false,blocked_reason text,UNIQUE(user_id,session_id,run_id));
      CREATE UNIQUE INDEX selected ON agent_run_dispatch(user_id,session_id) WHERE state='selected';`)
    await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES (1,$1)', [owner])
    await pool.query("INSERT INTO conversation_messages VALUES (1,1,'user'),(2,1,'user')")
    for (const [runId, message] of [['first', 1], ['second', 2]] as const) {
      const identity = { ownerId: owner, sessionId: '1', runId }
      await withPostgresTransaction(pool, async client => { assert.equal(await lockAgentRunSession(client, identity), true); await enqueueAgentRunLocked(client, 'synthetic-secret', identity, { userMessageId: message, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2, source: 'web' }, 60) })
    }
    const dispatch = createPostgresAgentDispatch(pool, 'synthetic-secret', 30000)
    const selected = await dispatch.requestCancel(owner, '1'); assert.equal(selected?.runId, 'first')
    const commands = createRedisAgentCancellationCommands(redis!)
    const subscribe = createRedisLiveSubscription(redis!)
    const cancellation = createRedisAgentRunCancellationPort(commands, subscribe)
    const store = createPostgresAgentRunStore<string[]>(pool, 'synthetic-secret', { async writeHistory() {} })
    let providerCalls = 0
    async function reconstruct(lease: AgentDispatchLease) {
      const ports: AgentRunnerPorts<string[]> = {
        clock: { now: () => new Date().toISOString() }, store, leases: createPostgresAgentRunLeasePort(pool, { dispatchLease: () => lease }), cancellation,
        provider: { async *stream() { providerCalls++; yield { type: 'token', text: '合成回复' }; yield { type: 'complete', text: '合成回复', calls: [] } } },
        context: { assertIdentity: () => {}, checkpointToolResult: async (_s, value) => value, restoreToolResult: async (_s, value) => value, prepare: async () => ['ready'], afterRound: async context => context, afterTool: async context => context, resumeInteraction: async context => context, recoverOverflow: async context => ({ context, applied: false }), afterUsage: async context => ({ context, applied: false }) },
        tools: { async dispatch() { throw new Error('不应执行') }, async reconcile() { return { kind: 'unknown' } } }, interactions: { async activate(_id, value) { return value } },
        execution: { async execute() { throw new Error('不应执行') } }, reply: { async evaluate() { return 'accept' } }, sanitizeText: text => text,
        createStreamSanitizer: () => ({ feed: text => text, flush: () => '' }), presentError: () => ({ code: 'failed', text: '失败' }), presentToolResult: async value => value,
        async publish() {}, diagnose() {},
      }
      return { harness: createAgentRunner(ports), cancellation, async close() {} }
    }
    let resolved!: () => void
    const finished = new Promise<void>(resolve => { resolved = resolve })
    const runtime = createAgentDispatchRuntime({
      dispatch: {
        ...dispatch,
        async finish(lease) {
          const settled = await dispatch.finish(lease)
          if (settled && lease.identity.runId === 'second') resolved()
          return settled
        },
      },
      worker: { reconstruct },
      supervisor: { publish: commands.publish, subscribe, diagnose: () => {}, recoveryIntervalMs: 1000 },
      chat: {
        cancellation,
        async prepare() { throw new Error('测试直接从持久队列恢复') },
        events: createAgentRunEventStream({ readEventsAfter: store.readEventsAfter, readState: store.read }, commands, subscribe),
        async project(event) { return [{ type: event.type }] },
        async failStart() { throw new Error('持久调度不应经直接模式结算启动') },
      },
    })
    // 入队后才启动调度器，验证进程重启时从持久记录扫描恢复。
    await runtime.start()
    const streamTimeout = new AbortController()
    const timeout = setTimeout(() => { streamTimeout.abort() }, 10000)
    try { await Promise.race([finished, new Promise<never>((_, reject) => streamTimeout.signal.addEventListener('abort', () => reject(new Error('调度超时')), { once: true }))]) }
    finally { clearTimeout(timeout); await runtime.close() }
    assert.equal((await store.read({ ownerId: owner, sessionId: '1', runId: 'first' }))?.status, 'cancelled')
    assert.equal((await store.read({ ownerId: owner, sessionId: '1', runId: 'second' }))?.status, 'completed')
    assert.equal(providerCalls, 1)
    assert.deepEqual((await pool.query('SELECT state FROM agent_run_dispatch ORDER BY sequence')).rows.map(row => row.state), ['done', 'done'])
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
