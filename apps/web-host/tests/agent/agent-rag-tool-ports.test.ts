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
import { createWebAgentProductionRagToolPorts } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import { createWebAgentProductionToolRegistry } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import { createWebAgentToolPorts } from '../../src/domains/agent-sessions/agent-web-reconstructor.js'

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
