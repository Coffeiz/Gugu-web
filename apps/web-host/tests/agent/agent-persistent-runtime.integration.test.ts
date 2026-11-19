import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createKnowledgeDeleteTool, createMcpManagementCreateOperations, createMcpManagementEditOperations, createMcpManagementRemoveOperations, createMcpManagementTool, createScheduledTaskDeleteTool, createSkillDeleteTool, createToolRegistry } from '@gugu/core/tools'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'
import { createPostgresAgentRunStore } from '../../src/modules/agent-sessions/persistence/agent-run-store-postgres.js'
import { createPostgresAgentRunLeasePort } from '../../src/modules/agent-sessions/persistence/agent-run-lease-postgres.js'
import { createPostgresInteractionConsumeStore } from '../../src/modules/agent-sessions/persistence/agent-interaction-consume-postgres.js'
import { createInteractionResumeEnqueuer, createPostgresInteractionResumeQueue } from '../../src/modules/agent-sessions/persistence/agent-interaction-resume-postgres.js'
import { createPostgresInteractionProjection } from '../../src/modules/agent-sessions/persistence/agent-interaction-projection-postgres.js'
import { createPostgresInteractionActivator } from '../../src/modules/agent-sessions/persistence/agent-interaction-activate-postgres.js'
import { createPostgresTrustedIntentStore } from '../../src/modules/agent-sessions/persistence/agent-trusted-intent-postgres.js'
import { createTrustedPromptDescriptions } from '../../src/modules/agent-sessions/persistence/agent-trusted-prompt-descriptions.js'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from '../../src/modules/agent-sessions/tools/agent-confirmation.js'
import { createWebAgentEmailTool } from '../../src/modules/agent-sessions/tools/agent-email.js'
import { createWebAgentScheduledTaskWrites } from '../../src/modules/agent-sessions/tools/agent-scheduled-task-writes.js'
import { createPostgresTaskResolver } from '../../src/modules/scheduled-tasks/persistence/task-resolver-postgres.js'
import { hasScheduledEmailAuthorization } from '@gugu/core/scheduled-task-run-now-read'
import { createLocalAgentKnowledgeDeletePort, createLocalAgentKnowledgeWritePort } from '../../src/modules/agent-sessions/tools/agent-knowledge-write.js'
import { createLocalAgentKnowledgeReadStore } from '../../src/modules/agent-sessions/tools/agent-rag-knowledge-store.js'
import { applyRagIndexMigration } from '../../src/migrations/rag-index-migrate.js'
import { createKnowledgeRagSource, createSqlRagPersistentIndexReader, createSqlRagRebuildWorker } from '@gugu/core/agent/rag'
import { parseAgentKnowledgeEntry } from '@gugu/core/agent/knowledge/entry'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import { createFilesystemAuthorizationConfirmationStore } from '../../src/modules/agent-sessions/filesystem-authorization-confirmations.js'
import { createAgentInteractionRespondService } from '../../src/modules/agent-sessions/agent-interaction-respond.js'
import { createAgentSecretInteractionService } from '../../src/modules/agent-sessions/agent-secret-interaction-route.js'
import { createPostgresSecretInteraction } from '../../src/modules/agent-sessions/persistence/agent-secret-interaction-postgres.js'
import { createByokEnvelope } from '../../src/adapters/security/byok-envelope.js'
import { projectAgentRunEvent } from '../../src/modules/agent-sessions/agent-run-events.js'
import { consumeInteractionAction } from '@gugu/core/agent/interactions/consume-action'
import { createAgentChatService, createAgentInteractionDescription, createAgentRunner, processOneInteraction, stableJson,
  type AgentRunnerPorts, type CanonicalContextPorts, type RunIdentity } from '@gugu/core/agent'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { createPersistentAgentRuntime } from '../../src/modules/agent-sessions/agent-persistent-runtime.js'
