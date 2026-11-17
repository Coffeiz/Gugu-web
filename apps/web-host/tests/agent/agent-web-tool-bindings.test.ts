import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createCoreAgentConversationSearchPort } from '../../src/domains/agent-sessions/tools/agent-conversations.js'
import { createWebAgentToolPorts } from '../../src/domains/agent-sessions/agent-web-reconstructor.js'

const lease = {
  identity: { ownerId: 'owner-a', sessionId: '12', runId: 'run-a' },
} as const
const preparationIdentity = { ownerId: 'owner-a', subject: { kind: 'session' as const, id: '12' }, workspaceId: null }

test('Web Run 从同一授权 registry 发现并分派 RAG 工具', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-web-run-tools-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    runtime = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '12', runId: 'run-a' }
    const runLease = { identity }
    const identityForPreparation = { ...preparationIdentity, ownerId: identity.ownerId }
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): { values(row: Record<string, unknown>): { execute(): Promise<unknown> } }
    }
    await fixtureDb.insertInto('conversation_sessions').values({
      id: 41, user_id: identity.ownerId.replaceAll('-', ''), title: '部署复盘', title_locked: 0,
      summary: '上次发布', source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T03:04:00Z',
    }).execute()
    await fixtureDb.insertInto('conversation_messages').values({
      session_id: 41, conversation_seq: 1, role: 'user', content: '请查找上次部署复盘。', created_at: '2026-01-02T03:00:00Z',
    }).execute()

    let authorizedIdentity: unknown
    let searchCalls = 0
    let authorized = true
    const conversationPort = createCoreAgentConversationSearchPort(runtime)
    const actualRegistry = createAgentToolRegistry({
      core: runtime,
      conversationSearch: {
        recent: (...args) => conversationPort.recent(...args),
        async search(...args) { searchCalls++; return conversationPort.search(...args) },
        resolve: (...args) => conversationPort.resolve(...args),
      },
      authorize: async current => {
        authorizedIdentity = current
        return authorized && current.ownerId === identity.ownerId && current.sessionId === identity.sessionId
          && current.runId === identity.runId
      },
    })
    const ports = createWebAgentToolPorts(runLease, actualRegistry, {
      configuration: async current => ({ identity: {
        ownerId: current.ownerId,
        subject: { kind: 'session', id: current.sessionId },
        workspaceId: null,
      }, source: 'web', toolNames: ['search_conversations'] }),
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

    assert.notEqual(ports.tools, actualRegistry.tools)
    assert.equal(typeof ports.tools.dispatch, 'function')
    const definitions = await ports.preparation.discover({ identity: identityForPreparation, toolNames: ['search_conversations', 'read_knowledge'] }, new AbortController().signal)
    assert.deepEqual(definitions.map(definition => definition.name), ['search_conversations'])
    const result = await ports.tools.dispatch({ id: 'search', name: 'search_conversations', input: { query: '部署复盘' } }, {
      identity,
      roundId: 'round-1',
      signal: new AbortController().signal,
      resolution: null,
      execute: async () => { throw new Error('只读 RAG 工具不应调用 Executor') },
    })
    assert.equal(result.kind === 'completed' && result.successful, true)
    assert.deepEqual(result.kind === 'completed' ? (result.value as { matches: Array<{ session_id: number }> }).matches.map(match => match.session_id) : [], [41])
    assert.equal(searchCalls, 1)
    assert.deepEqual(authorizedIdentity, identity)

    authorized = false
    const deniedDefinitions = await ports.preparation.discover({ identity: identityForPreparation, toolNames: ['search_conversations'] }, new AbortController().signal)
    assert.deepEqual(deniedDefinitions, [])
    const deniedCall = await ports.tools.dispatch({ id: 'denied-search', name: 'search_conversations', input: { query: '部署复盘' } }, {
      identity, roundId: 'round-2', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('只读 RAG 工具不应调用 Executor') },
    })
    assert.equal(deniedCall.kind === 'completed' && deniedCall.successful, false)
    assert.equal(searchCalls, 1)

    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled'))
    await assert.rejects(ports.preparation.discover({ identity: identityForPreparation, toolNames: ['search_conversations'] }, cancelled.signal))
    assert.equal(searchCalls, 1)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web Run 拒绝与持久 lease 不一致的 owner 或 session 工具发现', async () => {
  const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, authorize: async () => true })
  const ports = createWebAgentToolPorts(lease, registry, {
    configuration: async identity => ({ identity: {
      ownerId: identity.ownerId,
      subject: { kind: 'session', id: identity.sessionId },
      workspaceId: null,
    }, source: 'web', toolNames: [] }),
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
  await assert.rejects(ports.preparation.discover({
    identity: { ...preparationIdentity, subject: { kind: 'session', id: '13' } }, toolNames: [],
  }, new AbortController().signal), /身份不匹配/u)
})

test('Web Run 用同一 owner-scoped MCP 目录发现工具并把调用交给 Host MCP runtime', async () => {
  const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, authorize: async () => true })
  const calls: unknown[][] = []
  const ports = createWebAgentToolPorts(lease, registry, {
    configuration: async identity => ({ identity: {
      ownerId: identity.ownerId,
      subject: { kind: 'session', id: identity.sessionId },
      workspaceId: null,
    }, source: 'web', toolNames: ['mcp_gaode_lookup'] }),
    capabilities: {
      workspaceSupported: false,
      filterConfigured: async names => names,
      shellPolicy: async () => ({ allowed: false, needsConfirmation: false }),
      shellState: async () => null,
      appendShellProtocol: value => value,
      catalog: async () => null,
    },
    formatPrefix: () => [],
  }, {
    directory: async owner => owner === lease.identity.ownerId ? [{
      name: 'mcp_gaode_lookup', description: '地点查询', description_short: '地点查询',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      server_id: 'server-a', server_name: '高德', tool_name: 'lookup',
    }] : [],
    runtime: { async dispatchForAgent(...args: unknown[]) { calls.push(args); return { result: '杭州西湖' } } },
    authorize: async identity => identity.ownerId === lease.identity.ownerId && identity.runId === lease.identity.runId,
  })

  const definitions = await ports.preparation.discover({
    identity: { ...preparationIdentity }, toolNames: ['mcp_gaode_lookup'],
  }, new AbortController().signal)
  assert.deepEqual(definitions.map(item => item.name), ['mcp_gaode_lookup'])
  const signal = new AbortController().signal
  const dispatched = await ports.tools.dispatch({ id: 'mcp-call', name: 'mcp_gaode_lookup', input: { query: '杭州' } }, {
    identity: lease.identity, roundId: 'round-1', signal, resolution: null,
    execute: async () => { throw new Error('MCP 调用不应进入本机 Executor') },
  })
  assert.deepEqual(dispatched, { kind: 'completed', value: { result: '杭州西湖' }, successful: true, mutated: true, executed: true })
  assert.deepEqual(calls, [[lease.identity.ownerId, 'server-a', 'mcp_gaode_lookup', { query: '杭州' }, signal]])
})
