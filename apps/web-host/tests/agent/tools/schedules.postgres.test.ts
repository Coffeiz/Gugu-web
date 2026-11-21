import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '@gugu/core/scheduled-task-list'
import { createPostgresRuntime } from '@gugu/core/data'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createCanonicalSourceLoader, stableJson } from '@gugu/core/agent'
import type { CanonicalContextPorts, CanonicalRunContext, AgentRunnerPorts, RunCheckpoint, RunEvent } from '@gugu/core/agent'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { tablesSql } from '../../../../../packages/core/src/data/schema.js'
import { createAgentRuntime } from '@gugu/core/agent'
import { createAgentToolRegistry } from '../../../src/modules/agent/tools/registry.js'
import { agentContextAccessScope } from '../../../src/modules/agent/llm/access.js'
import { bindProviderSelection } from '../../../src/modules/agent/llm/bind.js'
import { createScheduledTaskDeleteTool } from '../../../../../packages/core/src/agent/tools/scheduled-tasks.js'
import { createAgentRagRebuildWorker } from '../../../src/modules/agent/rag/rebuild.js'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from '../../../src/modules/agent/tools/confirm.js'
import { createPostgresTrustedIntentStore } from '../../../src/modules/agent/interactions/intents.js'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../../src/modules/agent/rag/production.js'
import { applyRagIndexMigration } from '@gugu/database/postgres/migrations/0011_rag_index'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('定时任务删除验证真实确认、事务回滚和 PostgreSQL 索引墓碑', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `gugu_delete_task_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema })
  const identity = { ownerId: randomUUID(), sessionId: '1', runId: 'task-delete-run' }
  const foreign = randomUUID()
  const lease = { identity, token: 'task-delete-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64), v: 2 as const, source: 'web' as const } }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const ddl = tablesSql('postgres')
    await pool.query([ddl.scheduledTasks, ddl.ragJobs, ddl.receipts, `
      CREATE TABLE users(id uuid PRIMARY KEY, security_version integer DEFAULT 1, is_active boolean DEFAULT true, account_status text);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY, user_id uuid, active_run_id text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,expires_at timestamptz);
      CREATE TABLE agent_interaction_intents(user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text,ciphertext text,nonce text,encrypted_data_key text,key_version integer,expires_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,interaction_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text);
      CREATE TABLE agent_interaction_bindings(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,tool_call_id text);
      CREATE TABLE agent_interaction_resumes(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,receipt text);
      CREATE TABLE interaction_prompts(id integer,user_id uuid,session_id integer,kind text,status text,expires_at timestamptz,schema_json jsonb);
      CREATE TABLE interaction_actions(prompt_id integer,status text,option_id text,action_type text,context_json jsonb,expires_at timestamptz)
    `].join(';\n'))
    await pool.query('INSERT INTO users(id) VALUES ($1),($2)', [identity.ownerId, foreign])
    await applyRagIndexMigration(pool)
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1,$2)', [identity.ownerId, identity.runId])
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,1,$2,'selected',$3,1,CURRENT_TIMESTAMP+interval '5 minutes')", [identity.ownerId, identity.runId, lease.token])
    await pool.query("INSERT INTO agent_run_leases VALUES ($1,1,$2,CURRENT_TIMESTAMP+interval '5 minutes')", [identity.ownerId, identity.runId])
    await pool.query(`INSERT INTO scheduled_tasks
      (id,user_id,event_id,name,payload,cron,channels,enabled,created_at,updated_at) VALUES
      (1,$1,NULL,'测试任务一','内容一','0 9 * * *','web',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      (2,$1,NULL,'测试任务二','内容二','0 9 * * *','web',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      (3,$1,99,'活动提醒','提醒内容','0 9 * * *','web',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      (4,$2,NULL,'其他用户任务','异主内容','0 9 * * *','web',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [identity.ownerId, foreign])
    await pool.query(`INSERT INTO rag_index_jobs
      (user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at)
      VALUES ($1,'scheduled_task','','[]','','refresh','queued',1,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [identity.ownerId])
    const { work } = createAgentRagRebuildWorker(core)
    assert.equal(await work(), 'ready')
    const activeIndex = async () => (await pool.query(`SELECT source_id FROM knowledge_index_entries
      WHERE owner_user_id=$1 AND deleted_at IS NULL ORDER BY source_id`, [identity.ownerId])).rows.map(row => row.source_id)
    assert.deepEqual(await activeIndex(), ['1','2','3'])
    const authority = createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() { return lease.input.accessVersion } })
    const confirmation = createWebAgentToolConfirmation({
      pool, lease, action: 'delete_scheduled_task',
      intents: createPostgresTrustedIntentStore(() => 'synthetic-master', 1),
      ...authority,
      async describe() { return { summary: '删除两条合成定时任务' } },
    })
    const published: number[] = []
    const { toolRegistry } = createAuthorizedWebAgentProductionRagRunPorts({
      core, pool, lease, storageRoot: '/synthetic',
      selection: { modelIdentity: 'synthetic', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
      enabled: () => true,
      scheduledTaskDelete: createScheduledTaskDeleteTool(core, confirmation, async (_owner, id) => { published.push(id) }),
    })
    const name = 'delete_scheduled_task'
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      async execute(): Promise<never> { throw new Error('删除任务不调用执行器') } }
    for (const id of [3, 4]) {
      const disallowed = await toolRegistry.tools.dispatch({ id: `denied-${id}`, name, input: { task_id: id } }, scope)
      assert.ok(disallowed.kind === 'completed' && !disallowed.successful)
      assert.equal((disallowed.value as { error: string }).error, '定时任务不存在')
    }
    const call = { id: 'delete-batch', name, input: { task_ids: [2, 1] } }
    const waiting = await toolRegistry.tools.dispatch(call, scope)
    assert.ok(waiting.kind === 'waiting', JSON.stringify(waiting))
    const interaction = waiting.interaction.id
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM scheduled_tasks')).rows[0].n, 4)
    const syntheticCode = 'test-confirm-code'
    // 模拟用户已提交确认后的投影。加密意图、验证与认领均走生产适配器。
    await pool.query('INSERT INTO agent_interaction_bindings VALUES ($1,1,$2,9,$3,$4)', [identity.ownerId, identity.runId, interaction, call.id])
    await pool.query("INSERT INTO agent_interaction_resumes VALUES ($1,1,$2,9,$3,'web-prompt:9')", [identity.ownerId, identity.runId, interaction])
    await pool.query("INSERT INTO agent_run_interaction_receipts VALUES ($1,1,$2,'web-prompt:9')", [identity.ownerId, identity.runId])
    await pool.query(`INSERT INTO interaction_prompts VALUES
      (9,$1,1,'confirm','resolved',CURRENT_TIMESTAMP+interval '1 minute',$2)`, [identity.ownerId,
      { context: { confirm_code: syntheticCode }, resolved_result: { status: 'confirmed', option_id: 'confirm', confirm: true } }])
    await pool.query(`INSERT INTO interaction_actions VALUES
      (9,'consumed','confirm','confirm',$1,CURRENT_TIMESTAMP+interval '1 minute')`,
      [{ tool_call_id: call.id, tool_name: name, confirm_code: syntheticCode }])
    const resume = { ...scope, resolution: { interactionId: interaction, receiptId: 'web-prompt:9', status: 'confirmed' as const, value: {} } }
    const forged = await toolRegistry.tools.dispatch(call, { ...resume, resolution: { ...resume.resolution, receiptId: 'forged' } })
    assert.ok(forged.kind === 'completed' && !forged.successful)
    await pool.query('ALTER TABLE rag_index_jobs ADD CONSTRAINT queue_blocked CHECK(generation < 2)')
    assert.equal((await toolRegistry.tools.dispatch(call, resume)).kind, 'unknown')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_intents')).rows[0].n, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM scheduled_tasks')).rows[0].n, 4)
    assert.deepEqual(published, [])
    await pool.query('ALTER TABLE rag_index_jobs DROP CONSTRAINT queue_blocked')
    const deleted = await toolRegistry.tools.dispatch(call, resume)
    assert.ok(deleted.kind === 'completed' && deleted.successful && deleted.mutated, JSON.stringify(deleted))
    assert.deepEqual(deleted.value, { success: true, deleted_count: 2, results: [
      { deleted_task_id: 1, name: '测试任务一' }, { deleted_task_id: 2, name: '测试任务二' },
    ] })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_interaction_intents')).rows[0].n, 0)
    const replay = await toolRegistry.tools.dispatch(call, resume)
    assert.ok(replay.kind === 'completed' && replay.successful && !replay.mutated)
    assert.deepEqual(published, [1, 2])
    assert.deepEqual((await pool.query('SELECT id FROM scheduled_tasks ORDER BY id')).rows, [{ id: 3 }, { id: 4 }])
    assert.equal(await work(), 'ready')
    assert.deepEqual(await activeIndex(), ['3'])
  } finally {
    await core.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
  }
})
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
type RuntimePorts = Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>

/** Provider、RunStore、lease、授权、上下文源均为替身；Host runtime/registry/Provider adapter/Core仓储/PG为真实实现。 */
async function runReadRound(core: SqlDataRuntime, ownerId: string, timezone: string, reject = false, capabilities = true) {
  const identity = { ownerId, sessionId: '1', runId: randomUUID() }
  const allowed = new Set(['list_scheduled_tasks'])
  const query = createScheduledTaskQueries(createKyselyScheduledTaskReader(core.db, 'postgres'), () => ({ workspaceSupported: capabilities, filesystemAuthorizationEnabled: capabilities }), () => '2026-01-02T00:00:00Z')
  const registry = createAgentToolRegistry({ core,
    authorize: async (scope, name) => scope.ownerId === ownerId && allowed.has(name),
    scheduledTasks: { list: (scope, signal) => query.agent(scope.ownerId, signal) },
  })
  const policy = { groupChat: false, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
  const access = agentContextAccessScope('synthetic-read-tools-secret', identity, policy, { permissions: '1', model: '1', credentials: '1' }, digest, 'owner')
  const bound = await bindProviderSelection(identity, {
    selectPlatformModel: async () => ({ config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '合成系统', byokEnabled: false, localDeployment: false, accessScopeHash: access.accessScopeHash }),
    readActiveCredential: async () => null, decryptCredential: () => { throw new Error('只读替身不读取凭据') }, defaultBaseUrl: () => '',
  }, new AbortController().signal)
  const source = createCanonicalSourceLoader({ digest, nextId: randomUUID, now: () => 0,
    readSnapshot: async () => ({ ...identity, contextEpoch: 0, context: null, snapshotHash: null, sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }),
    select: async () => ({ ...policy, modelIdentity: bound.modelIdentity, contextWindow: 10000, locale: 'zh-CN', workspaceBinding: null, contextScopeKey: access.contextScopeKey }),
    currentRevision: async () => 0, historyReader: { read: async () => ({ baselineSeq: 0, rows: [] }) },
    currentTurn: async () => ({ currentUser: { persistedMessageId: '1', message: { role: 'user', content: '请查询联系人、项目和当前时间。' } } }),
    data: { loadTimezone: async () => timezone, loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [], loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}), loadMemory: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => [] },
    builder: { buildSnapshot: () => ({ systemPrompt: '系统', snapshotContext: '合成快照', sessionInfo: {}, userTimezone: timezone }), buildRequest: () => ({ systemPrompt: '系统', systemInMessages: false, fixedPrefix: [] }) },
  })
  const context: CanonicalContextPorts = {
    digest, nextId: randomUUID,
    load: async (id, signal) => { const tools = await registry.capabilities(id); return { ...await source.load(id, signal), capabilities: { toolNames: tools.map(tool => tool.name), tools } } },
    preparation: { buildRag: async () => ({ tail: [] }) },
    // 此端口只提供非持久前缀/动态尾部；工具结果必须由真实Canonical prepared.area恢复进入wire。
    prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
    references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
    compaction: { summarize: async () => { throw new Error('只读轮不应压缩') } }, finalization: { complete: async () => {} }, currentRequest: () => null,
    stageContinuation: async () => { throw new Error('不应启动续接') }, releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
  }
  let checkpoint: RunCheckpoint<CanonicalRunContext> | null = null
  const outbox: RunEvent[] = [], committedToolResults: unknown[] = []
  const runtime: RuntimePorts = {
    clock: { now: () => '2026-01-01T20:00:00Z' },
    store: {
      read: async () => checkpoint,
      create: async (value, _lease, events) => { checkpoint = structuredClone(value); outbox.push(...events) },
      commit: async change => { assert.equal(checkpoint?.version, change.expectedVersion); checkpoint = structuredClone(change.checkpoint); outbox.push(...change.events); committedToolResults.push(...change.checkpoint.toolResults) },
      pendingEvents: async () => outbox, acknowledgeEvents: async () => {},
    },
    leases: { acquire: async () => ({ token: 'synthetic-lease', fence: 1 }), assert: async () => {}, release: async () => {} },
    cancellation: { isRequested: async () => false, request: async () => {}, notify: async () => {}, subscribe: async () => () => {} },
    tools: registry.tools, interactions: { activate: async (_id, request) => request },
    sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
    presentError: () => ({ code: 'failed', text: '合成运行失败' }), presentToolResult: async value => value,
    publish: async () => {}, diagnose: () => {},
  }
  const wireResults = new Map<string, unknown>()
  let requests = 0
  const instance = createAgentRuntime({ context, runtime,
    executor: { authorize: async () => { throw new Error('只读工具不得授权执行器') }, executor: { execute: async () => { throw new Error('只读工具不得执行进程') } } },
    provider: { resolve: bound.resolve, transport: { request: async request => {
      requests++
      const body = request.body as Record<string, unknown>
      if (requests === 1) {
        const definitions = body.tools as Array<{ function: { name: string } }>
        assert.deepEqual(definitions.map(tool => tool.function.name).sort(), ['list_scheduled_tasks'])
        if (reject) allowed.delete('list_scheduled_tasks')
        const calls = [{ index: 0, id: 'tasks', type: 'function', function: { name: 'list_scheduled_tasks', arguments: '{}' } }]
        return response({ tool_calls: calls }, 'tool_calls')
      }
      assert.equal(requests, 2)
      const messages = body.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>
      const actual = messages.filter(message => message.role === 'tool')
      assert.deepEqual(actual.map(message => message.tool_call_id), ['tasks'])
      for (const message of actual) {
        // 真实Provider缓存投影可把JSON文本包为单个ephemeral text块；仍读取实际wire正文。
        let content = message.content
        if (typeof content !== 'string') {
          assert.ok(Array.isArray(content))
          assert.equal(content.length, 1)
          assert.deepEqual(Object.keys(content[0]).sort(), ['cache_control', 'text', 'type'])
          assert.equal(content[0].type, 'text')
          assert.deepEqual(content[0].cache_control, { type: 'ephemeral' })
          content = content[0].text
        }
        assert.equal(typeof content, 'string')
        wireResults.set(message.tool_call_id!, JSON.parse(content as string))
      }
      return response({ content: reject ? '部分查询未完成。' : '查询结果已读取。' }, 'stop')
    } } },
  })
  const events: RunEvent[] = []
  try {
    for await (const event of instance.harness.start(identity)) events.push(event)
    assert.equal(requests, 2)
    assert.equal(events.at(-1)?.payload.status, 'completed')
    assert.ok(committedToolResults.length >= 1)
    return { wireResults, events }
  } finally { await instance.close(); bound.release() }
}
function response(delta: Record<string, unknown>, finish: string) {
  return { status: 200, headers: {}, body: (async function* () {
    yield new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
  })(), cancel: async () => {} }
}

test('Host Runtime 经真实共享查询读取隔离PG任务并进入Provider续轮', { skip: !databaseUrl && '需要显式隔离 PostgreSQL 测试连接', timeout: 30000 }, async () => {
  const schema = `gugu_schedule_runtime_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 2 })
  try {
    await pool.query(tablesSql('postgres').scheduledTasks)
    const owner = randomUUID(), other = randomUUID()
    for (const [id, user, event] of [[1, owner, null], [2, owner, 7], [3, owner, null], [4, other, null]] as const)
      await pool.query(`INSERT INTO scheduled_tasks(id,user_id,event_id,name,payload,cron,schedule_kind,channels,enabled,workspace_id,filesystem_authorization_grant_id,created_at,updated_at) VALUES($1,$2,$3,$4,'指令','0 9 * * *','cron','web',true,$5,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [id,user,event,`合成任务${id}`,id === 3 ? 101 : null,id === 3 ? 202 : null])
    const before = (await pool.query('SELECT * FROM scheduled_tasks ORDER BY id')).rows
    const own = await runReadRound(core, owner, 'UTC')
    assert.deepEqual((own.wireResults.get('tasks') as Array<{ id: number }>).map(row => row.id), [3, 1])
    assert.deepEqual((own.wireResults.get('tasks') as Array<{ workspace_id: number | null; filesystem_authorized: boolean }>).map(row => [row.workspace_id, row.filesystem_authorized]), [[101, true], [null, false]])
    const disabled = await runReadRound(core, owner, 'UTC', false, false)
    assert.deepEqual((disabled.wireResults.get('tasks') as Array<{ workspace_id: number | null; filesystem_authorized: boolean }>).map(row => [row.workspace_id, row.filesystem_authorized]), [[null, false], [null, false]])
    const theirs = await runReadRound(core, other, 'UTC')
    assert.deepEqual((theirs.wireResults.get('tasks') as Array<{ id: number }>).map(row => row.id), [4])
    const denied = await runReadRound(core, owner, 'UTC', true)
    assert.ok((denied.wireResults.get('tasks') as { error: unknown }).error)
    assert.deepEqual((await pool.query('SELECT * FROM scheduled_tasks ORDER BY id')).rows, before)
  } finally { await core.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
