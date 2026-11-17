import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createMcpAgentToolPorts } from '../../src/domains/agent-sessions/tools/agent-mcp-tool-ports.js'
import { createWebAgentRagToolPorts } from '../../src/domains/agent-sessions/tools/agent-rag-tool-ports.js'
import { createWebAgentProductionRagContextBuilder, createWebAgentProductionRagToolPorts, createWebAgentProductionRagRunPorts, createAuthorizedWebAgentProductionRagRunPorts } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import { createWebAgentProductionToolRegistry } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import { createWebAgentRagRunAuthorization } from '../../src/domains/agent-sessions/tools/agent-rag-run-authorization.js'
import { createWebAgentToolPorts } from '../../src/domains/agent-sessions/agent-web-reconstructor.js'
import { createWebAgentRagContextBuilder } from '../../src/domains/agent-sessions/tools/agent-rag-context.js'
import { createSqlRagPersistentIndexWriter } from '../../../../packages/core/src/agent/rag/persistent-writer.js'
import { buildRunRagContext } from '@gugu/core/agent'

test('Web RAG 组合端口经真实注册器同时接通 conversation 与 owner memory 搜索', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-ports-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const databasePath = join(directory, 'core.db')
    const storageRoot = join(directory, 'storage')
    await initializeSqlite(databasePath)
    const opened = await openSqliteRuntime(databasePath)
    runtime = opened.runtime
    const ownerId = opened.ownerId
    const ownerKey = ownerId.replaceAll('-', '')
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(rows: Record<string, unknown> | Record<string, unknown>[]): { execute(): Promise<unknown> }
      }
    }
    await fixtureDb.insertInto('conversation_sessions').values({ id: 71, user_id: ownerKey, title: '发布计划', title_locked: 0,
      summary: '周五版本发布', source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T03:04:00Z' }).execute()
    await fixtureDb.insertInto('conversation_messages').values({ session_id: 71, conversation_seq: 1, role: 'user',
      content: '周五完成部署复盘。', created_at: '2026-01-02T03:00:00Z' }).execute()

    const memoryDirectory = join(storageRoot, ownerId, '.agent', 'rag', 'memory')
    await mkdir(memoryDirectory, { recursive: true })
    await writeFile(join(memoryDirectory, 'index.json'), JSON.stringify({ schema_version: 1, documents: [
      { document_id: 'profile:0', parent_document_id: 'memory:profile', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '偏好', summary: '部署习惯', content: '发布前先检查回归测试',
        version: 'profile-v1', scope: { owner_user_id: ownerId, scope_type: 'owner', scope_id: '' }, metadata: {} },
      { document_id: 'foreign:0', parent_document_id: 'memory:foreign', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '其他用户', summary: '', content: '不应泄漏的发布安排',
        version: 'profile-v1', scope: { owner_user_id: '08a80873-5266-43b9-a27c-d288b602a9cb', scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] }), 'utf8')

    const ragPorts = createWebAgentRagToolPorts({ core: runtime, storageRoot,
      async authorizeMemory(identity, _signal, scopes) {
        return identity.ownerId === ownerId && scopes?.every(scope => scope.ownerId === ownerId) === true
      },
      async snapshot(identity) { assert.equal(identity.ownerId, ownerId); return { revision: 'snapshot-v1', text: '' } },
    })
    const registry = createAgentToolRegistry({ core: runtime, ...ragPorts,
      authorize: async (identity, name) => identity.ownerId === ownerId && ['search_conversations', 'search_memory'].includes(name) })
    const identity = { ownerId, sessionId: '71', runId: 'web-rag-test' }
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('RAG 只读工具不得调用执行后端') } }

    const definitions = await registry.capabilities(identity)
    assert.deepEqual(definitions.filter(item => ['search_conversations', 'search_memory'].includes(item.name)).map(item => item.name).sort(),
      ['search_conversations', 'search_memory'])

    const conversation = await registry.tools.dispatch({ id: 'conversation', name: 'search_conversations', input: { query: '部署' } }, scope)
    assert.equal(conversation.kind === 'completed' && conversation.successful, true)
    assert.match(JSON.stringify(conversation), /周五完成部署复盘/u)

    const memory = await registry.tools.dispatch({ id: 'memory', name: 'search_memory', input: { query: '发布' } }, scope)
    assert.equal(memory.kind === 'completed' && memory.successful, true, JSON.stringify(memory))
    assert.match(JSON.stringify(memory), /发布前先检查回归测试/u)
    assert.doesNotMatch(JSON.stringify(memory), /不应泄漏的发布安排/u)

    await writeFile(join(storageRoot, ownerId, '.agent', 'memory_vec.json'), JSON.stringify({
      'rag:memory:profile:profile-v1:0': { t: 'synthetic:embedding-v1:2', v: [1, 0] },
    }), 'utf8')
    let embeddingCalls = 0
    const vectorPorts = createWebAgentRagToolPorts({ core: runtime, storageRoot,
      authorizeMemory: async identity => identity.ownerId === ownerId,
      async snapshot() { return { revision: 'snapshot-v1', text: '' } },
      embedding: {
        async resolve(owner) {
          assert.equal(owner, ownerId)
          return { provider: 'synthetic', baseUrl: 'https://embedding.example/v1', model: 'embedding-v1',
            apiKey: 'synthetic-key', dimensions: 2 }
        },
        createTransport() {
          return { async request(request, signal) {
            signal.throwIfAborted()
            assert.equal(request.url, 'https://embedding.example/v1/embeddings')
            embeddingCalls += 1
            return { status: 200, headers: {}, body: (async function* () {
              yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
            })(), async cancel() {} }
          } }
        },
      },
    })
    const vectorRegistry = createAgentToolRegistry({ core: runtime, ...vectorPorts,
      authorize: async (identity, name) => identity.ownerId === ownerId && name === 'search_memory' })
    const vectorResult = await vectorRegistry.tools.dispatch({ id: 'vector-memory', name: 'search_memory', input: { query: '发布' } }, scope)
    assert.equal(vectorResult.kind === 'completed' && vectorResult.successful, true, JSON.stringify(vectorResult))
    assert.equal((vectorResult.kind === 'completed' ? (vectorResult.value as { strategy: string }).strategy : ''), 'hybrid')
    assert.match(JSON.stringify(vectorResult), /发布前先检查回归测试/u)
    assert.equal(embeddingCalls, 1)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web RAG Run 配置只公开只读工具并在每次授权时复验 PostgreSQL lease', async () => {
  const identity = { ownerId: 'owner-synthetic', sessionId: '41', runId: 'run-synthetic' }
  const lease = { identity, token: 'token-synthetic', fence: 7, input: { v: 2, source: 'web' }, mode: 'start', cancelRequested: false } as const
  let isActive = true
  const queries: unknown[][] = []
  const authorization = createWebAgentRagRunAuthorization({ async query(sql: string, values: unknown[]) {
    assert.match(sql, /d\.token=\$4 AND d\.fence=\$5/u)
    queries.push(values)
    return { rowCount: isActive ? 1 : 0, rows: [] }
  } } as never, lease)
  const signal = new AbortController().signal
  const configuration = await authorization.configuration(identity, signal)
  assert.deepEqual(configuration.identity, { ownerId: identity.ownerId, workspaceId: null,
    subject: { kind: 'session', id: identity.sessionId } })
  assert.deepEqual(configuration.toolNames, ['search_conversations', 'search_memory'])
  assert.equal(configuration.source, 'web')
  assert.equal(await authorization.authorize(identity, 'search_conversations', signal), true)
  assert.equal(await authorization.authorize(identity, 'delete_project', signal), false)
  assert.equal(await authorization.authorize({ ...identity, ownerId: 'other-owner' }, 'search_memory', signal), false)
  isActive = false
  assert.equal(await authorization.authorize(identity, 'search_memory', signal), false)
  await assert.rejects(authorization.configuration(identity, signal), /授权不可用/u)
  assert.deepEqual(queries, Array.from({ length: 4 }, () => [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence]))
})

