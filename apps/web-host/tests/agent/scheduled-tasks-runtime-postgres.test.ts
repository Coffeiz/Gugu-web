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
import { tablesSql } from '../../../../packages/core/src/data/schema.js'
import { createAgentRuntime } from '@gugu/core/agent'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { agentContextAccessScope } from '../../src/domains/agent-config/access-scope.js'
import { bindProviderSelection } from '../../src/domains/agent-config/provider-resolver.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
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
