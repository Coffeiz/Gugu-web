import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import { createPostgresAgentRunStore } from '../../src/domains/agent-sessions/persistence/agent-run-store-postgres.js'
import { createPostgresAgentRunLeasePort } from '../../src/domains/agent-sessions/persistence/agent-run-lease-postgres.js'
import { createPostgresInteractionConsumeStore } from '../../src/domains/agent-sessions/persistence/agent-interaction-consume-postgres.js'
import { createInteractionResumeEnqueuer, createPostgresInteractionResumeQueue } from '../../src/domains/agent-sessions/persistence/agent-interaction-resume-postgres.js'
import { createPostgresInteractionProjection } from '../../src/domains/agent-sessions/persistence/agent-interaction-projection-postgres.js'
import { createPostgresInteractionActivator } from '../../src/domains/agent-sessions/persistence/agent-interaction-activate-postgres.js'
import { consumeInteractionAction } from '../../src/domains/agent-sessions/application/agent-interaction-consume.js'
import { processOneInteraction } from '../../src/domains/agent-sessions/agent-interaction-worker.js'
import { createAgentChatService } from '../../src/domains/agent-sessions/agent-chat-service.js'
import { stableJson, createAgentRunner, type CanonicalContextPorts, type RunIdentity, type AgentRunnerPorts } from '@gugu/core/agent'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { createPersistentAgentRuntime } from '../../src/domains/agent-sessions/agent-persistent-runtime.js'
import { createRedisAgentCancellationCommands } from '../../src/adapters/redis-events.js'
import { createRedisLiveSubscription } from '../../src/adapters/redis-live-subscription.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL, redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
test('隔离 PG 和 Redis 下 Agent 执行、取消、归属与 outbox 重放', { skip: !(databaseUrl && redisUrl) && '需要显式隔离 PG 与 Redis', timeout: 30000 }, async () => {
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
      projection: { async interaction() { return { type: 'interaction_required' } } },
      async prepare(user, body) {
        const id = body.session_id!
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
    await pool.query("CREATE TABLE mcp_secret_inputs (user_id uuid, session_id integer, status text, encrypted_payload text, payload_nonce text, encrypted_data_key text)")
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
    await pool.query("INSERT INTO mcp_secret_inputs VALUES ($1,8,'awaiting_secret','cipher','nonce','wrapped')", [owner])
    await activator.activate(id, { id: 'replacement-second', kind: 'confirmation', toolCall }, signal)
    const replaced = await pool.query("SELECT status FROM interaction_prompts WHERE user_id=$1 AND session_id=8 ORDER BY id DESC LIMIT 2", [owner])
    assert.deepEqual(replaced.rows.map(row => row.status), ['active', 'cancelled'])
    const staged = (await pool.query('SELECT status, encrypted_payload, payload_nonce, encrypted_data_key FROM mcp_secret_inputs WHERE user_id=$1', [owner])).rows[0]
    assert.deepEqual(staged, { status: 'cancelled', encrypted_payload: '', payload_nonce: '', encrypted_data_key: '' })
  } finally { streamAbort.abort(); await Promise.allSettled(background); await close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