test('生产 RAG 端口将 memory 检索绑定到当前 Web lease、已配置工具和持久快照', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-run-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const databasePath = join(directory, 'core.db'), storageRoot = join(directory, 'storage')
    await initializeSqlite(databasePath)
    const opened = await openSqliteRuntime(databasePath)
    runtime = opened.runtime
    const ownerId = opened.ownerId
    const ownerKey = ownerId.replaceAll('-', '')
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(row: Record<string, unknown>): { execute(): Promise<unknown> }
      }
    }
    const identity = { ownerId, sessionId: '31', runId: 'run-memory' }
    const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 4, locale: 'zh-CN' as const, origin: null, accessVersion: 'b'.repeat(64), v: 2 as const, source: 'web' as const } }
    await fixtureDb.insertInto('conversation_sessions').values({ id: 31, user_id: ownerKey, title: '合成会话', title_locked: 0,
      summary: '', source: 'web', chat_type: null, context_epoch: 2, baseline_message_seq: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }).execute()
    await fixtureDb.insertInto('conversation_messages').values({ session_id: 31, conversation_seq: 1, role: 'user',
      content: '生产注册器会话召回', created_at: '2026-01-01T00:00:00Z' }).execute()
    const row = { active_run_id: identity.runId, context_epoch: 2, session_context: {
      rag_revision: 'snapshot-r2', snapshot_context: '本轮已经注入的记忆内容' } }
    const pool = { async query(_sql: string, values?: unknown[]) {
      assert.deepEqual(values, [ownerId, identity.sessionId, identity.runId])
      if (_sql.includes('SELECT active_run_id FROM conversation_sessions'))
        return { rows: row.active_run_id === identity.runId ? [{ active_run_id: row.active_run_id }] : [] }
      return { rows: [row] }
    } }
    const preparation = { async configuration(input: typeof identity) {
      assert.deepEqual(input, identity)
      return { identity: { ownerId, subject: { kind: 'session' as const, id: identity.sessionId }, workspaceId: null }, source: 'web', toolNames: ['search_memory', 'search_conversations'] }
    } }
    const leaseBoundPorts = createWebAgentProductionRagToolPorts({
      core: runtime,
      pool: pool as never,
      storageRoot,
      lease,
      registry: { async capabilities() { return [{ name: 'search_memory' }] as never } },
      preparation,
    })
    await assert.rejects(leaseBoundPorts.conversationSearch.recent(
      { ...identity, ownerId: randomUUID() }, 5, new AbortController().signal,
    ), /运行身份不匹配/u)
    await mkdir(join(storageRoot, ownerId, '.agent'), { recursive: true })
    await writeFile(join(storageRoot, ownerId, '.agent', 'memory_vec.json'), JSON.stringify({
      'rag:memory:profile:profile-v1:1': { t: 'synthetic:embedding-v1:2', v: [1, 0] },
    }), 'utf8')
    let embeddingCalls = 0
    const registry = createWebAgentProductionToolRegistry({ core: runtime, pool: pool as never, storageRoot, lease,
      preparation,
      embedding: {
        async resolve(owner) {
          assert.equal(owner, ownerId)
          return { provider: 'synthetic', baseUrl: 'https://embedding.example/v1', model: 'embedding-v1', apiKey: 'synthetic-key', dimensions: 2 }
        },
        createTransport() {
          return { async request(request, signal) {
            signal.throwIfAborted()
            assert.equal(request.url, 'https://embedding.example/v1/embeddings')
            embeddingCalls++
            return { status: 200, headers: {}, body: (async function* () {
              yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
            })(), async cancel() {} }
          } }
        },
      },
      authorize: async (input, name) => input.ownerId === ownerId && ['search_memory', 'search_conversations'].includes(name) })

    const webRunTools = createWebAgentToolPorts(lease, registry, {
      configuration: preparation.configuration,
      capabilities: {
        workspaceSupported: false,
        filterConfigured: async names => names,
        shellPolicy: async () => ({ allowed: false, needsConfirmation: false }),
        shellState: async () => null,
        appendShellProtocol: value => value,
        catalog: async () => null,
      },
      formatPrefix: () => [],
    })

    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('memory 查询不得调用执行后端') } }
    const discovered = await webRunTools.preparation.discover({
      identity: { ownerId, subject: { kind: 'session', id: identity.sessionId }, workspaceId: null },
      toolNames: ['search_conversations', 'search_memory', 'read_knowledge'],
    }, scope.signal)
    assert.deepEqual(discovered.map(tool => tool.name).sort(), ['search_conversations', 'search_memory'])
    const composed = createMcpAgentToolPorts({
      base: registry,
      async directory(owner) {
        assert.equal(owner, ownerId)
        return [{ name: 'mcp_lookup', description: '查找合成地点', description_short: '查找地点',
          input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          server_id: 'server-synthetic', server_name: '测试服务', tool_name: 'lookup' }]
      },
      runtime: { async dispatchForAgent(owner, server, name, args, signal) {
        assert.equal(owner, ownerId)
        assert.equal(server, 'server-synthetic')
        assert.equal(name, 'mcp_lookup')
        assert.deepEqual(args, { query: '杭州' })
        assert.equal(signal, scope.signal)
        return { result: '合成地点结果' }
      } },
      authorize: async () => true,
    })

    const indexDirectory = join(storageRoot, ownerId, '.agent', 'rag', 'memory')
    await mkdir(indexDirectory, { recursive: true })
    await writeFile(join(indexDirectory, 'index.json'), JSON.stringify({ schema_version: 1, documents: [
      { document_id: 'profile:0', parent_document_id: 'memory:profile', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '偏好', summary: '', content: '本轮已经注入的记忆内容',
        version: 'profile-v1', scope: { owner_user_id: ownerId, scope_type: 'owner', scope_id: '' }, metadata: {} },
      { document_id: 'profile:1', parent_document_id: 'memory:profile', chunk_index: 1, chunk_count: 2,
        source_type: 'memory', source_id: 'profile', title: '偏好', summary: '', content: '尚未注入的另一条记忆',
        version: 'profile-v1', scope: { owner_user_id: ownerId, scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] }), 'utf8')

    const definitions = await composed.capabilities(identity)
    assert.ok(definitions.some(item => item.name === 'search_conversations'))
    assert.ok(definitions.some(item => item.name === 'mcp_lookup'))
    const conversationResult = await webRunTools.tools.dispatch({ id: 'conversation-run', name: 'search_conversations', input: { query: '会话召回' } }, scope)
    assert.equal(conversationResult.kind === 'completed' && conversationResult.successful, true, JSON.stringify(conversationResult))
    assert.match(JSON.stringify(conversationResult), /生产注册器会话召回/u)
    const mcpResult = await composed.tools.dispatch({ id: 'mcp-run', name: 'mcp_lookup', input: { query: '杭州' } }, scope)
    assert.deepEqual(mcpResult, { kind: 'completed', value: { result: '合成地点结果' }, successful: true, mutated: true, executed: true })
    const result = await registry.tools.dispatch({ id: 'memory-run', name: 'search_memory', input: { query: '记忆' } }, scope)
    assert.equal(result.kind === 'completed' && result.successful, true, JSON.stringify(result))
    assert.match(JSON.stringify(result), /尚未注入的另一条记忆/u)
    assert.doesNotMatch(JSON.stringify(result), /本轮已经注入的记忆内容/u)
    assert.equal(result.kind === 'completed' ? (result.value as { strategy: string }).strategy : '', 'hybrid')
    assert.equal(embeddingCalls, 1)

    row.active_run_id = 'superseded-run'
    const stale = await registry.tools.dispatch({ id: 'memory-stale', name: 'search_memory', input: { query: '记忆' } }, scope)
    assert.equal(stale.kind === 'completed' && stale.successful, false)

    row.active_run_id = identity.runId
    const noLongerConfigured = { ...preparation, async configuration(input: typeof identity) {
      const current = await preparation.configuration(input)
      return { ...current, toolNames: [] }
    } }
    const deniedRegistry = createWebAgentProductionToolRegistry({ core: runtime, pool: pool as never, storageRoot, lease,
      preparation: noLongerConfigured, authorize: async () => true })
    const deniedResult = await deniedRegistry.tools.dispatch({ id: 'memory-disabled', name: 'search_memory', input: { query: '记忆' } }, scope)
    assert.equal(deniedResult.kind === 'completed' && deniedResult.successful, false)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web 自动 RAG 从正式索引召回 owner 内容并排除历史已注入正文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-context-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    runtime = opened.runtime
    const ownerId = opened.ownerId
    const identity = { ownerId, sessionId: '81', runId: 'rag-context-run' }
    const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 5, locale: 'zh-CN' as const, origin: null, accessVersion: 'c'.repeat(64), v: 2 as const, source: 'web' as const } }
    const writer = createSqlRagPersistentIndexWriter(runtime.db, runtime.backend)
    await writer.replaceSource(ownerId, 'memory', [{
      id: 'memory:deployment:0', source_id: 'deployment', source_type: 'memory',
      scope_type: 'owner', scope_id: '', title: '部署复盘', summary: '版本上线检查',
      content: '发布前先完成部署回归和 owner 隔离检查。', text: '部署复盘\n发布前先完成部署回归和 owner 隔离检查。',
      parent_id: 'memory:deployment', document_version: 'v1', chunk_index: 0, chunk_count: 1,
      metadata: {},
    }])
    let authorized = 0
    const build = createWebAgentRagContextBuilder({
      core: runtime,
      lease,
      enabled: async () => true,
      async authorize(bound, scope) {
        authorized++
        return bound.identity.ownerId === ownerId && scope.scope_type === 'owner' && scope.scope_id === ''
      },
    })
    const input = {
      ownerId, sessionId: identity.sessionId, history: [], fixedPrefix: [], snapshotText: '',
      currentUser: { persistedMessageId: '5', rawText: '部署回归', message: { role: 'user' as const, content: '部署回归' } },
    }
    const preparation = { digest: () => 'digest', nextId: () => 'id', buildRag: build }
    const first = await buildRunRagContext(input, preparation, new AbortController().signal)
    assert.equal(first.injected, true)
    assert.match(JSON.stringify(first.tail), /发布前先完成部署回归/u)
    assert.equal(authorized, 3)
    await assert.rejects(buildRunRagContext({ ...input, ownerId: randomUUID() }, preparation, new AbortController().signal), /运行身份不匹配/u)
    await assert.rejects(buildRunRagContext({ ...input, sessionId: '82' }, preparation, new AbortController().signal), /运行身份不匹配/u)

    await mkdir(join(directory, 'rag-storage', ownerId, '.agent'), { recursive: true })
    await writeFile(join(directory, 'rag-storage', ownerId, '.agent', 'memory_vec.json'), JSON.stringify({
      'rag:memory:deployment:v1:0': { t: 'synthetic:embedding-v1:2', v: [1, 0] },
    }), 'utf8')
    let embeddingCalls = 0, activeScopeChecks = 0, leaseActive = true
    const activePool = { async query(_sql: string, values?: unknown[]) {
      activeScopeChecks++
      assert.deepEqual(values, [ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
      return { rowCount: leaseActive ? 1 : 0, rows: leaseActive ? [{}] : [] }
    } }
    const productionBuild = createWebAgentProductionRagContextBuilder({
      core: runtime,
      pool: activePool as never,
      storageRoot: join(directory, 'rag-storage'),
      lease,
      selection: { modelIdentity: 'synthetic-model', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: true, memoryEnabled: true } },
      enabled: () => true,
      embedding: {
        async resolve(boundOwner) {
          assert.equal(boundOwner, ownerId)
          return { provider: 'synthetic', baseUrl: 'https://embedding.example/v1', model: 'embedding-v1', apiKey: 'test-only', dimensions: 2 }
        },
        createTransport() {
          return { async request(_request, signal) {
            signal.throwIfAborted()
            embeddingCalls++
            return { status: 200, headers: {}, body: (async function* () {
              yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
            })(), async cancel() {} }
          } }
        },
      },
    })
    const vectorResult = await buildRunRagContext(input, { ...preparation, buildRag: productionBuild }, new AbortController().signal)
    assert.equal(vectorResult.injected, true)
    assert.match(JSON.stringify(vectorResult.tail), /发布前先完成部署回归/u)
    assert.equal(embeddingCalls, 1)
    assert.ok(activeScopeChecks > 0)

    const memoryContextDisabledBuild = createWebAgentProductionRagContextBuilder({
      core: runtime, pool: activePool as never, storageRoot: join(directory, 'rag-storage'), lease,
      selection: { modelIdentity: 'synthetic-model', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: true, memoryEnabled: false } }, enabled: () => true,
    })
    const memoryContextDisabled = await buildRunRagContext(input, { ...preparation, buildRag: memoryContextDisabledBuild }, new AbortController().signal)
    assert.equal(memoryContextDisabled.injected, true)

    leaseActive = false
    const expiredLeaseResult = await buildRunRagContext(input, { ...preparation, buildRag: productionBuild }, new AbortController().signal)
    assert.equal(expiredLeaseResult.injected, false)
    assert.equal(expiredLeaseResult.reason, 'no_eligible_scope')

    const block = (first.tail[0]!.content as import('@gugu/core/agent').Json[])[0]!
    const second = await buildRunRagContext({ ...input, history: [{
      ownerId, sessionId: identity.sessionId, id: '3', conversationSeq: 3, role: 'user', content: [],
      contentJson: [block],
    }] }, preparation, new AbortController().signal)
    assert.equal(second.injected, false)
    assert.deepEqual(second.tail, [])

    const denied = createWebAgentRagContextBuilder({ core: runtime, lease, enabled: () => true, async authorize() { return false } })
    assert.equal((await buildRunRagContext(input, { ...preparation, buildRag: denied }, new AbortController().signal)).reason, 'no_eligible_scope')

    const disabled = createWebAgentRagContextBuilder({ core: runtime, lease, enabled: () => false, async authorize() { assert.fail('关闭 RAG 后不得检查索引授权') } })
    assert.equal((await buildRunRagContext(input, { ...preparation, buildRag: disabled }, new AbortController().signal)).reason, 'disabled')

    let authorizeStarted!: () => void
    let resumeAuthorization!: () => void
    const authorizationStarted = new Promise<void>(resolve => { authorizeStarted = resolve })
    const authorizationGate = new Promise<void>(resolve => { resumeAuthorization = resolve })
    const cancellable = createWebAgentRagContextBuilder({
      core: runtime, lease, enabled: () => true,
      async authorize() {
        authorizeStarted()
        await authorizationGate
        return true
      },
    })
    const controller = new AbortController()
    const pending = buildRunRagContext(input, { ...preparation, buildRag: cancellable }, controller.signal)
    await authorizationStarted
    controller.abort()
    resumeAuthorization()
    await assert.rejects(pending, { name: 'AbortError' })
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('生产 Web RAG 在选中模型或 scope 版本不匹配时不创建授权端口', () => {
  const identity = { ownerId: 'owner-a', sessionId: '7', runId: 'scope-mismatch' }
  const lease = { identity, token: 'lease', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { userMessageId: 11, locale: 'zh-CN' as const, origin: null, accessVersion: 'a'.repeat(64), v: 2 as const, source: 'web' as const } }
  let queries = 0
  const pool = { async query() { queries++; return { rows: [], rowCount: 0 } } }
  const selection = { modelIdentity: 'synthetic-model', contextScopeKey: 'b'.repeat(64),
    contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
  assert.throws(() => createAuthorizedWebAgentProductionRagRunPorts({ core: {} as never, pool: pool as never,
    storageRoot: '/synthetic-root', lease, selection, enabled: () => true }), /配置版本与调度授权不匹配/u)
  assert.equal(queries, 0)
  assert.throws(() => createAuthorizedWebAgentProductionRagRunPorts({ core: {} as never, pool: pool as never,
    storageRoot: '/synthetic-root', lease, selection: { ...selection, contextScopeKey: lease.input.accessVersion, modelIdentity: '' }, enabled: () => true }), /配置版本与调度授权不匹配/u)
  assert.equal(queries, 0)
})

test('生产 Run RAG 组合让自动注入与检索工具共享 lease 和可信配置', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-run-ports-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    runtime = opened.runtime
    const ownerId = opened.ownerId, identity = { ownerId, sessionId: '91', runId: 'shared-rag-run' }
    const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 6, locale: 'zh-CN' as const, origin: null, accessVersion: 'd'.repeat(64), v: 2 as const, source: 'web' as const } }
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(row: Record<string, unknown>): { execute(): Promise<unknown> }
      }
    }
    await fixtureDb.insertInto('conversation_sessions').values({ id: 91, user_id: ownerId.replaceAll('-', ''), title: '共享 RAG', title_locked: 0,
      summary: '', source: 'web', chat_type: null, context_epoch: 3, baseline_message_seq: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }).execute()
    await fixtureDb.insertInto('conversation_messages').values({ session_id: 91, conversation_seq: 1, role: 'user',
      content: '共享 lease 会话检索', created_at: '2026-01-01T00:00:00Z' }).execute()
    const writer = createSqlRagPersistentIndexWriter(runtime.db, runtime.backend)
    await writer.replaceSource(ownerId, 'memory', [{ id: 'memory:profile:0', source_id: 'profile', source_type: 'memory',
      scope_type: 'owner', scope_id: '', title: '共享运行', summary: '', content: '共享授权记忆内容', text: '共享授权记忆内容',
      parent_id: 'memory:profile', document_version: 'profile-v1', chunk_index: 0, chunk_count: 1, metadata: {} }])
    const ownerIndex = join(directory, ownerId, '.agent', 'rag', 'memory')
    await mkdir(ownerIndex, { recursive: true })
    await writeFile(join(ownerIndex, 'index.json'), JSON.stringify({ schema_version: 1, documents: [
      { document_id: 'profile:0', parent_document_id: 'memory:profile', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '共享运行', summary: '', content: '共享授权记忆内容',
        version: 'profile-v1', scope: { owner_user_id: ownerId, scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] }), 'utf8')
    let active = true
    const pool = { async query(sql: string) {
      if (!active) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT active_run_id,context_epoch,session_context'))
        return { rows: [{ active_run_id: identity.runId, context_epoch: 3, session_context: { rag_revision: 'r3', snapshot_context: '' } }], rowCount: 1 }
      if (sql.includes('SELECT active_run_id FROM conversation_sessions'))
        return { rows: [{ active_run_id: identity.runId }], rowCount: 1 }
      return { rows: [{}], rowCount: 1 }
    } }
    const ports = createAuthorizedWebAgentProductionRagRunPorts({ core: runtime, pool: pool as never, storageRoot: directory,
      lease, selection: { modelIdentity: 'synthetic-model', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }, enabled: () => true })
    const definitions = await ports.toolRegistry.capabilities(identity)
    assert.ok(definitions.some(item => item.name === 'search_conversations'))
    assert.ok(definitions.some(item => item.name === 'search_memory'))
    const restricted = createAuthorizedWebAgentProductionRagRunPorts({ core: runtime, pool: pool as never, storageRoot: directory,
      lease, selection: { modelIdentity: 'synthetic-model', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: false, memoryEnabled: true } }, enabled: () => true })
    assert.deepEqual((await restricted.configuration(identity, new AbortController().signal)).toolNames, [])
    assert.deepEqual(await restricted.toolRegistry.capabilities(identity), [])
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('RAG 只读调用不能请求进程执行') } }
    const result = await ports.toolRegistry.tools.dispatch({ id: 'search-memory', name: 'search_memory', input: { query: '授权记忆' } }, scope)
    assert.equal(result.kind === 'completed' && result.successful, true, JSON.stringify(result))
    assert.match(JSON.stringify(result), /共享授权记忆内容/u)
    const automatic = await buildRunRagContext({ ownerId, sessionId: identity.sessionId, history: [], fixedPrefix: [], snapshotText: '',
      currentUser: { persistedMessageId: '6', rawText: '授权记忆', message: { role: 'user', content: '授权记忆' } } },
    { digest: () => 'digest', nextId: () => 'id', buildRag: ports.ragContext }, new AbortController().signal)
    assert.equal(automatic.injected, true)
    assert.match(JSON.stringify(automatic.tail), /共享授权记忆内容/u)
    active = false
    const stale = await ports.toolRegistry.tools.dispatch({ id: 'stale-memory', name: 'search_memory', input: { query: '授权记忆' } }, scope)
    assert.equal(stale.kind === 'completed' && stale.successful, false)
    const staleAutomatic = await buildRunRagContext({ ownerId, sessionId: identity.sessionId, history: [], fixedPrefix: [], snapshotText: '',
      currentUser: { persistedMessageId: '6', rawText: '授权记忆', message: { role: 'user', content: '授权记忆' } } },
    { digest: () => 'digest', nextId: () => 'id', buildRag: ports.ragContext }, new AbortController().signal)
    assert.equal(staleAutomatic.injected, false)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
