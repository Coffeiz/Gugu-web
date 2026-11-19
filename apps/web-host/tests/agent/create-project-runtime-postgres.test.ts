import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createKyselyProjectCreateRuntime } from '@gugu/core/project-create-data'
import type { ProjectCreateRuntime } from '@gugu/core/project-create'
import { createPostgresRuntime } from '@gugu/core/data'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createCanonicalSourceLoader, stableJson } from '@gugu/core/agent'
import type { CanonicalContextPorts, CanonicalRunContext, AgentRunnerPorts, RunCheckpoint, RunEvent } from '@gugu/core/agent'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { tablesSql } from '../../../../packages/core/src/data/schema.js'
import { createAgentRuntime } from '@gugu/core/agent'
import { createAgentToolRegistry } from '../../src/modules/agent-sessions/tools/agent-tool-registry.js'
import { agentContextAccessScope } from '../../src/modules/agent/model-config/access-scope.js'
import { bindProviderSelection } from '../../src/modules/agent/model-config/provider-resolver.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
type RuntimePorts = Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>

/** Provider、RunStore、lease、授权、上下文源均为替身；Host runtime/registry/Provider adapter/Core仓储/PG为真实实现。 */
async function runProjectRound(core: SqlDataRuntime, projects: ProjectCreateRuntime, ownerId: string, invalid = false, seedConflict = false, restart = false) {
  const identity = { ownerId, sessionId: '1', runId: randomUUID() }
  const allowed = new Set(['create_project'])
  const timezone = 'UTC'
  const registry = createAgentToolRegistry({ core, projects,
    authorize: async (scope, name) => scope.ownerId === ownerId && allowed.has(name),
  })
  if (seedConflict) {
    const seeded = await registry.tools.dispatch({ id: 'create', name: 'create_project', input: { project_name: '先前项目', start_date: '2026-01-01', deadline: '2026-02-01' } }, {
      identity, roundId: `${identity.runId}:1`, signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不得执行宿主进程') },
    })
    assert.equal(seeded.kind, 'completed')
    if (seeded.kind === 'completed') assert.equal(seeded.successful, true)
  }
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
  let dispatches = 0
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
    tools: { ...registry.tools, dispatch: async (...args) => { dispatches++; return registry.tools.dispatch(...args) } }, interactions: { activate: async (_id, request) => request },
    sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
    presentError: () => ({ code: 'failed', text: '合成运行失败' }), presentToolResult: async value => value,
    publish: async () => {}, diagnose: () => {},
  }
  const wireResults = new Map<string, unknown>()
  let requests = 0
  const makeInstance = () => createAgentRuntime({ context, runtime,
    executor: { authorize: async () => { throw new Error('只读工具不得授权执行器') }, executor: { execute: async () => { throw new Error('只读工具不得执行进程') } } },
    provider: { resolve: bound.resolve, transport: { request: async request => {
      requests++
      const body = request.body as Record<string, unknown>
      if (requests === 1) {
        const definitions = body.tools as Array<{ function: { name: string } }>
        assert.deepEqual(definitions.map(tool => tool.function.name), ['create_project'])
        return response({ tool_calls: [{ index: 0, id: 'create', type: 'function', function: { name: 'create_project', arguments: JSON.stringify({ project_name: '合成项目', start_date: '2026-01-01', deadline: invalid ? '2026-02-31' : '2026-02-01' }) } }] }, 'tool_calls')
      }
      assert.equal(requests, 2)
      const messages = body.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>
      const result = messages.find(message => message.role === 'tool' && message.tool_call_id === 'create')
      assert.ok(result)
      let content = result.content
      if (Array.isArray(content)) content = content[0].text
      assert.equal(typeof content, 'string')
      wireResults.set('create', JSON.parse(content as string))
      if (invalid || seedConflict) {
        assert.deepEqual(wireResults.get('create'), { error: expectText(wireResults.get('create')), tool: 'create_project', usage_hint: '工具执行失败。先根据错误信息判断下一步；需要用户补充信息时先询问，不要重复提交相同参数。', next_action: '根据错误信息修正或向用户询问缺失信息；确认没有新信息前不要盲目重试。' })
        if (seedConflict) assert.equal((wireResults.get('create') as { error: string }).error, '该 Idempotency-Key 已用于不同的创建内容')
      } else assert.equal((wireResults.get('create') as { success: boolean }).success, true)
      return response({ content: '完成。' }, 'stop')
    } } },
  })
  let instance = makeInstance()
  const events: RunEvent[] = []
  try {
    if (restart) {
      const stream = instance.harness.start(identity)
      while (true) {
        const next = await stream.next()
        assert.equal(next.done, false)
        if (next.done) throw new Error('工具结果提交前运行已结束')
        events.push(next.value)
        if (next.value.type === 'tool_done') break
      }
      assert.equal(requests, 1)
      assert.equal(dispatches, 1)
      await stream.return(undefined as never)
      await instance.close()
      instance = makeInstance()
      for await (const event of instance.harness.resume(identity)) events.push(event)
      assert.equal(dispatches, 1)
    } else for await (const event of instance.harness.start(identity)) events.push(event)
    assert.equal(requests, 2)
    assert.equal(events.at(-1)?.payload.status, 'completed')
    assert.ok(committedToolResults.length >= 1)
    if (invalid || seedConflict) {
      const expectedCode = seedConflict ? 'conflict' : 'invalid_request'
      assert.ok(committedToolResults.some(item => {
        const value = (item as { result?: { value?: { type?: string; payload?: { error_code?: string } } } }).result?.value
        return value?.type === 'harness-tool-result-checkpoint' && value.payload?.error_code === expectedCode
      }))
      assert.ok(events.some(event => event.type === 'tool_done' && (event.payload.result as { error_code?: string })?.error_code === expectedCode))
    }
    return { wireResults, events }
  } finally { await instance.close(); bound.release() }
}
function expectText(value: unknown): string {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  const error = (value as { error?: unknown }).error
  assert.equal(typeof error, 'string')
  assert.ok(error)
  return error as string
}
function response(delta: Record<string, unknown>, finish: string) {
  return { status: 200, headers: {}, body: (async function* () {
    yield new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
  })(), cancel: async () => {} }
}

