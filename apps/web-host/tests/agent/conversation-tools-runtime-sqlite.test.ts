import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createCoreAgentConversationSearchPort } from '../../src/domains/agent-sessions/tools/agent-conversations.js'
import { createIndexedAgentConversationSearchPort } from '../../src/domains/agent-sessions/tools/agent-conversations.js'
import { createConversationRagSource } from '../../../../packages/core/src/agent/rag/conversation-index-source.js'
import { createSqlRagPersistentIndexWriter } from '../../../../packages/core/src/agent/rag/persistent-writer.js'
import { createOwnerAgentRagVectorResolver } from '../../src/domains/agent-sessions/tools/agent-rag-vectors.js'
import { createAgentRuntime } from '../../src/domains/agent-sessions/agent-runtime.js'
import { agentContextAccessScope } from '../../src/domains/agent-config/access-scope.js'
import { bindProviderSelection } from '../../src/domains/agent-config/provider-resolver.js'
import { createCanonicalSourceLoader, stableJson } from '@gugu/core/agent'
import type { AgentRunnerPorts, CanonicalContextPorts, CanonicalRunContext, RunCheckpoint, RunEvent } from '@gugu/core/agent'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
type RuntimePorts = Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>

test('search_conversations 经 Host 适配器和真实工具分派查询 owner 限定的会话事实表', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-conversation-search-'))
  const path = join(folder, 'core.db')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId
    // 会话表由 Host Agent schema 管理，Core Data 的业务表型不包含它们；只在 fixture 侧声明实际插入列。
    // 正式 SQLite runtime 只允许本地 owner；跨 owner 记录由隔离 PostgreSQL 用例覆盖，本用例验证工具输入不能伪造 owner。
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(rows: Record<string, unknown> | Record<string, unknown>[]): { execute(): Promise<unknown> }
      }
    }
    await fixtureDb.insertInto('conversation_sessions').values([
      { id: 1, user_id: owner.replaceAll('-', ''), title: '部署讨论', title_locked: 0, summary: '发布窗口', source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 10, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T03:04:00Z' },
      { id: 2, user_id: owner.replaceAll('-', ''), title: '群聊排除', title_locked: 0, summary: '群聊命中不得进入个人搜索', source: 'im', chat_type: 'group', context_epoch: 0, baseline_message_seq: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T03:04:00Z' },
    ]).execute()
    await fixtureDb.insertInto('conversation_messages').values([
      { session_id: 1, conversation_seq: 1, role: 'user', content: '请准备周五部署发布。', created_at: '2026-01-02T03:00:00Z' },
      { session_id: 2, conversation_seq: 1, role: 'user', content: '群里的部署凭据。', created_at: '2026-01-03T03:00:00Z' },
      { session_id: 1, conversation_seq: 2, role: 'user', content: '历史 literal 100%_完成。', created_at: '2026-01-02T04:00:00Z' },
      { session_id: 1, conversation_seq: 3, role: 'tool', content: '工具正文 100%_完成 不得命中。', created_at: '2026-01-02T05:00:00Z' },
    ]).execute()

    // 工具调用使用与生产 Host 相同的 1.7.7 Jieba 词典和 HMM=false 配置。
    const conversationSearch = createCoreAgentConversationSearchPort(runtime)
    let authorized = true
    const registry = createAgentToolRegistry({ core: runtime, conversationSearch, authorize: async () => authorized })
    const identity = { ownerId: owner, sessionId: '90', runId: 'synthetic-run' }
    const scope = {
      identity,
      roundId: '1',
      signal: new AbortController().signal,
      resolution: null,
      execute: async () => { throw new Error('只读工具不得调用执行后端') },
    }

    const result = await registry.tools.dispatch({ id: 'search-1', name: 'search_conversations', input: { query: '部署', owner_id: randomUUID() } }, scope)
    assert.equal(result.kind, 'completed')
    assert.equal(result.kind === 'completed' && result.successful, true)
    assert.deepEqual(result.kind === 'completed' ? (result.value as { matches: Array<{ session_id: number; match: { snippet: string } }> }).matches.map(row => ({ session_id: row.session_id, snippet: row.match.snippet })) : [], [
      { session_id: 1, snippet: '部署讨论\n发布窗口\n请准备周五部署发布。' },
    ])
    const andResult = await registry.tools.dispatch({ id: 'and-1', name: 'search_conversations', input: { queries: ['部署', '发布'], mode: 'AND' } }, scope)
    assert.equal(andResult.kind === 'completed' && andResult.successful, true)
    assert.deepEqual(andResult.kind === 'completed' ? (andResult.value as { matches: Array<{ session_id: number }> }).matches.map(row => row.session_id) : [], [1])
    const noMatch = await registry.tools.dispatch({ id: 'and-2', name: 'search_conversations', input: { queries: ['部署', '不存在'], mode: 'AND' } }, scope)
    assert.equal(noMatch.kind === 'completed' && noMatch.successful, true)
    assert.deepEqual(noMatch.kind === 'completed' ? (noMatch.value as { matches: unknown[] }).matches : [], [])

    // Python 基准允许搜索被 baseline 压缩前仍保留的历史，并把 SQL LIKE 元字符视作字面词。
    const literalHistory = await registry.tools.dispatch({ id: 'literal-1', name: 'search_conversations', input: { queries: ['100%_完成'] } }, scope)
    assert.equal(literalHistory.kind === 'completed' && literalHistory.successful, true)
    assert.deepEqual(literalHistory.kind === 'completed' ? (literalHistory.value as { matches: Array<{ session_id: number; match: { snippet: string } }> }).matches.map(row => ({ session_id: row.session_id, snippet: row.match.snippet })) : [], [
      { session_id: 1, snippet: '部署讨论\n发布窗口\n历史 literal 100%_完成。' },
    ])
    authorized = false
    const denied = await registry.tools.dispatch({ id: 'denied-1', name: 'search_conversations', input: { query: '部署' } }, scope)
    assert.equal(denied.kind === 'completed' && denied.successful, false)
    assert.doesNotMatch(JSON.stringify(denied), /部署讨论|请准备周五/)
    authorized = true

    const recent = await registry.tools.dispatch({ id: 'recent-1', name: 'search_conversations', input: {} }, scope)
    assert.equal(recent.kind, 'completed')
    assert.deepEqual(recent.kind === 'completed' ? (recent.value as { recent: Array<{ session_id: number }> }).recent.map(row => row.session_id) : [], [2, 1])
    const invalid = await registry.tools.dispatch({ id: 'invalid-1', name: 'search_conversations', input: { query: '部署', queries: ['发布'] } }, scope)
    assert.equal(invalid.kind === 'completed' && invalid.successful, false)
  } finally {
    await runtime?.close()
    await rm(folder, { recursive: true, force: true })
  }
})

