import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Pool } from 'pg'
import { contextAccessScopeHash, stableJson } from '@gugu/core/agent'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { createRedisAgentCancellationCommands } from '../../src/adapters/redis-events.js'
import { createRedisLiveSubscription } from '../../src/adapters/redis-live-subscription.js'
import { withPostgresTransaction } from '../../src/adapters/postgres-transaction.js'
import { createAgentDispatchWorker } from '../../src/domains/agent-sessions/agent-dispatch-worker.js'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createWebAgentReconstructor, createWebImMemoryLoader, type WebAgentReconstructionResources } from '../../src/domains/agent-sessions/agent-web-reconstructor.js'
import { createPostgresAgentDispatch, enqueueAgentRunLocked } from '../../src/domains/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import { lockAgentRunSession } from '../../src/domains/agent-sessions/persistence/agent-run-startup-postgres.js'
import { createSqlRagPersistentIndexWriter } from '../../../../packages/core/src/agent/rag/persistent-writer.js'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL, redis = process.env.GUGU_WEBUI_TEST_REDIS_URL
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

test('重启后以持久用户锚点及可信作用域重建 Harness，缺服务时保留运行', { skip: !(url && redis) && '需要隔离 PG 和 Redis', timeout: 30000 }, async () => {
  const schema = `web_rebuild_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  const temporary = await mkdtemp(join(tmpdir(), 'gugu-web-agent-rag-run-'))
  await initializeSqlite(join(temporary, 'core.db'))
  const opened = await openSqliteRuntime(join(temporary, 'core.db'))
  const core = opened.runtime, owner = opened.ownerId
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
    await pool.query("INSERT INTO conversation_sessions(id,user_id,source) VALUES (1,$1,'web')", [owner])
    await pool.query("INSERT INTO conversation_messages(id,session_id,role,content,conversation_seq) VALUES (9,1,'user','持久合成问题',1)")
    const coreOwner = owner.replaceAll('-', '')
    const coreFixtureDb = core.db as unknown as { insertInto(table: 'conversation_sessions' | 'conversation_messages'): { values(row: Record<string, unknown>): { execute(): Promise<unknown> } } }
    await coreFixtureDb.insertInto('conversation_sessions').values({ id: 41, user_id: coreOwner, title: '历史回归记录', title_locked: 0,
      summary: '', source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }).execute()
    await coreFixtureDb.insertInto('conversation_messages').values({ id: 5, session_id: 41, conversation_seq: 1, role: 'user',
      content: '持久合成问题。历史回归记录：已确认旧索引归属并验证取消行为。', created_at: '2026-01-01T00:00:00Z' }).execute()
    const indexWriter = createSqlRagPersistentIndexWriter(core.db, core.backend)
    await indexWriter.replaceSource(owner, 'conversation', [{ id: 'conversation:5:0', source_id: '5', source_type: 'conversation',
      scope_type: 'owner', scope_id: '', title: '历史回归记录', summary: '', content: '持久合成问题。历史回归记录：已确认旧索引归属并验证取消行为。',
      text: '持久合成问题 历史回归记录 已确认旧索引归属并验证取消行为。', parent_id: 'conversation:5', document_version: 'conversation-v1',
      chunk_index: 0, chunk_count: 1, metadata: { kind: 'message', session_id: '41', message_id: '5' } }])
    const identity = { ownerId: owner, sessionId: '1', runId: 'run' }, accessVersion = 'a'.repeat(64)
    await withPostgresTransaction(pool, async client => { assert.equal(await lockAgentRunSession(client, identity), true); await enqueueAgentRunLocked(client, 'synthetic-key', identity, { userMessageId: 9, locale: 'zh-CN', origin: null, accessVersion, v: 2, source: 'web' }, 60) })
    const dispatch = createPostgresAgentDispatch(pool, 'synthetic-key', 1000)
    let available = false, wrongModel = false, releases = 0, calls = 0, ragQueries = 0
    const reconstruct = createWebAgentReconstructor({ pool, secretKey: 'synthetic-key', redis: createRedisAgentCancellationCommands(redis!), subscribe: createRedisLiveSubscription(redis!), readReconstructionStatus: dispatch.readReconstructionStatus, history: { async writeHistory() {} },
      historyForBinding: () => ({ async writeHistory() {} }),
      async bind(lease, checkpoint) {
        const selection = { modelIdentity: wrongModel ? 'different-model' : checkpoint?.modelIdentity ?? 'synthetic-model', contextWindow: 10000, locale: 'zh-CN', groupChat: false, contextScopeKey: accessVersion, workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
        const hash = contextAccessScopeHash(lease.identity, selection, digest)
        return { selection, usageConfig: { defaultLimit6h: null, byokEnabled: false, localDeployment: false, model: 'synthetic', provider: 'openai', isByok: false }, async resolve() { return { modelIdentity: selection.modelIdentity, accessScopeHash: hash, config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '系统' } }, release() { releases++ } }
      },
      async resources(lease, binding) {
        if (!available) return null
        const ragRun = createAuthorizedWebAgentProductionRagRunPorts({ core, pool, storageRoot: temporary,
          lease, selection: { modelIdentity: binding.selection.modelIdentity,
            contextScopeKey: binding.selection.contextScopeKey, contextPolicy: binding.selection.contextPolicy }, enabled: () => true })
        let callsForRun = 0
        const resources: WebAgentReconstructionResources = {
          source: { now: () => 0, currentRevision: async () => 0, data: { loadTimezone: async () => 'UTC', loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [], loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}), loadMemory: async () => ({}), loadKnowledge: async () => [] }, builder: { buildSnapshot: () => ({ systemPrompt: '系统', snapshotContext: '快照', sessionInfo: {}, userTimezone: 'UTC' }), buildRequest: () => ({ systemPrompt: '系统', systemInMessages: false, fixedPrefix: [] }) } },
          context: { digest, nextId: randomUUID, preparation: { buildRag: async () => ({ tail: [] }) }, prepareRequest: async () => ({ prefix: [], dynamicTail: [] }), references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message }, compaction: { summarize: async () => { throw new Error('意外摘要') } }, finalization: { complete: async () => {} }, currentRequest: () => null, stageContinuation: async () => { throw new Error('意外续接') }, releaseContinuations: async () => {}, diagnoseCompactionFailure() {} },
          ragContext: async (input, signal) => { ragQueries++; return ragRun.ragContext(input, signal) },
          preparation: { configuration: ragRun.configuration, capabilities: { workspaceSupported: false, filterConfigured: async values => values.filter(value => ['search_conversations', 'search_memory'].includes(value)), shellPolicy: async () => ({ allowed: false, needsConfirmation: false }), shellState: async () => null, appendShellProtocol: value => value, catalog: async () => null }, formatPrefix: () => [] },
          toolRegistry: ragRun.toolRegistry,
          materialize: async (_id, message) => ({ currentUser: { persistedMessageId: message.id, message: { role: 'user', content: message.content } } }),
          executor: { authorize: async () => { throw new Error('不应执行') }, executor: { execute: async () => { throw new Error('不应执行') } } },
          runtime: { clock: { now: () => new Date().toISOString() }, interactions: { activate: async (_id, value) => value }, sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(), presentError: () => ({ code: 'failed', text: '失败' }), presentToolResult: async value => value, publish: async () => {}, diagnose: () => {} },
          provider: { transport: { async request(request) { calls++; callsForRun++; assert.match(JSON.stringify(request.body), /持久合成问题/); if (lease.identity.sessionId === '1' && callsForRun === 1) {
              assert.match(JSON.stringify(request.body), /knowledge-context/)
              return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"search-history","type":"function","function":{"name":"search_conversations","arguments":"{\\"query\\":\\"历史回归\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n') })(), cancel: async () => {} }
            }
            if (lease.identity.sessionId === '1') assert.match(JSON.stringify(request.body), /已确认旧索引归属并验证取消行为/)
            return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })(), cancel: async () => {} }
          } } },
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
    assert.equal(await worker.runOnce(owner, '1'), 'settled'); assert.equal(calls, 2); assert.equal(releases, 3); assert.ok(ragQueries > 0)
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
    assert.equal(calls, 3)
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
    assert.equal(calls, 4)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await core.close(); await rm(temporary, { recursive: true, force: true }) }
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

test('Web 重建器分别校验队列 contextScopeKey 与 Core checkpoint accessScopeHash', async () => {
  const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'scope-contract' }
  const contextScopeKey = 'a'.repeat(64)
  const selection = { modelIdentity: 'synthetic-model', contextWindow: 10000, locale: 'zh-CN', groupChat: false,
    workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey }
  const accessScopeHash = contextAccessScopeHash(identity, selection, digest)
  assert.notEqual(contextScopeKey, accessScopeHash)
  const queries: string[] = []
  let resourceCalls = 0
  const pool = { async query(sql: string) {
    queries.push(sql)
    return sql.includes('conversation_messages') ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] }
  } }
  const lease = { identity, token: 'lease-token', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { userMessageId: 7, locale: 'zh-CN' as const, origin: null, accessVersion: contextScopeKey, v: 2 as const, source: 'web' as const } }
  const reconstruct = createWebAgentReconstructor({ pool: pool as never, secretKey: 'synthetic-key', redis: {} as never,
    subscribe: (async () => { throw new Error('不应订阅') }) as never, history: { async writeHistory() {} },
    async readReconstructionStatus() { return null },
    async bind() {
      return { selection, usageConfig: { defaultLimit6h: null, byokEnabled: false, localDeployment: false, model: 'synthetic', provider: 'openai', isByok: false }, async resolve() { return { modelIdentity: selection.modelIdentity, accessScopeHash,
        config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '合成系统' } }, release() {} }
    },
    async resources() {
      resourceCalls++
      return {
        source: { now: () => 0, currentRevision: async () => 0,
          data: { loadTimezone: async () => 'UTC', loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [],
            loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}),
            loadMemory: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => [] },
          builder: { buildSnapshot: () => ({ systemPrompt: '系统', snapshotContext: '', sessionInfo: {}, userTimezone: 'UTC' }),
            buildRequest: () => ({ systemPrompt: '系统', systemInMessages: false, fixedPrefix: [] }) } },
        context: { digest, nextId: randomUUID, preparation: { buildRag: async () => ({ tail: [] }) },
          prepareRequest: async () => ({ prefix: [], dynamicTail: [] }), references: { dehydrate: async (entry: import('@gugu/core/agent').MessageEntry) => entry.message, hydrate: async (entry: import('@gugu/core/agent').MessageEntry) => entry.message },
          compaction: { summarize: async () => '' }, finalization: { complete: async () => {} }, currentRequest: () => null,
          stageContinuation: async () => 'unused', releaseContinuations: async () => {}, diagnoseCompactionFailure() {} },
        ragContext: async () => ({ tail: [] }),
        preparation: { configuration: async (id: import('@gugu/core/agent').RunIdentity) => ({ identity: { ownerId: id.ownerId, subject: { kind: 'session', id: id.sessionId }, workspaceId: null }, source: 'web', toolNames: [] }),
          capabilities: { workspaceSupported: false, filterConfigured: async (values: readonly string[]) => values, shellPolicy: async () => ({ allowed: false, needsConfirmation: false }),
            shellState: async () => null, appendShellProtocol: (value: string) => value, catalog: async () => null }, formatPrefix: () => [] },
        toolRegistry: createAgentToolRegistry({ core: {} as SqlDataRuntime, authorize: async () => false }),
        materialize: async (_id: import('@gugu/core/agent').RunIdentity, message: import('../../src/domains/agent-sessions/context/agent-context-source.js').OwnedCurrentMessage) => ({ currentUser: { persistedMessageId: message.id, message: { role: 'user', content: message.content } } }),
        executor: { authorize: async () => { throw new Error('不应执行') }, executor: { execute: async () => { throw new Error('不应执行') } } },
        runtime: { clock: { now: () => new Date(0).toISOString() }, interactions: { activate: async (_id: import('@gugu/core/agent').RunIdentity, request: import('@gugu/core/agent').PendingInteraction) => request },
          sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(), presentError: () => ({ code: 'failed', text: '失败' }),
          presentToolResult: async (value: unknown) => value, publish: async () => {}, diagnose: () => {} },
        provider: { transport: { request: async () => { throw new Error('不应请求 Provider') } } },
      } as unknown as WebAgentReconstructionResources
    },
  })
  const instance = await reconstruct(lease)
  assert.ok(instance)
  assert.ok(queries.some(sql => sql.includes('conversation_messages')))
  await instance.close()
  await assert.rejects(reconstruct({ ...lease, input: { ...lease.input, accessVersion: 'b'.repeat(64) } }), /版本不匹配/)
  assert.equal(resourceCalls, 1)
})
