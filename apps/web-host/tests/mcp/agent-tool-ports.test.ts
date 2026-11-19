import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMcpAgentToolPorts } from '../../src/modules/agent-sessions/tools/agent-mcp-tool-ports.js'
import type { RunIdentity, ToolCall } from '@gugu/core/agent'

const identity: RunIdentity = { ownerId: 'owner-a', sessionId: '12', runId: 'run-a' }
const directory = async (owner: string) => owner === 'owner-a' ? [{
  name: 'mcp_gaode_lookup', description: '查找地点', description_short: '查找地点', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  server_id: 'server-a', server_name: '高德', tool_name: 'lookup',
}] : []
const call: ToolCall = { id: 'tool-1', name: 'mcp_gaode_lookup', input: { query: '杭州' } }
const scope = { identity, roundId: 'round-1', signal: new AbortController().signal, execute: async () => { throw new Error('不应调用本地 executor') }, resolution: null }

function fixture(overrides: Record<string, unknown> = {}) {
  const dispatched: unknown[] = []
  const base = {
    async capabilities() { return [{ name: 'list_projects', schema: { type: 'function', function: { name: 'list_projects', parameters: { type: 'object' } } } }] },
    tools: {
      async plan() { return { mode: 'parallel', maxConcurrency: 3, serialCallIds: [] } },
      async dispatch() { throw new Error('built-in call should be delegated') },
      async reconcile() { return { kind: 'unknown' as const } },
    },
  }
  const runtime = {
    async dispatchForAgent(...args: unknown[]) { dispatched.push(args); return { result: '杭州西湖' } },
  }
  const ports = createMcpAgentToolPorts({
    base: base as never,
    directory,
    runtime: runtime as never,
    authorize: async () => true,
    ...overrides,
  })
  return { ports, dispatched }
}

test('Agent schema discovery combines current owner MCP declarations with built-ins', async () => {
  const { ports } = fixture()
  const definitions = await ports.capabilities(identity)
  assert.deepEqual(definitions.map(item => item.name), ['list_projects', 'mcp_gaode_lookup'])
  assert.deepEqual(definitions[1]?.schema, { type: 'function', function: {
    name: 'mcp_gaode_lookup', description: '查找地点', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  } })
  assert.deepEqual(await ports.capabilities({ ...identity, ownerId: 'owner-b' }), definitions.slice(0, 1))
})

test('Agent dispatch binds MCP calls to the authenticated owner, discovered server and cancellation signal', async () => {
  const { ports, dispatched } = fixture()
  const result = await ports.tools.dispatch(call, scope)
  assert.deepEqual(result, { kind: 'completed', value: { result: '杭州西湖' }, successful: true, mutated: true, executed: true })
  assert.equal(dispatched.length, 1)
  assert.equal((dispatched[0] as unknown[])[0], identity.ownerId)
  assert.equal((dispatched[0] as unknown[])[1], 'server-a')
  assert.equal((dispatched[0] as unknown[])[2], 'mcp_gaode_lookup')
  assert.deepEqual((dispatched[0] as unknown[])[3], { query: '杭州' })
  assert.equal((dispatched[0] as unknown[])[4], scope.signal)
})

test('Agent discovery and dispatch recheck permission, and uncertain remote outcomes stay unknown', async () => {
  let calls = 0
  const denied = fixture({ authorize: async () => false })
  assert.deepEqual(await denied.ports.capabilities(identity), [{ name: 'list_projects', schema: { type: 'function', function: { name: 'list_projects', parameters: { type: 'object' } } } }])
  const deniedResult = await denied.ports.tools.dispatch(call, scope)
  assert.deepEqual(deniedResult, { kind: 'completed', value: { error: '没有权限使用此工具' }, successful: false, mutated: false, executed: false })
  assert.equal(denied.dispatched.length, 0)

  const uncertain = fixture({ runtime: { async dispatchForAgent() { calls += 1; return { uncertain: true } } } })
  assert.deepEqual(await uncertain.ports.tools.dispatch(call, scope), { kind: 'unknown' })
  assert.equal(calls, 1)
})

test('MCP 参数校验失败保留 Python 错误结果，但不得记为已执行或有副作用', async () => {
  const payload = JSON.stringify({ error: 'tool_input_invalid', issues: [{ path: 'query', rule: 'required' }] })
  const invalid = fixture({ runtime: { async dispatchForAgent() { return { result: payload, executed: false } } } })
  assert.deepEqual(await invalid.ports.tools.dispatch(call, scope), {
    kind: 'completed', value: { result: payload }, successful: false, mutated: false, executed: false,
  })
  assert.equal(invalid.dispatched.length, 0)
})

test('外呼前拒绝按未执行回执记录，MCP server 执行错误仍保守记录为已执行', async () => {
  const rejected = fixture({ runtime: { async dispatchForAgent() { return { error: 'MCP 工具不可用', executed: false } } } })
  assert.deepEqual(await rejected.ports.tools.dispatch(call, scope), {
    kind: 'completed', value: { error: 'MCP 工具不可用' }, successful: false, mutated: false, executed: false,
  })
  assert.equal(rejected.dispatched.length, 0)

  const remoteError = fixture({ runtime: { async dispatchForAgent() { return { error: '服务端执行失败', executed: true } } } })
  assert.deepEqual(await remoteError.ports.tools.dispatch(call, scope), {
    kind: 'completed', value: { error: '服务端执行失败' }, successful: false, mutated: true, executed: true,
  })
})

test('同轮包含 MCP 工具时串行执行，避免并发外部副作用', async () => {
  const { ports } = fixture()
  assert.deepEqual(await ports.tools.plan([call, { ...call, id: 'tool-2' }], identity), { mode: 'serial' })
})

