import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWebAgentMcpRunAuthorization } from '../../src/modules/agent/tools/mcp/authorize.js'
import { createMcpAgentToolPorts } from '../../src/modules/agent/tools/mcp/ports.js'
import { createWebAgentRagResources } from '../../src/modules/agent/run/reconstruct.js'

const lease = {
  identity: { ownerId: 'owner-a', sessionId: '12', runId: 'run-a' },
  token: 'lease-token', fence: 4,
  input: { v: 2 as const, source: 'web' as const, userMessageId: '33', locale: 'zh-CN', origin: null, accessVersion: 'access-v1' },
  mode: 'start' as const, cancelRequested: false,
}

test('MCP execution authorization requires the exact active Web dispatch lease', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  let active = true
  const authorization = createWebAgentMcpRunAuthorization({
    async query(sql: string, values: unknown[]) {
      queries.push({ sql, values })
      return { rowCount: active ? 1 : 0, rows: [] }
    },
  } as never, lease)

  assert.equal(await authorization.authorize(lease.identity, 'mcp_places_lookup'), true)
  assert.equal(await authorization.authorize({ ...lease.identity, ownerId: 'owner-b' }, 'mcp_places_lookup'), false)
  assert.equal(await authorization.authorize(lease.identity, 'list_projects'), false)
  active = false
  assert.equal(await authorization.authorize(lease.identity, 'mcp_places_lookup'), false)
  assert.equal(queries.length, 2)
  assert.deepEqual(queries[0]?.values, ['owner-a', '12', 'run-a', 'lease-token', 4])
  assert.match(queries[0]?.sql ?? '', /lease_expires_at\s*>\s*clock_timestamp\(\)/)
})

test('MCP execution authorization rejects non-Web dispatch payloads before querying', async () => {
  let calls = 0
  const invalid = { ...lease, input: { ...lease.input, source: 'telegram' as const } }
  assert.throws(() => createWebAgentMcpRunAuthorization({ async query() { calls++; return { rowCount: 1, rows: [] } } } as never, invalid as never), /MCP 运行来源无法验证/)
  assert.equal(calls, 0)
})

test('replaced MCP dispatch lease is denied before the runtime can call the remote server', async () => {
  let dispatched = 0
  const authorization = createWebAgentMcpRunAuthorization({
    async query() { return { rowCount: 0, rows: [] } },
  } as never, lease)
  const ports = createMcpAgentToolPorts({
    base: {
      async capabilities() { return [] },
      tools: { async dispatch() { throw new Error('不应调用') }, async reconcile() { return { kind: 'unknown' as const } } },
    } as never,
    async directory() {
      return [{ name: 'mcp_places_lookup', description: '查询地点', description_short: '查询地点',
        input_schema: { type: 'object' }, server_id: 'server-a', server_name: '地点', tool_name: 'lookup' }]
    },
    runtime: { async dispatchForAgent() { dispatched++; return { result: '不应返回' } } },
    authorize: authorization.authorize,
  })
  const result = await ports.tools.dispatch({ id: 'call-1', name: 'mcp_places_lookup', input: {} }, {
    identity: lease.identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('不应调用') },
  })
  assert.deepEqual(result, { kind: 'completed', value: { error: '没有权限使用此工具' }, successful: false, mutated: false, executed: false })
  assert.equal(dispatched, 0)
})

test('Web reconstruction resources recheck the PostgreSQL lease before delegating MCP authorization', async () => {
  let active = false, delegated = 0
  const pool = { async query() { return { rowCount: active ? 1 : 0, rows: [] } } }
  const resourcesForLease = createWebAgentRagResources({
    source: {
      pool: pool as never, files: { async read() { return null } }, memoryStorageRoot: '/tmp',
      redis: { async get() { return null } }, serverTimezone: 'UTC', now: () => 0,
      external: { async loadImChannels() { return {} }, async loadImMemory() { return {} }, async loadKnowledge() { return [] } },
      builder: { now: () => 0, staticPrompt: () => ({ base: '', persona: '', skills: '', policy: '', retrieval: '', skillIndex: '', timezone: 'UTC', now: new Date(0) }), sessionInfo: () => ({}), systemInMessages: () => false },
    },
    rag: { core: { db: {}, backend: 'postgres' } as never, pool: pool as never, storageRoot: '/tmp', enabled: () => true },
    compactionInstruction: '合成压缩指令',
    remaining: {
      context: {} as never, preparation: {} as never, runtime: {} as never, executor: {} as never, provider: {} as never,
      materialize: async () => ({} as never),
      mcp: {
        async directory() { return [] },
        runtime: { async dispatchForAgent() { return { result: '' } } },
        async authorize() { delegated++; return true },
      },
    } as never,
  })
  const resources = await resourcesForLease(lease, {
    selection: { modelIdentity: 'model-v1', contextWindow: 4096, locale: 'zh-CN', groupChat: false,
      workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion },
    async resolve() { throw new Error('本测试不解析 Provider') },
    usageConfig: { defaultLimit6h: null, byokEnabled: false, localDeployment: false, model: 'synthetic', provider: 'openai', isByok: false },
    release() {},
  } as never)

  assert.equal(await resources.mcp?.authorize(lease.identity, 'mcp_places_lookup'), false)
  assert.equal(delegated, 0)
  active = true
  assert.equal(await resources.mcp?.authorize(lease.identity, 'mcp_places_lookup'), true)
  assert.equal(delegated, 1)
})