test('search_conversations 经真实注册器调用持久 TS RAG、正式 Jieba 并保持 Python BM25 语义', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-conversation-rag-'))
  const path = join(folder, 'core.db')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId
    const ownerKey = owner.replaceAll('-', '')
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(rows: Record<string, unknown> | Record<string, unknown>[]): { execute(): Promise<unknown> }
      }
    }
    await fixtureDb.insertInto('conversation_sessions').values([
      { id: 31, user_id: ownerKey, title: '部署回顾', title_locked: 0, summary: '发布排期', source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T03:04:00Z' },
      { id: 32, user_id: ownerKey, title: '群聊隔离', title_locked: 0, summary: '不得泄漏的部署', source: 'im', bot_id: 'synthetic-bot', chat_id: 'synthetic-group', chat_type: 'group', context_epoch: 0, baseline_message_seq: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T03:04:00Z' },
      { id: 33, user_id: ownerKey, title: '群聊缺少范围', title_locked: 0, summary: '无法授权的部署', source: 'im', chat_type: 'group', context_epoch: 0, baseline_message_seq: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-04T03:04:00Z' },
    ]).execute()
    await fixtureDb.insertInto('conversation_messages').values([
      { session_id: 31, conversation_seq: 1, role: 'user', content: 'baseline 之前的部署消息不应被排除。', created_at: '2026-01-02T02:00:00Z' },
      { session_id: 31, conversation_seq: 2, role: 'user', content: '请安排合成部署与发布回归。', created_at: '2026-01-02T03:00:00Z' },
      { session_id: 32, conversation_seq: 1, role: 'user', content: '群聊部署内容不得进入 owner 搜索。', created_at: '2026-01-03T03:00:00Z' },
      { session_id: 33, conversation_seq: 1, role: 'user', content: '没有可信群范围的部署内容也不得进入 owner 搜索。', created_at: '2026-01-04T03:00:00Z' },
      { session_id: 31, conversation_seq: 3, role: 'tool', content: '工具部署结果不能被索引。', created_at: '2026-01-02T04:00:00Z' },
    ]).execute()

    const documents = await createConversationRagSource(runtime.db, runtime.backend)(owner, null)
    await createSqlRagPersistentIndexWriter(runtime.db, runtime.backend).replaceSource(owner, 'conversation', documents)
    const conversationSearch = createIndexedAgentConversationSearchPort(runtime)
    const registry = createAgentToolRegistry({ core: runtime, conversationSearch, authorize: async () => true })
    const scope = {
      identity: { ownerId: owner, sessionId: '91', runId: 'synthetic-rag-run' }, roundId: '1',
      signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('只读工具不得调用执行后端') },
    }
    const result = await registry.tools.dispatch({ id: 'indexed-search', name: 'search_conversations', input: { query: '部署', owner_id: randomUUID() } }, scope)
    assert.equal(result.kind === 'completed' && result.successful, true)
    assert.deepEqual(result.kind === 'completed' ? (result.value as { matches: Array<{ session_id: number; match: { snippet: string } }> }).matches.map(row => ({ session_id: row.session_id, snippet: row.match.snippet })) : [], [
      { session_id: 31, snippet: '部署回顾\n发布排期\nuser：请安排合成部署与发布回归。' },
    ])
    const deniedRegistry = createAgentToolRegistry({ core: runtime, conversationSearch, authorize: async () => false })
    const denied = await deniedRegistry.tools.dispatch({ id: 'denied-indexed-search', name: 'search_conversations', input: { query: '部署' } }, scope)
    assert.equal(denied.kind === 'completed' && denied.successful, false)
    assert.doesNotMatch(JSON.stringify(denied), /部署回顾|发布排期/u)
  } finally {
    await runtime?.close()
    await rm(folder, { recursive: true, force: true })
  }
})