test('Host runtime 创建项目并写入隔离 PG，用户数据彼此隔离', {
  skip: !databaseUrl && '需要显式隔离 PostgreSQL 测试连接', timeout: 30000,
}, async () => {
  const schema = `gugu_project_tools_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 2 })
  try {
    await pool.query(tablesSql('postgres').projects)
    const projects = createKyselyProjectCreateRuntime({ db: core.db, backend: 'postgres', async publishProjectCreated() {} })
    const owner = randomUUID(), other = randomUUID()
    const first = await runProjectRound(core, projects, owner)
    const second = await runProjectRound(core, projects, other)
    const firstId = (first.wireResults.get('create') as { project_id: number }).project_id
    const secondId = (second.wireResults.get('create') as { project_id: number }).project_id
    assert.notEqual(firstId, secondId)
    const rows = await pool.query('SELECT id, user_id, name FROM projects ORDER BY id')
    assert.deepEqual(rows.rows.map(row => [Number(row.id), row.user_id, row.name]), [[firstId, owner, '合成项目'], [secondId, other, '合成项目']])
    await runProjectRound(core, projects, owner, true)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM projects')).rows[0].n), 2)
    await runProjectRound(core, projects, owner, false, true)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM projects')).rows[0].n), 3)
    await runProjectRound(core, projects, owner, false, true, true)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM projects')).rows[0].n), 4)
    const registry = createAgentToolRegistry({ core, projects, authorize: async () => true })
    const identity = { ownerId: owner, sessionId: '1', runId: 'synthetic-replay' }
    const scope = { identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不得执行宿主进程') } }
    const call = { id: 'same-call', name: 'create_project', input: { project_name: '幂等项目', start_date: '2026-01-01', deadline: '2026-02-01' } }
    const created = await registry.tools.dispatch(call, scope)
    const replay = await registry.tools.dispatch(call, scope)
    const conflict = await registry.tools.dispatch({ ...call, input: { ...call.input, project_name: '不同参数' } }, scope)
    assert.equal(created.kind, 'completed'); assert.equal(replay.kind, 'completed'); assert.equal(conflict.kind, 'completed')
    if (created.kind === 'completed' && replay.kind === 'completed' && conflict.kind === 'completed') {
      assert.equal((created.value as { success: boolean }).success, true)
      assert.equal((replay.value as { project_id: number }).project_id, (created.value as { project_id: number }).project_id)
      assert.equal((replay.value as { idempotent_replay: boolean }).idempotent_replay, true)
      assert.equal(conflict.successful, false)
    }
    for (const changed of [{ ...call.input, deadline: '2026-02-31' }, { ...call.input, stages: [' '] }]) {
      const invalidRetry = await registry.tools.dispatch({ ...call, input: changed }, scope)
      assert.equal(invalidRetry.kind, 'completed')
      if (invalidRetry.kind === 'completed') {
        assert.equal(invalidRetry.successful, false)
        assert.equal((invalidRetry.value as { error_code: string }).error_code, 'conflict')
        assert.equal((invalidRetry.modelValue as { error: string }).error, '该 Idempotency-Key 已用于不同的创建内容')
      }
    }
    const afterReplay = await pool.query('SELECT name FROM projects WHERE user_id = $1 ORDER BY id', [owner])
    assert.deepEqual(afterReplay.rows.map(row => row.name), ['合成项目', '先前项目', '先前项目', '幂等项目'])
  } finally {
    await core.close(); await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end()
  }
})
