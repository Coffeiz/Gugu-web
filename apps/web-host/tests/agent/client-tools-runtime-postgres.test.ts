import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dataContext } from '@gugu/core'
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
async function runClientRound(core: SqlDataRuntime, ownerId: string, otherId: number, revoke = false) {
  const identity = { ownerId, sessionId: '1', runId: randomUUID() }
  const allowed = new Set(['create_client', 'update_client'])
  const timezone = 'UTC'
  const registry = createAgentToolRegistry({ core,
    authorize: async (scope, name) => scope.ownerId === ownerId && allowed.has(name),
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
        assert.deepEqual(definitions.map(tool => tool.function.name).sort(), ['create_client', 'update_client'])
        return response({ tool_calls: [{ index: 0, id: 'create', type: 'function', function: { name: 'create_client', arguments: JSON.stringify({ client_name: '合成新联系人', notes: '初始' }) } }] }, 'tool_calls')
      }
      const messages = body.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>
      const actual = messages.filter(message => message.role === 'tool')
      for (const message of actual) {
        let content = message.content
        if (Array.isArray(content)) content = content[0].text
        assert.equal(typeof content, 'string')
        wireResults.set(message.tool_call_id!, JSON.parse(content as string))
      }
      if (requests === 2) {
        const created = wireResults.get('create') as { success: boolean; client_id: number }
        assert.equal(created.success, true)
        assert.ok(created.client_id > 0)
        // 工具已在第一轮暴露，下一轮派发前撤销权限。
        if (revoke) allowed.delete('update_client')
        return response({ tool_calls: [
          { index: 0, id: 'update', type: 'function', function: { name: 'update_client', arguments: JSON.stringify({ client_id: created.client_id, notes: '更新后' }) } },
          { index: 1, id: 'other', type: 'function', function: { name: 'update_client', arguments: JSON.stringify({ client_id: otherId, notes: '越权' }) } },
        ] }, 'tool_calls')
      }
      assert.equal(requests, 3)
      if (revoke) {
        assert.ok((wireResults.get('update') as { error: unknown }).error)
        assert.ok((wireResults.get('other') as { error: unknown }).error)
      } else {
        assert.equal((wireResults.get('update') as { success: boolean }).success, true)
        assert.equal((JSON.parse(wireResults.get('other') as string) as { error: string }).error, '联系人不存在')
      }
      return response({ content: '完成。' }, 'stop')
    } } },
  })
  const events: RunEvent[] = []
  try {
    for await (const event of instance.harness.start(identity)) events.push(event)
    assert.equal(requests, 3)
    assert.equal(events.at(-1)?.payload.status, 'completed')
    assert.ok(committedToolResults.length >= 3)
    return { wireResults, events }
  } finally { await instance.close(); bound.release() }
}
function response(delta: Record<string, unknown>, finish: string) {
  return { status: 200, headers: {}, body: (async function* () {
    yield new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
  })(), cancel: async () => {} }
}

test('Host runtime 经真实注册器持久创建和更新联系人，拒绝跨用户写入', {
  skip: !databaseUrl && '需要显式隔离 PostgreSQL 测试连接', timeout: 30000,
}, async () => {
  const schema = `gugu_client_tools_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 2 })
  try {
    await pool.query(tablesSql('postgres').clients)
    const owner = randomUUID(), otherOwner = randomUUID()
    const other = await core.transaction(dataContext(otherOwner), data => data.clients.create({ name: '另一用户', notes: '保持' }))
    const result = await runClientRound(core, owner, other.id)
    const created = result.wireResults.get('create') as { client_id: number }
    const ownRows = await core.transaction(dataContext(owner), data => data.clients.list())
    const otherRows = await core.transaction(dataContext(otherOwner), data => data.clients.list())
    assert.equal(ownRows.find(row => row.id === created.client_id)?.notes, '更新后')
    assert.equal(otherRows.find(row => row.id === other.id)?.notes, '保持')
    const revoked = await runClientRound(core, owner, other.id, true)
    const revokedCreated = revoked.wireResults.get('create') as { client_id: number }
    const afterRevoke = await core.transaction(dataContext(owner), data => data.clients.list())
    const otherAfterRevoke = await core.transaction(dataContext(otherOwner), data => data.clients.list())
    assert.equal(afterRevoke.find(row => row.id === revokedCreated.client_id)?.notes, '初始')
    assert.equal(otherAfterRevoke.find(row => row.id === other.id)?.notes, '保持')
  } finally {
    await core.close(); await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end()
  }
})