test('search_conversations 保留 Python 的 20 条 RAG 候选上限后再按会话去重', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-conversation-rag-limit-'))
  const path = join(folder, 'core.db')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(rows: Record<string, unknown> | Record<string, unknown>[]): { execute(): Promise<unknown> }
      }
    }
    await fixtureDb.insertInto('conversation_sessions').values([
      { id: 51, user_id: owner.replaceAll('-', ''), title: '重复命中会话', title_locked: 0, summary: '', source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T03:04:00Z' },
      { id: 52, user_id: owner.replaceAll('-', ''), title: '第二个会话', title_locked: 0, summary: '', source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T03:05:00Z' },
    ]).execute()
    await fixtureDb.insertInto('conversation_messages').values([
      ...Array.from({ length: 20 }, (_, index) => ({ session_id: 51, conversation_seq: index + 1, role: 'user', content: `候选窗口词 记录 ${index + 1}`, created_at: `2026-01-02T03:${String(index).padStart(2, '0')}:00Z` })),
      { session_id: 52, conversation_seq: 1, role: 'user', content: '候选窗口词 第二会话', created_at: '2026-01-02T04:00:00Z' },
    ]).execute()
    const documents = await createConversationRagSource(runtime.db, runtime.backend)(owner, null)
    await createSqlRagPersistentIndexWriter(runtime.db, runtime.backend).replaceSource(owner, 'conversation', documents)
    const registry = createAgentToolRegistry({ core: runtime, conversationSearch: createIndexedAgentConversationSearchPort(runtime), authorize: async () => true })
    const scope = { identity: { ownerId: owner, sessionId: '93', runId: 'synthetic-limit-run' }, roundId: '1',
      signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('只读工具不得调用执行后端') } }
    const result = await registry.tools.dispatch({ id: 'limit-search', name: 'search_conversations', input: { query: '候选窗口词' } }, scope)
    assert.equal(result.kind === 'completed' && result.successful, true)
    assert.deepEqual(result.kind === 'completed' ? (result.value as { matches: Array<{ session_id: number }> }).matches.map(row => row.session_id) : [], [51])
  } finally {
    await runtime?.close()
    await rm(folder, { recursive: true, force: true })
  }
})