import { createRedisAgentCancellationCommands, createRedisFilesystemAuthorizationCommands } from '../../src/adapters/cache/redis-events.js'
import { createRedisLiveSubscription } from '../../src/adapters/cache/redis-live-subscription.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL, redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
test('隔离 PG 和 Redis 下 Agent 执行、取消、归属与 outbox 重放', { skip: !(databaseUrl && redisUrl) && '需要显式隔离 PG 与 Redis', timeout: 30000 }, async t => {
  const schema = `gugu_agent_e2e_${randomUUID().replaceAll('-', '')}`, owner = '00000000-0000-4000-8000-000000000111', other = '00000000-0000-4000-8000-000000000112'
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 })
  let close = async () => {}
  const streamAbort = new AbortController()
  const background: Promise<unknown>[] = []
  try {
    await pool.query(`CREATE TABLE users (id uuid PRIMARY KEY)`)
    await pool.query(`CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid NOT NULL, execution_state text NOT NULL DEFAULT 'idle', active_run_id text, session_context jsonb, context_epoch integer NOT NULL DEFAULT 0, snapshot_hash text, session_info_hash text, snapshot_expires_at timestamptz, baseline_message_seq integer NOT NULL DEFAULT 0, baseline_message_hash text)`)
    await pool.query(`CREATE TABLE agent_run_startups (user_id uuid, session_id integer, run_id text, status text, created_at timestamptz, updated_at timestamptz, PRIMARY KEY(user_id,session_id,run_id))`)
    await pool.query(`CREATE TABLE agent_run_leases (user_id uuid, session_id integer, run_id text, token text, fence bigint, expires_at timestamptz, created_at timestamptz, updated_at timestamptz, PRIMARY KEY(user_id,session_id))`)
    await pool.query(`CREATE TABLE agent_run_checkpoints (user_id uuid, session_id integer, run_id text, version bigint, sequence bigint, status text, phase text, nonce bytea, payload bytea, created_at timestamptz, updated_at timestamptz, PRIMARY KEY(user_id,session_id,run_id))`)
    await pool.query(`CREATE TABLE agent_run_events (user_id uuid, session_id integer, run_id text, event_id text, sequence bigint, nonce bytea, payload bytea, created_at timestamptz, acknowledged_at timestamptz, PRIMARY KEY(user_id,session_id,run_id,event_id), UNIQUE(user_id,session_id,run_id,sequence))`)
    await pool.query(`CREATE TABLE agent_run_interaction_receipts (user_id uuid, session_id integer, run_id text, receipt text, created_at timestamptz, PRIMARY KEY(user_id,session_id,run_id,receipt))`)
    await pool.query('INSERT INTO users VALUES ($1), ($2)', [owner, other])
    await pool.query('INSERT INTO conversation_sessions (id,user_id) VALUES (1,$1),(2,$1),(3,$1),(4,$1),(5,$1),(6,$1),(7,$1),(8,$1),(9,$1)', [owner])
    const context: CanonicalContextPorts = {
      digest, nextId: randomUUID,
      load: async (id: RunIdentity) => ({ modelIdentity: 'synthetic-model', contextWindow: 10000, accessScopeHash: 'scope', capabilities: { toolNames: [], tools: [] },
        input: { ...id, fixedPrefix: [], history: [], preparedRag: { tail: [] }, historyBaseline: { baselineSeq: 0, baselineHash: null, snapshotHash: null }, currentUser: { persistedMessageId: '1', message: { role: 'user', content: '你好' } } },
        sourceEffects: { sessionSnapshot: { expectedEpoch: 0, expectedSnapshotHash: null, phase: 'new', state: { ownerId: id.ownerId, sessionId: id.sessionId, contextEpoch: 1, baselineMessageSeq: 0, context: { access_scope_hash: 'scope' }, snapshotHash: 'snapshot', sessionInfoHash: null, snapshotExpiresAt: null } } } } as never),
      preparation: { buildRag: async () => ({ tail: [] }) }, prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
      references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
      compaction: { summarize: async () => { throw new Error('意外压缩') } }, finalization: { complete: async () => {} }, currentRequest: () => null,
      stageContinuation: async () => { throw new Error('意外续接') }, releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
    }
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    let httpStarted!: () => void
    const httpRunning = new Promise<void>(resolve => { httpStarted = resolve })
    let count = 0, histories = 0
    const runtimeOptions: Parameters<typeof createPersistentAgentRuntime>[0] = { pool, secretKey: 'synthetic-secret-key', redis: createRedisAgentCancellationCommands(redisUrl!), subscribe: createRedisLiveSubscription(redisUrl!), context, scheduling: { mode: 'direct' },
      history: { async writeHistory() { histories++ } },
      executor: { authorize: async () => { throw new Error('不应授权进程') }, executor: { execute: async () => { throw new Error('不应执行进程') } } },
      runtime: { clock: { now: () => '2026-01-01T00:00:00Z' }, tools: { dispatch: async () => { throw new Error('不应调用工具') }, reconcile: async () => ({ kind: 'unknown' }) }, interactions: { activate: async (_id, request) => request }, sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(), presentError: () => ({ code: 'failed', text: '模型不可用' }), presentToolResult: async value => value, publish: async () => {}, diagnose: () => {} },
      provider: { resolve: async () => ({ modelIdentity: 'synthetic-model', accessScopeHash: 'scope', config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '合成系统' }), transport: { request: async (_request, signal) => {
        count++
        if (count === 4) throw new Error('synthetic-provider-secret')
        if (count === 2 || count === 5) { if (count === 2) requestStarted(); else httpStarted(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) }
        return { status: 200, headers: {}, body: (async function* () { yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"合成回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })(), cancel: async () => {} }
      } } },
    }
    const instance = createPersistentAgentRuntime(runtimeOptions)
    assert.throws(() => createPersistentAgentRuntime({ ...runtimeOptions, scheduling: { mode: 'dispatch', leaseFor: () => null } as never }), /重建状态读取端口/)
    const recovery = createPersistentAgentRuntime({ ...runtimeOptions, scheduling: { mode: 'dispatch', leaseFor: () => null, readReconstructionStatus: async target => target.ownerId === owner && target.runId === 'blocked' ? 'version_conflict' : null } })
    const blocked = { ownerId: owner, sessionId: '1', runId: 'blocked' }
    const statusEvents = []
    for await (const event of await recovery.events.open(blocked)) statusEvents.push(event)
    assert.equal(statusEvents.length, 1)
    assert.equal(statusEvents[0]?.type, 'provider_diagnostic')
    assert.equal(statusEvents[0]?.payload.reconstructionStatus, 'reconstruction_version_conflict')
    await recovery.close()
    close = instance.close
    const first = { ownerId: owner, sessionId: '1', runId: randomUUID() }, second = { ownerId: owner, sessionId: '2', runId: randomUUID() }
    assert.equal(await instance.startup.register(first), true)
    const recorded: Array<{ sequence: number; type: string }> = []
    const initial = (await instance.events.open(first, 0, streamAbort.signal))[Symbol.asyncIterator]()
    const runningFirst = (async () => { for await (const event of instance.harness.start(first)) recorded.push({ sequence: event.sequence, type: event.type }) })()
    background.push(runningFirst)
    void runningFirst.catch(() => streamAbort.abort())
    const firstEvent = await initial.next()
    assert.equal(firstEvent.value?.type, 'run_started')
    await initial.return?.()
    const rest: Array<{ sequence: number; type: string }> = []
    const reconnected = (async () => { for await (const event of await instance.events.open(first, firstEvent.value!.sequence, streamAbort.signal)) rest.push({ sequence: event.sequence, type: event.type }) })()
    background.push(reconnected)
    await Promise.all([runningFirst, reconnected])
    assert.equal(recorded.at(-1)?.type, 'final'); assert.equal((await instance.store.read(first))?.status, 'completed'); assert.equal(histories, 1)
    assert.deepEqual([{ sequence: firstEvent.value!.sequence, type: firstEvent.value!.type }, ...rest], recorded)
    const replay = []; for await (const event of await instance.events.open(first)) replay.push({ sequence: event.sequence, type: event.type })
    assert.deepEqual(replay, recorded)
    assert.equal(await instance.store.read({ ...first, ownerId: other }), null)
    assert.equal((await instance.store.readEventsAfter({ ...first, ownerId: other }, 0)).length, 0)
    assert.equal(await instance.startup.register(second), true)
    const running = (async () => { for await (const _event of instance.harness.start(second)) { /* 等待取消 */ } })()
    try {
      await started
      await instance.cancellation.request(second); await instance.cancellation.notify(second); await running
      assert.equal((await instance.store.read(second))?.status, 'cancelled')
    } finally {
      await instance.cancellation.request(second); await instance.cancellation.notify(second)
      await Promise.allSettled([running])
    }
    const identities = new Map<number, RunIdentity>()
    const service = createAgentChatService({ harness: instance.harness, cancellation: instance.cancellation, events: instance.events,
      project: event => projectAgentRunEvent(event, { async interaction() { return { type: 'interaction_required' } } }),
      async prepare(user, body) {
        const { session_id: id } = body as { session_id: number }
        const identity = { ownerId: user, sessionId: String(id), runId: randomUUID() }
        assert.equal(await instance.startup.register(identity), true); identities.set(id, identity)
        return { identity, userMessageId: 1 }
      },
      async active(user, id) { return user === owner && identities.has(id) ? { identity: identities.get(id)! } : null },
      async failStart(identity) { await instance.startup.failStart(identity) },
    })
    const authSecret = 'synthetic-integration-token-signing-secret'
    const app = createApp({ appName: 'Gugu', isReady: async () => true, agentChat: service, userAuth: { secret: authSecret,
      lookupUser: async id => [owner, other].includes(id) ? { id, username: '合成用户', displayName: null, email: 'synthetic@example.test', isActive: true, securityVersion: 1, avatarUrl: null, createdAt: null, timezone: 'UTC', emailSubscribed: false, imChannels: [] } : null } })
    const headers = { authorization: `Bearer ${createUserToken(owner, 1, authSecret)}` }, otherHeaders = { authorization: `Bearer ${createUserToken(other, 1, authSecret)}` }
    const parse = (body: string) => body.trim().split('\n\n').map(line => JSON.parse(line.slice(6)))
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/chat', payload: { message: '你好', session_id: 3 } })).statusCode, 401)
      const success = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers, payload: { message: '你好', session_id: 3 } })
      assert.match(success.headers['content-type']!, /^text\/event-stream/)
      const successEvents = parse(success.body)
      assert.equal(successEvents[0].type, 'session_id'); assert.equal(successEvents.at(-1).type, 'done')
      assert.equal((await app.inject({ url: '/api/v1/agent/sessions/3/stream', headers: otherHeaders })).statusCode, 404)
      const replay = await app.inject({ url: '/api/v1/agent/sessions/3/stream', headers })
      assert.deepEqual(parse(replay.body), successEvents.slice(1))
      const failed = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers, payload: { message: '你好', session_id: 4 } })
      const failedEvents = parse(failed.body)
      assert.equal(failedEvents.at(-2).type, 'error'); assert.equal(failedEvents.at(-1).type, 'done')
      assert.doesNotMatch(failed.body, /synthetic-provider-secret/)
      const pending = app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers, payload: { message: '你好', session_id: 5 } })
      try {
        await httpRunning
        assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/sessions/5/cancel', headers: otherHeaders })).statusCode, 404)
        assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/sessions/5/cancel', headers })).json().outcome, 'requested')
        const cancelled = parse((await pending).body)
        assert.equal(cancelled.at(-1).type, 'done'); assert.equal(cancelled.at(-1).cancelled, true)
      } finally {
        const id = identities.get(5)
        if (id) { await instance.cancellation.request(id); await instance.cancellation.notify(id) }
        await Promise.allSettled([pending])
      }
    } finally { await app.close() }
    const preCancelled = { ownerId: owner, sessionId: '6', runId: randomUUID() }
    assert.equal(await instance.startup.register(preCancelled), true)
    await instance.cancellation.request(preCancelled)
    const before = count
    for await (const _event of instance.harness.start(preCancelled)) { /* 读取取消终态 */ }
    assert.equal(count, before)
    assert.equal((await instance.store.read(preCancelled))?.status, 'cancelled')
    const subsequent = { ownerId: owner, sessionId: '7', runId: randomUUID() }
    assert.equal(await instance.startup.register(subsequent), true)
    for await (const _event of instance.harness.start(subsequent)) { /* 验证取消隔离 */ }
    assert.equal((await instance.store.read(subsequent))?.status, 'completed')
    assert.equal(count, before + 1)
    await pool.query('CREATE TABLE interaction_prompts (id serial PRIMARY KEY, user_id uuid, session_id integer, kind text, title text, body text, status text, expires_at timestamptz, resolved_at timestamptz, schema_json jsonb, created_at timestamptz)')
    await pool.query('CREATE TABLE interaction_actions (id serial PRIMARY KEY, prompt_id integer, token_hash text, action_type text, option_id text, context_json jsonb, status text, expires_at timestamptz, consumed_at timestamptz, consumed_event_id text, created_at timestamptz)')
    await pool.query("CREATE TABLE mcp_secret_inputs (user_id uuid, session_id integer, status text, encrypted_payload text, payload_nonce text, encrypted_data_key text, prompt_id integer)")
    await pool.query('CREATE TABLE agent_interaction_bindings (user_id uuid, session_id integer, run_id text, prompt_id integer PRIMARY KEY, interaction_id text, tool_call_id text)')
    await pool.query('CREATE TABLE agent_interaction_resumes (user_id uuid, session_id integer, run_id text, prompt_id integer, interaction_id text, receipt text, created_at timestamptz, completed_at timestamptz, claim_token text, claim_expires_at timestamptz, PRIMARY KEY(user_id,session_id,run_id,prompt_id))')
    const store = createPostgresAgentRunStore<string[]>(pool, 'synthetic-interaction-key', { async writeHistory() {} })
    const queue = createPostgresInteractionResumeQueue(pool), enqueue = createInteractionResumeEnqueuer(store)
    const consume = createPostgresInteractionConsumeStore(pool, { async applyCommandAction() { throw new Error('不应调用') }, async redeemConfirmation() { return true }, beforeCommit: enqueue })
    const rounds = new Map<string, number>(), calls = new Map<string, number>()
    const toolCall = { id: 'call-synthetic', name: 'lookup', input: { query: '合成' } }
    const activator = createPostgresInteractionActivator(pool, { describe: async () => ({ kind: 'confirm', title: '确认', body: '继续？', options: [{ id: 'confirm', label: '确认', actionType: 'choice' }, { id: 'cancel', label: '取消', actionType: 'cancel' }], context: {} }) })
    const harnessPorts: AgentRunnerPorts<string[]> = { clock: { now: () => '2026-01-01T00:00:00Z' }, store, leases: createPostgresAgentRunLeasePort(pool), cancellation: instance.cancellation,
      provider: { async *stream(input) { const round = rounds.get(input.identity.runId) ?? 0; rounds.set(input.identity.runId, round + 1); yield { type: 'complete', text: round ? '完成' : '', calls: round ? [] : [toolCall] } } },
      context: { assertIdentity: () => {}, checkpointToolResult: async (_scope, value) => value, restoreToolResult: async (_scope, value) => value,
        prepare: async () => ['prepared'], afterRound: async context => context, afterTool: async context => context, resumeInteraction: async context => context,
        recoverOverflow: async context => ({ context, applied: false }), afterUsage: async context => ({ context, applied: false }), appendReminder: async context => context },
      tools: { async dispatch(call, scope) { const run = scope.identity.runId; calls.set(run, (calls.get(run) ?? 0) + 1); return scope.resolution ? { kind: 'completed', value: '执行完成', successful: true, mutated: true } : { kind: 'waiting', interaction: { id: 'interaction-synthetic', kind: 'confirmation', toolCall: call } } }, async reconcile() { return { kind: 'unknown' } } },
      interactions: activator, execution: { execute: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }) }, reply: { evaluate: async () => 'accept' },
      sanitizeText: text => text, createStreamSanitizer: () => ({ feed: text => text, flush: () => '' }), presentError: () => ({ code: 'failed', text: '生成失败' }), presentToolResult: async value => value, publish: async () => {}, diagnose: () => {},
    }
    const harness = createAgentRunner(harnessPorts)
    for (const session of [8, 9]) {
      const id = { ownerId: owner, sessionId: String(session), runId: randomUUID() }
      for await (const _event of harness.start(id)) { /* 产生真实 waiting checkpoint */ }
      assert.equal((await store.read(id))?.status, 'waiting')
      const otherRun = { ...id, runId: randomUUID() }
      if (session === 8) { const otherHarness = createAgentRunner({ ...harnessPorts, interactions: { activate: async (_id, request) => request } }); for await (const _event of otherHarness.start(otherRun)) {} ; assert.equal((await store.read(otherRun))?.status, 'waiting') }
      const binding = await pool.query('SELECT prompt_id FROM agent_interaction_bindings WHERE user_id=$1 AND session_id=$2 AND run_id=$3', [owner, session, id.runId])
      const promptId = binding.rows[0].prompt_id as number
      const sameRequest = { id: 'interaction-synthetic', kind: 'confirmation' as const, toolCall }
      await activator.activate(id, sameRequest, new AbortController().signal)
      assert.equal(Number((await pool.query('SELECT count(*) AS n FROM agent_interaction_bindings WHERE run_id=$1', [id.runId])).rows[0].n), 1)
      const invalidCredential = createPostgresInteractionActivator(pool, { describe: async () => ({ kind: 'form', title: '凭据', body: '', options: [], context: {} }) })
      await assert.rejects(invalidCredential.activate(id, { ...sameRequest, id: 'credential-invalid', kind: 'credential' }, new AbortController().signal))
      assert.equal((await pool.query('SELECT status FROM interaction_prompts WHERE id=$1', [promptId])).rows[0].status, 'active')
      const interactionEvent = (await store.readEventsAfter(id, 0)).find(event => event.type === 'interaction_required')!
      const projection = createPostgresInteractionProjection(pool)
      await assert.rejects(projection.interaction({ ...interactionEvent, identity: { ...id, ownerId: other } }))
      const firstProjection = await projection.interaction(interactionEvent)
      const currentProjection = await projection.interaction(interactionEvent)
      const firstToken = firstProjection.options.find(option => option.id === 'confirm')!.token
      const token = currentProjection.options.find(option => option.id === 'confirm')!.token
      assert.notEqual(firstToken, token)
      assert.equal(JSON.stringify(interactionEvent).includes(token), false)
      await assert.rejects(consumeInteractionAction(consume, { ownerId: owner, promptId, token: firstToken }))
      await consumeInteractionAction(consume, { ownerId: owner, promptId, token })
      if (session === 8) assert.equal((await store.read(otherRun))?.status, 'waiting')
      if (session === 9) {
        const job = (await queue.pending()).find(row => row.promptId === promptId)!
        const partial = harness.resume(id, job.resolution)
        for (;;) { const next = await partial.next(); if (next.done || next.value.type === 'interaction_resolved') break }
        await partial.return(undefined as never)
        assert.equal((await store.read(id))?.status, 'running')
      }
      await processOneInteraction({ queue, read: id => store.read(id), resume: (id, resolution) => harness.resume(id, resolution), invalidateCredential: async () => {}, diagnose() {} })
      assert.equal((await store.read(id))?.status, 'completed')
      assert.equal(calls.get(id.runId), 2)
      assert.equal((await queue.pending()).some(row => row.promptId === promptId), false)
      assert.equal(Number((await pool.query('SELECT count(*) AS n FROM agent_run_interaction_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3', [owner, session, id.runId])).rows[0].n), 1)
    }
    const waitingRun = await pool.query("SELECT run_id FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=8 AND status='waiting'", [owner])
    const id = { ownerId: owner, sessionId: '8', runId: waitingRun.rows[0].run_id as string }
    const signal = new AbortController().signal
    await activator.activate(id, { id: 'replacement-first', kind: 'confirmation', toolCall }, signal)
    await pool.query("INSERT INTO mcp_secret_inputs(user_id,session_id,status,encrypted_payload,payload_nonce,encrypted_data_key) VALUES ($1,8,'awaiting_secret','cipher','nonce','wrapped')", [owner])
    await activator.activate(id, { id: 'replacement-second', kind: 'confirmation', toolCall }, signal)
    const replaced = await pool.query("SELECT status FROM interaction_prompts WHERE user_id=$1 AND session_id=8 ORDER BY id DESC LIMIT 2", [owner])
    assert.deepEqual(replaced.rows.map(row => row.status), ['active', 'cancelled'])
    const staged = (await pool.query('SELECT status, encrypted_payload, payload_nonce, encrypted_data_key FROM mcp_secret_inputs WHERE user_id=$1', [owner])).rows[0]
    assert.deepEqual(staged, { status: 'cancelled', encrypted_payload: '', payload_nonce: '', encrypted_data_key: '' })

    await t.test('受保护的配置变更、删除和邮件发送经真实 Redis 确认并恢复执行', async confirmationTests => {
      await pool.query(`${tablesSql('postgres').receipts};
        ALTER TABLE users ADD COLUMN security_version integer NOT NULL DEFAULT 1,
          ADD COLUMN is_active boolean NOT NULL DEFAULT TRUE, ADD COLUMN account_status text NOT NULL DEFAULT 'active',
          ADD COLUMN email text;
        CREATE TABLE user_preferences(user_id uuid,data json);
        CREATE TABLE user_smtp_configs(user_id uuid,host text,port integer,"user" text,password text,from_addr text,use_ssl boolean,enabled boolean);
        CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz);
        CREATE TABLE agent_interaction_intents(user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text,
          ciphertext text,nonce text,encrypted_data_key text,key_version integer,expires_at timestamptz,
          PRIMARY KEY(user_id,session_id,run_id,interaction_id));
        CREATE TABLE user_skills(id serial PRIMARY KEY,owner_id uuid,skill_id text,name text,description_short text,
          description_long text,category text,body text,related_tools json,source text,managed_by text,enabled boolean,
          content_digest text,updated_at timestamptz)`)
      await pool.query("INSERT INTO user_skills(owner_id,skill_id,name,source,managed_by,enabled,updated_at) VALUES ($1,'U1','合成技能','user','user',TRUE,now()),($1,'U2','助理技能','user','assistant',TRUE,now()),($2,'U1','其他账号','user','user',TRUE,now())", [owner, other])
      await pool.query(tablesSql('postgres').scheduledTasks)
      await pool.query(tablesSql('postgres').ragJobs)
      await applyRagIndexMigration(pool)
      await pool.query(`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,channels,enabled,created_at,updated_at)
        VALUES (21,$1,'待删除任务','合成任务','','web',TRUE,NOW(),NOW()),
          (22,$1,'保留任务','合成任务','','web',TRUE,NOW(),NOW()),
          (23,$2,'其他账号任务','合成任务','','web',TRUE,NOW(),NOW())`, [owner, other])
      await pool.query("UPDATE users SET email='receiver@example.test' WHERE id=$1", [owner])
      await pool.query(tablesSql('postgres').mcpServers)
      await pool.query(tablesSql('postgres').mcpSnapshots)
      const removedMcpId = randomUUID(), cancelledMcpId = randomUUID(), foreignMcpId = randomUUID(), systemMcpId = randomUUID()
      await pool.query(`INSERT INTO user_mcp_servers(id,user_id,scope,name,encrypted_headers,created_at,updated_at)
        VALUES ($1,$5,'user','合成服务','synthetic-encrypted-header',now(),now()),
          ($2,$5,'user','保留服务','',now(),now()),
          ($3,$6,'user','合成服务','',now(),now()),
          ($4,$5,'system','合成服务','',now(),now())`, [removedMcpId, cancelledMcpId, foreignMcpId, systemMcpId, owner, other])
      await pool.query("INSERT INTO user_mcp_tool_schema_snapshots(user_id,config_digest,refreshed_at) VALUES ($1,'owner',now()),($2,'other',now())", [owner, other])
      await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES (10,$1),(11,$1),(12,$1),(13,$1),(14,$1),(15,$1),(16,$1),(17,$1),(18,$1),(19,$1)', [owner])
      const core = await createPostgresRuntime({ url: databaseUrl!, schema })
      const root = await mkdtemp(join(tmpdir(), 'gugu-knowledge-confirm-'))
      try {
        const knowledgeStore = createLocalAgentKnowledgeReadStore(root)
        const knowledgeWrites = createLocalAgentKnowledgeWritePort(core, root, knowledgeStore)
        const knowledgeEntry = (ownerId: string, id: string) => ({
          id, title: '合成知识', content: '合成知识正文', topic: '', description: '', keywords: [],
          scope: { type: 'owner', owner_user_id: ownerId, platform: '', bot_id: '', group_id: '', scope_id: '', project_id: '' },
          source: { type: 'user' as const, ref: '', label: '', checked_at: null }, confidence: 'confirmed' as const,
          version: 1, parent_id: null, created_at: 1700000000, updated_at: 1700000000, active: true, history: [],
        })
        const knowledgeOwners = [[owner, 'delete-entry'], [owner, 'cancel-entry'], [other, 'delete-entry']] as const
        for (const [ownerId, id] of knowledgeOwners)
          await knowledgeWrites.commit({ ownerId, sessionId: '16', runId: 'seed-knowledge' }, knowledgeEntry(ownerId, id), signal)
        const knowledgeWorker = createSqlRagRebuildWorker(core.db, 'postgres', { knowledge: createKnowledgeRagSource(knowledgeStore) })
        assert.equal(await knowledgeWorker(), 'ready')
        assert.equal(await knowledgeWorker(), 'ready')
        const index = createSqlRagPersistentIndexReader(core.db, 'postgres')
        const indexedIds = async (id: string) => [...new Set((await index.snapshot(id)).documents.map(row => row.source_id))].sort()
        const readKnowledge = async (id: string, entry: string) =>
          parseAgentKnowledgeEntry(await knowledgeStore.read(`${id}/.agent/knowledge/entries/${entry}.md`))
        assert.deepEqual(await indexedIds(owner), ['cancel-entry', 'delete-entry'])
        assert.deepEqual(await indexedIds(other), ['delete-entry'])
        const redis = createFilesystemAuthorizationConfirmationStore(createRedisFilesystemAuthorizationCommands(redisUrl!))
        const intents = createPostgresTrustedIntentStore(() => 'synthetic-skill-master', 1)
        const secureActivation = createPostgresInteractionActivator(pool, createAgentInteractionDescription(createTrustedPromptDescriptions({
          loadIntent: intents.loadIntent, createConfirmation: redis.createPending,
          filesystemAuthorizationEnabled: () => false,
        })))
        const respond = createAgentInteractionRespondService({
          pool, enqueue, effects: { async applyCommandAction() { throw new Error('禁止命令副作用') },
            async redeemConfirmation(_client, candidate, code) { return redis.redeem(candidate, code) } },
          async wake() {}, diagnose() {},
        })
        let skillPublishes = 0
        const taskPublishes: number[] = []
        const sentSubjects: string[] = []
        const invalidatedMcp: string[] = []
        const mcpCrypto = {
          async encrypt(): Promise<never> { throw new Error('删除不读取或写入凭据') },
          async decrypt(): Promise<never> { throw new Error('删除不解密凭据') },
        }
        const cases = [
          { sessionId: '10', tool: 'delete_skill', input: { id: 'U1' }, action: 'confirm' },
          { sessionId: '11', tool: 'delete_skill', input: { id: 'U2' }, action: 'cancel' },
          { sessionId: '12', tool: 'delete_scheduled_task', input: { task_ids: [21] }, action: 'confirm' },
          { sessionId: '13', tool: 'delete_scheduled_task', input: { task_id: 22 }, action: 'cancel' },
          { sessionId: '14', tool: 'send_email', input: { subject: '确认的邮件', body: '合成私密正文', format: 'plain' }, action: 'confirm' },
          { sessionId: '15', tool: 'send_email', input: { subject: '取消的邮件', body: '合成私密正文', format: 'plain' }, action: 'cancel' },
          { sessionId: '16', tool: 'delete_knowledge', input: { knowledge_id: 'delete-entry' }, action: 'confirm' },
          { sessionId: '17', tool: 'delete_knowledge', input: { knowledge_id: 'cancel-entry' }, action: 'cancel' },
          { sessionId: '18', tool: 'manage_mcp_servers', input: { action: 'remove', server_id: removedMcpId }, action: 'confirm' },
          { sessionId: '19', tool: 'manage_mcp_servers', input: { action: 'remove', server_id: cancelledMcpId }, action: 'cancel' },
        ] as const
        for (const { sessionId, tool, input, action } of cases) {
          const taskCase = tool === 'delete_scheduled_task'
          const mailCase = tool === 'send_email'
          const knowledgeCase = tool === 'delete_knowledge'
          const mcpCase = tool === 'manage_mcp_servers'
          const readTarget = () => taskCase
            ? pool.query('SELECT 1 FROM scheduled_tasks WHERE user_id=$1 AND id=$2',
              [owner, 'task_ids' in input ? input.task_ids[0] : input.task_id])
            : tool === 'delete_skill' ? pool.query('SELECT 1 FROM user_skills WHERE owner_id=$1 AND skill_id=$2', [owner, input.id])
            : mcpCase ? pool.query("SELECT 1 FROM user_mcp_servers WHERE user_id=$1 AND id=$2 AND scope='user'", [owner, input.server_id])
            : undefined
          const sendsBefore = sentSubjects.length
          const identity = { ownerId: owner, sessionId, runId: randomUUID() }
          const accessVersion = 'a'.repeat(64)
          const lease = { identity, token: randomUUID(), fence: 1, mode: 'start' as const, cancelRequested: false,
            input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion } }
          await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,$2,$3,'selected',$4,1,now()+interval '5 minutes')",
            [owner, sessionId, identity.runId, lease.token])
          const authorization = createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() { return lease.input.accessVersion } })
          const confirmation = createWebAgentToolConfirmation({
            pool, lease, action: mcpCase ? 'remove_mcp_server' : tool, intents, ...authorization,
            async describe(_binding, snapshot) {
              if (mailCase || knowledgeCase) {
                assert.ok(snapshot.displaySummary)
                return { summary: snapshot.displaySummary }
              }
              if (mcpCase) {
                assert.deepEqual(snapshot.targetRefs, { mcp_server: [input.server_id] })
                return { summary: '删除指定的合成 MCP 服务' }
              }
              return { summary: taskCase ? '删除指定的合成任务' : '删除指定的合成技能' }
            },
          })
          const confirmationPorts = { gate: confirmation.gate, claim: confirmation.claim }
          const definitions = {
            delete_scheduled_task: () => createScheduledTaskDeleteTool(core, confirmationPorts, async (id, taskId) => {
              assert.equal(id, owner)
              taskPublishes.push(taskId)
            }),
            send_email: () => createWebAgentEmailTool({
              core, pool, confirmation: confirmationPorts, secretKey: 'synthetic-key', storageRoot: root,
              globalSmtp: { host: 'smtp.example.test', port: 465, user: 'sender@example.test', password: 'synthetic-mail-credential',
                fromAddress: '', enabled: true, useSsl: true },
              async send(delivery) {
                assert.equal(delivery.toAddress, 'receiver@example.test')
                assert.equal(delivery.message.plain, '合成私密正文')
                sentSubjects.push(delivery.message.subject)
              },
            }),
            delete_skill: () => createSkillDeleteTool(core, confirmationPorts, async id => {
              assert.equal(id, owner)
              skillPublishes++
            }),
            delete_knowledge: () => createKnowledgeDeleteTool(createLocalAgentKnowledgeDeletePort(core, root, knowledgeStore, confirmationPorts)),
            manage_mcp_servers: () => createMcpManagementTool({
              list: createMcpServerConfigLister(core.db),
              decrypt: mcpCrypto.decrypt,
              enabled: () => true,
              state() { throw new Error('删除不发起 MCP 状态查询') },
            }, createMcpManagementRemoveOperations(core, { crypto: mcpCrypto, maxTools: 8 }, {
              confirmation: confirmationPorts,
              async invalidate(candidate, serverId) {
                assert.equal(candidate, owner)
                invalidatedMcp.push(serverId)
              },
            })),
          }
          const definition = definitions[tool]()
          const registry = createToolRegistry({ tools: [definition],
            authorize: async id => id.ownerId === owner && id.sessionId === sessionId && id.runId === identity.runId })
          const call = { id: 'delete-target', name: tool, input: structuredClone(input) }
          if (mcpCase && action === 'confirm') {
            for (const serverId of [foreignMcpId, systemMcpId]) {
              const rejected = await registry.tools.dispatch({
                ...call, input: { action: 'remove', server_id: serverId },
              }, { identity, roundId: '1', signal, resolution: null,
                async execute() { throw new Error('配置删除不调用沙盒') } })
              assert.ok(rejected.kind === 'completed' && !rejected.successful)
              assert.partialDeepStrictEqual(rejected.value, { error: 'MCP server 不存在或不属于当前账号' })
            }
          }
          let providerRounds = 0
          const run = createAgentRunner({ ...harnessPorts, tools: registry.tools, interactions: secureActivation,
            context: { ...harnessPorts.context, async afterTool(context, finished, result) {
              return finished.id === call.id && result.kind === 'completed' && result.successful
                ? [...context, JSON.stringify(result.value)] : context
            } },
            provider: { async *stream(request) {
              providerRounds++
              if (taskCase && providerRounds === 2) assert.deepEqual(JSON.parse(request.context.at(-1)!), {
                success: true, deleted_count: 1, results: [{ deleted_task_id: 21, name: '待删除任务' }],
              })
              if (mailCase && providerRounds === 2) assert.partialDeepStrictEqual(JSON.parse(request.context.at(-1)!), {
                status: 'sent', delivery: 'smtp_accepted', success: true,
              })
              if (knowledgeCase && providerRounds === 2) assert.deepEqual(JSON.parse(request.context.at(-1)!), {
                success: true, knowledge_id: input.knowledge_id,
              })
              if (mcpCase && providerRounds === 2) assert.partialDeepStrictEqual(JSON.parse(request.context.at(-1)!), {
                success: true, server_id: input.server_id,
              })
              yield { type: 'complete', text: providerRounds === 1 ? '' : '已处理', calls: providerRounds === 1 ? [call] : [] }
            } },
          })
          for await (const _event of run.start(identity)) { /* 等待持久确认。 */ }
          const waiting = await store.read(identity)
          const events = await store.readEventsAfter(identity, 0)
          assert.ok(waiting?.status === 'waiting' && waiting.pending, JSON.stringify({ sessionId, status: waiting?.status, events: events.map(event => event.type) }))
          const event = events.find(event => event.type === 'interaction_required')
          assert.ok(event)
          const prompt = await createPostgresInteractionProjection(pool).interaction(event)
          const token = prompt.options.find(option => option.id === action)?.token
          assert.ok(token)
          if (knowledgeCase) assert.deepEqual(await readKnowledge(owner, input.knowledge_id), knowledgeEntry(owner, input.knowledge_id))
          else if (!mailCase) assert.equal((await readTarget())?.rowCount, 1)
          else assert.doesNotMatch(JSON.stringify(prompt), /合成私密正文|receiver@example\.test|synthetic-mail-credential/u)
          if (mcpCase) assert.doesNotMatch(JSON.stringify(prompt), /synthetic-encrypted-header/u)
          assert.equal(sentSubjects.length, sendsBefore)
          await assert.rejects(respond.respond(other, prompt.prompt_id, token), /不存在/u)
          assert.equal((await respond.respond(owner, prompt.prompt_id, token)).result.status, action === 'confirm' ? 'confirmed' : 'cancelled')
          await processOneInteraction({ queue, read: store.read, resume: run.resume, invalidateCredential: async () => {}, diagnose() {} })
          assert.equal((await store.read(identity))?.status, 'completed')
          assert.equal(providerRounds, action === 'confirm' ? 2 : 1)
          const done = (await store.readEventsAfter(identity, 0)).findLast(event => event.type === 'tool_done' && event.payload.toolCallId === call.id)
          assert.equal(done?.payload.status, action === 'confirm' ? 'success' : 'cancelled')
          if (knowledgeCase) assert.deepEqual(await readKnowledge(owner, input.knowledge_id), {
            ...knowledgeEntry(owner, input.knowledge_id), active: action === 'cancel',
          })
          else if (!mailCase) assert.equal((await readTarget())?.rowCount, action === 'confirm' ? 0 : 1)
          assert.equal((await pool.query('SELECT 1 FROM user_skills WHERE owner_id=$1 AND skill_id=$2', [other, 'U1'])).rowCount, 1)
          await assert.rejects(respond.respond(owner, prompt.prompt_id, token), /无效|结束/u)
        }
        assert.equal(skillPublishes, 1)
        assert.deepEqual(taskPublishes, [21])
        assert.deepEqual(sentSubjects, ['确认的邮件'])
        const emailReceipts = (await pool.query("SELECT result_json FROM core_operation_receipts WHERE method LIKE 'agent.email.%'")).rows
        assert.equal(emailReceipts.length, 2)
        assert.doesNotMatch(JSON.stringify(emailReceipts), /receiver@example\.test|合成私密正文|synthetic-mail-credential/u)
        assert.equal((await pool.query('SELECT 1 FROM scheduled_tasks WHERE user_id=$1 AND id=23', [other])).rowCount, 1)
        assert.deepEqual((await pool.query("SELECT pending_source_ids,generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='scheduled_task'", [owner])).rows,
          [{ pending_source_ids: ['21'], generation: 1 }])
        assert.equal((await pool.query("SELECT 1 FROM core_operation_receipts WHERE method='agent.scheduled_task.delete'")).rowCount, 1)
        assert.equal((await pool.query("SELECT 1 FROM core_operation_receipts WHERE method='agent.skill.delete'")).rowCount, 1)
        assert.deepEqual(await readKnowledge(other, 'delete-entry'), knowledgeEntry(other, 'delete-entry'))
        assert.deepEqual(await indexedIds(owner), ['cancel-entry'])
        assert.deepEqual(await indexedIds(other), ['delete-entry'])
        assert.equal((await pool.query("SELECT 1 FROM core_operation_receipts WHERE method LIKE 'agent.knowledge.delete.%'")).rowCount, 2)
        assert.deepEqual(invalidatedMcp, [removedMcpId])
        const keptMcp = (await pool.query('SELECT id FROM user_mcp_servers ORDER BY id')).rows.map(row => row.id)
        assert.deepEqual(keptMcp, [cancelledMcpId, foreignMcpId, systemMcpId].sort())
        assert.deepEqual((await pool.query('SELECT user_id FROM user_mcp_tool_schema_snapshots')).rows, [{ user_id: other }])
        const mcpReceipts = (await pool.query("SELECT result_json FROM core_operation_receipts WHERE method='agent.mcp.remove'")).rows
        assert.equal(mcpReceipts.length, 1)
        assert.doesNotMatch(JSON.stringify(mcpReceipts), /synthetic-encrypted-header/u)

        await confirmationTests.test('定时邮件预授权经 Redis 确认后才对消费者生效', async () => {
          const identity = { ownerId: owner, sessionId: '23', runId: randomUUID() }
          const accessVersion = 'a'.repeat(64)
          const lease = { identity, token: randomUUID(), fence: 1, mode: 'start' as const, cancelRequested: false,
            input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion } }
          await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES (23,$1)', [owner])
          await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,23,$2,'selected',$3,1,now()+interval '5 minutes')", [owner, identity.runId, lease.token])
          const authority = createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() { return accessVersion } })
          const confirmation = createWebAgentToolConfirmation({ pool, lease, intents, action: 'create_scheduled_task', ...authority,
            async describe(_binding, snapshot) {
              assert.match(snapshot.displaySummary ?? '', /无需逐次确认/u)
              return { summary: snapshot.displaySummary! }
            },
          })
          const published: number[] = []
          const definitions = createWebAgentScheduledTaskWrites(core, {
            writes: { validateCron() {}, filesystemAuthorizationEnabled: () => false, resolve: createPostgresTaskResolver({
              async resolveDelivery() { return null },
              async revokeFilesystem() { throw new Error('创建任务时不撤销文件授权') },
            }) },
            filesystemRevocation: { async revokeConfirmation() {}, fingerprint: digest },
            emailAuthorization: { create_scheduled_task: confirmation },
            authorize: authority.authorizeInTransaction, accessVersion,
            workers: { once: true, repeating: false }, async emailAvailable(candidate) { return candidate === owner },
            imEnabled: () => false,
            async publish(candidate, operation, taskId) {
              assert.equal(candidate, owner)
              assert.equal(operation, 'create')
              published.push(taskId)
            },
          })
          assert.ok(definitions)
          const registry = createToolRegistry({ tools: definitions, authorize: async candidate =>
            candidate.ownerId === owner && candidate.sessionId === identity.sessionId && candidate.runId === identity.runId })
          const call = { id: 'create-authorized-task', name: 'create_scheduled_task', input: {
            schedule_name: '预授权定时邮件', instruction: '向已配置的收件渠道发送合成通知', schedule_kind: 'once',
            start_at: '2099-01-02T08:00:00+08:00', authorized_tools: ['send_email'],
          } }
          let rounds = 0
          const run = createAgentRunner({ ...harnessPorts, tools: registry.tools, interactions: secureActivation,
            context: { ...harnessPorts.context, async afterTool(context, finished, result) {
              return finished.id === call.id && result.kind === 'completed' && result.successful
                ? [...context, JSON.stringify(result.value)] : context
            } },
            provider: { async *stream(request) {
              if (++rounds === 2) assert.partialDeepStrictEqual(JSON.parse(request.context.at(-1)!), { success: true, authorized_tools: ['send_email'] })
              yield { type: 'complete', text: rounds === 1 ? '' : '配置已处理', calls: rounds === 1 ? [call] : [] }
            } },
          })
          const readTask = () => pool.query('SELECT id,name,payload,authorized_tools FROM scheduled_tasks WHERE user_id=$1 AND name=$2', [owner, call.input.schedule_name])
          for await (const _event of run.start(identity)) { /* 等待用户确认。 */ }
          assert.equal((await readTask()).rowCount, 0)
          assert.equal((await store.read(identity))?.pending?.kind, 'confirmation')
          const event = (await store.readEventsAfter(identity, 0)).findLast(item => item.type === 'interaction_required')
          assert.ok(event)
          const prompt = await createPostgresInteractionProjection(pool).interaction(event)
          const token = prompt.options.find(option => option.id === 'confirm')!.token
          await respond.respond(owner, prompt.prompt_id, token)
          await processOneInteraction({ queue, read: store.read, resume: run.resume, invalidateCredential: async () => {}, diagnose() {} })
          const { rows: [task], rowCount } = await readTask()
          assert.equal(rowCount, 1)
          assert.deepEqual(task.authorized_tools, ['send_email'])
          assert.equal(await hasScheduledEmailAuthorization(core.db, 'postgres', { ...task, id: String(task.id), ownerId: owner }, Date.now()), true)
          assert.deepEqual(published, [task.id])
          assert.equal((await store.read(identity))?.status, 'completed')
          assert.equal(rounds, 2)
          await assert.rejects(respond.respond(owner, prompt.prompt_id, token), /无效|结束/u)
          assert.deepEqual(published, [task.id])
        })

        await confirmationTests.test('MCP 新增和轮换凭据经确认、私密提交和持久 Run 恢复', async () => {
          const envelope = createByokEnvelope({ keyFile: null, version: 1, masterKey: 'synthetic-mcp-envelope-key' })
          const list = createMcpServerConfigLister(core.db)
          const serverName = '私密表单合成服务'
          const readMcp = async () => (await list(owner)).find(row => row.name === serverName)
          const secrets = createAgentSecretInteractionService({
            consume: createPostgresSecretInteraction(pool, {
              encrypt: values => envelope.encrypt(JSON.stringify(values)), enqueue,
              async invalidate(client, ownerId) { await client.query('DELETE FROM user_mcp_tool_schema_snapshots WHERE user_id=$1', [ownerId]) },
            }),
            async wake() {}, diagnose() {},
          })
          const secretApp = createApp({ appName: 'Gugu', isReady: async () => true, agentSecretInteraction: secrets, userAuth: { secret: authSecret,
            lookupUser: async id => [owner, other].includes(id) ? { id, username: '合成用户', displayName: null, email: 'synthetic@example.test',
              isActive: true, securityVersion: 1, avatarUrl: null, createdAt: null, timezone: 'UTC', emailSubscribed: false, imChannels: [] } : null } })
          const scenarios = [
            { sessionId: '20', operation: 'add', decision: 'confirm', slot: 'token', label: '服务令牌' },
            { sessionId: '21', operation: 'update', decision: 'cancel', slot: 'skip', label: '取消轮换令牌' },
            { sessionId: '22', operation: 'update', decision: 'confirm', slot: 'next', label: '新服务令牌' },
          ] as const
          const invalidations: string[] = []
          try {
            for (const { sessionId, operation, decision, slot, label } of scenarios) {
              const identity = { ownerId: owner, sessionId, runId: randomUUID() }
              const accessVersion = 'a'.repeat(64)
              const lease = { identity, token: randomUUID(), fence: 1, mode: 'start' as const, cancelRequested: false,
                input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion } }
              await pool.query('INSERT INTO conversation_sessions(id,user_id) VALUES ($1,$2)', [sessionId, owner])
              await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,$2,$3,'selected',$4,1,now()+interval '5 minutes')", [owner, sessionId, identity.runId, lease.token])
              const authority = createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() { return accessVersion } })
              const confirmation = createWebAgentToolConfirmation({ pool, lease, intents, action: `${operation}_mcp_server`, ...authority,
                async describe(_binding, snapshot) {
                  assert.ok(snapshot.displaySummary)
                  if (operation === 'update') assert.match(snapshot.displaySummary, /清除旧凭据/u)
                  return { summary: snapshot.displaySummary }
                },
              })
              const authorize: Parameters<typeof createMcpManagementCreateOperations>[1]['authorize'] = async (tx, candidate, signal) =>
                (await authority.authorizeInTransaction(tx, candidate, signal))?.endsWith(`:${accessVersion}`) === true
              const add = operation === 'add' ? createMcpManagementCreateOperations(core, {
                settings: () => ({ default_timeout_seconds: 30, max_tools_per_server: 8, max_servers_per_user: 8 }),
                id: randomUUID, validateEndpoint: url => url, encrypt: envelope.encrypt,
                confirmation, stageCredential: intents.stageMcpCredential, authorize,
              }) : undefined
              const edit = operation === 'update' ? createMcpManagementEditOperations(core, {
                decrypt: envelope.decrypt, authorize,
                async afterCommit(candidate, serverId, reload) {
                  assert.equal(candidate, owner)
                  assert.equal(reload, false)
                  invalidations.push(serverId)
                },
                update: { crypto: envelope, maxTools: 8, validateEndpoint: url => url, confirmation,
                  credential: { id: randomUUID, stage: intents.stageMcpCredential },
                },
              }) : undefined
              const definition = createMcpManagementTool({
                list, enabled: () => true, decrypt: envelope.decrypt,
                state() { throw new Error('配置阶段不连接 MCP 服务') },
              }, undefined, edit, add)
              const registry = createToolRegistry({ tools: [definition], authorize: async candidate =>
                candidate.ownerId === owner && candidate.sessionId === identity.sessionId && candidate.runId === identity.runId })
              const before = await readMcp()
              if (operation === 'add') assert.equal(before, undefined)
              else assert.ok(before?.encrypted_credentials)
              const call = { id: `${operation}-mcp`, name: 'manage_mcp_servers', input: {
                ...(operation === 'add' ? { action: 'add', server_name: serverName, endpoint: 'https://example.invalid/synthetic-path' }
                  : { action: 'update', server_id: before!.id }),
                credential_slots: [{ id: slot, label, target: 'header', parameter_name: 'Authorization', prefix: 'Bearer ' }],
              } }
              const secretValue = `synthetic-private-mcp-test-${slot}`
              let rounds = 0
              const run = createAgentRunner({ ...harnessPorts, tools: registry.tools, interactions: secureActivation,
                context: { ...harnessPorts.context, async resumeInteraction(context, pending, resolution) {
                  return pending.kind === 'credential' ? [...context, JSON.stringify(resolution.value)] : context
                } },
                provider: { async *stream(request) {
                  if (++rounds === 2) assert.deepEqual(JSON.parse(request.context.at(-1)!), { status: 'completed' })
                  yield { type: 'complete', text: rounds === 1 ? '' : '配置已处理', calls: rounds === 1 ? [call] : [] }
                } },
              })
              const projectWaiting = async (kind: string) => {
                assert.equal((await store.read(identity))?.pending?.kind, kind)
                const event = (await store.readEventsAfter(identity, 0)).findLast(event => event.type === 'interaction_required')
                assert.ok(event)
                return createPostgresInteractionProjection(pool).interaction(event)
              }
              const resume = () => processOneInteraction({ queue, read: store.read, resume: run.resume, invalidateCredential: async () => {}, diagnose() {} })
              for await (const _event of run.start(identity)) { /* 等待可信确认。 */ }
              const approval = await projectWaiting('confirmation')
              const approvalToken = approval.options.find(option => option.id === decision)!.token
              assert.deepEqual(await readMcp(), before)
              await respond.respond(owner, approval.prompt_id, approvalToken)
              await resume()

              if (decision === 'cancel') {
                assert.deepEqual(await readMcp(), before)
                assert.equal((await store.read(identity))?.status, 'completed')
                assert.equal(rounds, 1)
                assert.equal(invalidations.length, 0)
                assert.equal((await pool.query("SELECT 1 FROM interaction_prompts WHERE user_id=$1 AND session_id=$2 AND kind='form'", [owner, sessionId])).rowCount, 0)
                continue
              }

              const form = await projectWaiting('credential')
              assert.deepEqual(form.secret_fields, [{ name: slot, label, type: 'secret' }])
              assert.doesNotMatch(JSON.stringify(form), /configuration_version|synthetic-path|Bearer /u)
              const server = await readMcp()
              assert.ok(server)
              if (before) assert.equal(server.id, before.id)
              assert.equal(server.encrypted_credentials, '')
              assert.equal(rounds, 1)
              const submit = (userHeaders = headers) => secretApp.inject({ method: 'POST',
                url: `/api/v1/agent/interactions/${form.prompt_id}/secrets`, headers: userHeaders, payload: { values: { [slot]: secretValue } } })
              assert.equal((await submit(otherHeaders)).statusCode, 404)
              await pool.query('UPDATE user_mcp_servers SET timeout_seconds=$2 WHERE id=$1', [server.id, server.timeout_seconds + 1])
              const stale = await submit()
              assert.equal(stale.statusCode, 409)
              assert.match(stale.body, /配置已变化/u)
              assert.equal((await readMcp())?.encrypted_credentials, '')
              await pool.query('UPDATE user_mcp_servers SET timeout_seconds=$2 WHERE id=$1', [server.id, server.timeout_seconds])
              const saved = await submit()
              assert.equal(saved.statusCode, 200)
              assert.equal(saved.body.includes(secretValue), false)
              assert.equal((await submit()).statusCode, 409)
              const stored = (await readMcp())!
              assert.notEqual(stored.encrypted_credentials, '')
              assert.deepEqual(JSON.parse(await envelope.decrypt({
                ciphertext: stored.encrypted_credentials, nonce: stored.credentials_nonce,
                encryptedDataKey: stored.encrypted_credentials_key, keyVersion: stored.credentials_key_version,
              })), { [slot]: secretValue })
              await resume()
              const events = await store.readEventsAfter(identity, 0)
              assert.equal(JSON.stringify(events).includes(secretValue), false)
              assert.equal(JSON.stringify(await store.read(identity)).includes(secretValue), false)
              assert.equal((await store.read(identity))?.status, 'completed')
              assert.equal(rounds, 2)
              assert.equal((await queue.pending()).some(job => job.identity.runId === identity.runId), false)
            }
            assert.deepEqual(invalidations, [(await readMcp())!.id])
            const updates = (await pool.query("SELECT result_json FROM core_operation_receipts WHERE method='agent.mcp.update'")).rows
            assert.equal(updates.length, 1)
            assert.doesNotMatch(JSON.stringify(updates), /synthetic-private-mcp-test|Bearer |synthetic-path/u)
          } finally { await secretApp.close() }
        })
      } finally {
        try { await core.close() } finally { await rm(root, { recursive: true, force: true }) }
      }
    })
  } finally { streamAbort.abort(); await Promise.allSettled(background); await close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