test('AgentRuntime 经 Core Runner 将 search_conversations 结果送入 Provider 续轮', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-conversation-run-'))
  const path = join(folder, 'core.db')
  let runtimeDb: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  let instance: ReturnType<typeof createAgentRuntime> | undefined
  let providerBinding: Awaited<ReturnType<typeof bindProviderSelection>> | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtimeDb = opened.runtime
    const ownerId = opened.ownerId
    const ownerKey = ownerId.replaceAll('-', '')
    const tables = runtimeDb.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(rows: Record<string, unknown> | Record<string, unknown>[]): { execute(): Promise<unknown> }
      }
    }
    await tables.insertInto('conversation_sessions').values({
      id: 41, user_id: ownerKey, title: '合成发布复盘', title_locked: 0, summary: '周五上线', source: 'web',
      chat_type: null, context_epoch: 0, baseline_message_seq: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T03:04:00Z',
    }).execute()
    await tables.insertInto('conversation_messages').values({
      session_id: 41, conversation_seq: 1, role: 'user', content: '请查找上次部署复盘。', created_at: '2026-01-02T03:00:00Z',
    }).execute()
    // 生产 Python search_conversations 先从 owner 会话事实表生成候选，再走统一 ranker；
    // Runner 续轮应覆盖这条 Core SQL RAG 路径。持久索引路径由上面的独立用例覆盖。
    const conversationSearch = createCoreAgentConversationSearchPort(runtimeDb)
    const registry = createAgentToolRegistry({
      core: runtimeDb,
      conversationSearch,
      authorize: async (identity, name) => identity.ownerId === ownerId && name === 'search_conversations',
    })
    const identity = { ownerId, sessionId: '92', runId: randomUUID() }
    const policy = { groupChat: false, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
    const access = agentContextAccessScope('synthetic-conversation-run-secret', identity, policy,
      { permissions: '1', model: '1', credentials: '1' }, digest, 'owner')
    providerBinding = await bindProviderSelection(identity, {
      selectPlatformModel: async () => ({ config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '合成系统',
        byokEnabled: false, localDeployment: false, accessScopeHash: access.accessScopeHash }),
      readActiveCredential: async () => null,
      decryptCredential: () => { throw new Error('合成运行不得读取凭据') },
      defaultBaseUrl: () => '',
    }, new AbortController().signal)
    const source = createCanonicalSourceLoader({
      digest, nextId: randomUUID, now: () => 0,
      readSnapshot: async () => ({ ...identity, contextEpoch: 0, context: null, snapshotHash: null,
        sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }),
      select: async () => ({ ...policy, modelIdentity: providerBinding!.modelIdentity, contextWindow: 10000,
        locale: 'zh-CN', workspaceBinding: null, contextScopeKey: access.contextScopeKey }),
      currentRevision: async () => 0,
      historyReader: { read: async () => ({ baselineSeq: 0, rows: [] }) },
      currentTurn: async () => ({ currentUser: { persistedMessageId: '1', message: { role: 'user', content: '请查找上次部署复盘。' } } }),
      data: { loadTimezone: async () => 'UTC', loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [],
        loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}),
        loadMemory: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => [] },
      builder: { buildSnapshot: () => ({ systemPrompt: '系统', snapshotContext: '合成快照', sessionInfo: {}, userTimezone: 'UTC' }),
        buildRequest: () => ({ systemPrompt: '系统', systemInMessages: false, fixedPrefix: [] }) },
    })
    const context: CanonicalContextPorts = {
      digest, nextId: randomUUID,
      load: async (id, signal) => {
        const tools = await registry.capabilities(id)
        return { ...await source.load(id, signal), capabilities: { toolNames: tools.map(tool => tool.name), tools } }
      },
      preparation: { buildRag: async () => ({ tail: [] }) },
      prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
      references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
      compaction: { summarize: async () => { throw new Error('该回归不应压缩') } },
      finalization: { complete: async () => {} }, currentRequest: () => null,
      stageContinuation: async () => { throw new Error('该回归不应续接 Provider 私有状态') },
      releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
    }
    let checkpoint: RunCheckpoint<CanonicalRunContext> | null = null
    const outbox: RunEvent[] = [], requests: Array<Record<string, unknown>> = [], delivered: unknown[] = []
    const runPorts: RuntimePorts = {
      clock: { now: () => '2026-01-01T20:00:00Z' },
      store: {
        read: async () => checkpoint,
        create: async (value, _lease, events) => { checkpoint = structuredClone(value); outbox.push(...events) },
        commit: async change => {
          assert.equal(checkpoint?.version, change.expectedVersion)
          checkpoint = structuredClone(change.checkpoint)
          outbox.push(...change.events)
        },
        pendingEvents: async () => outbox,
        acknowledgeEvents: async () => {},
      },
      leases: { acquire: async () => ({ token: 'synthetic-lease', fence: 1 }), assert: async () => {}, release: async () => {} },
      cancellation: { isRequested: async () => false, request: async () => {}, notify: async () => {}, subscribe: async () => () => {} },
      tools: registry.tools,
      interactions: { activate: async (_id, request) => request },
      sanitizeText: stripThinking,
      createStreamSanitizer: () => new ProviderStreamSanitizer(),
      presentError: () => ({ code: 'failed', text: '合成 Agent 运行失败' }),
      presentToolResult: async value => value,
      publish: async () => {}, diagnose: () => {},
    }
    instance = createAgentRuntime({
      context,
      runtime: runPorts,
      executor: { authorize: async () => { throw new Error('只读检索不得授权执行器') }, executor: { execute: async () => { throw new Error('只读检索不得执行命令') } } },
      provider: {
        resolve: providerBinding.resolve,
        transport: { request: async request => {
          requests.push(request.body as Record<string, unknown>)
          if (requests.length === 1) {
            const definitions = (request.body as { tools: Array<{ function: { name: string } }> }).tools
            assert.ok(definitions.some(tool => tool.function.name === 'search_conversations'))
            return response({ tool_calls: [{ index: 0, id: 'history-search', type: 'function',
              function: { name: 'search_conversations', arguments: JSON.stringify({ query: '部署复盘' }) } }] }, 'tool_calls')
          }
          assert.equal(requests.length, 2)
          const messages = (request.body as { messages: Array<{ role: string; tool_call_id?: string; content?: unknown }> }).messages
          const toolMessage = messages.find(message => message.role === 'tool' && message.tool_call_id === 'history-search')
          assert.ok(toolMessage)
          let content = toolMessage.content
          if (typeof content !== 'string' && Array.isArray(content)) content = (content[0] as { text?: unknown }).text
          assert.equal(typeof content, 'string')
          const payload = JSON.parse(content as string) as { note: string; matches: Array<{ session_id: number; title: string; summary: string; source: string; updated_at: string; match: { role: string; snippet: string } }> }
          delivered.push(payload)
          return response({ content: '已找到上次部署复盘。' }, 'stop')
        } },
      },
    })
    const events: RunEvent[] = []
    for await (const event of instance.harness.start(identity)) events.push(event)
    assert.equal(requests.length, 2)
    assert.equal(events.at(-1)?.payload.status, 'completed')
    assert.deepEqual(delivered, [{ note: '用 read_conversation(session_id) 看某条对话的完整内容', matches: [{
      session_id: 41, title: '合成发布复盘', summary: '周五上线', source: 'web', updated_at: '2026-01-02 03:04',
      match: { role: '你', snippet: '合成发布复盘\n周五上线\n请查找上次部署复盘。' },
    }] }])
    assert.ok(outbox.some(event => event.type === 'tool_done' && event.payload.toolCallId === 'history-search'))
  } finally {
    await instance?.close()
    providerBinding?.release()
    await runtimeDb?.close()
    await rm(folder, { recursive: true, force: true })
  }
})

function response(delta: Record<string, unknown>, finish: string) {
  return { status: 200, headers: {}, body: (async function* () {
    yield new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
  })(), cancel: async () => {} }
}
