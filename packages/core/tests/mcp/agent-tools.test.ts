import { describe, expect, it } from 'vitest'
import { createMcpAgentToolPorts } from '../../src/mcp/agent-tools.js'

describe('共享 MCP ToolPort', () => {
it('暴露 owner 工具并将外呼不确定状态保留为 unknown', async () => {
  const identity = { ownerId: 'owner-a', sessionId: 'session-a', runId: 'run-a' }
  let calls = 0
  let baseDispatches = 0
  const ports = createMcpAgentToolPorts({
    base: {
      async capabilities() { return [] },
      tools: {
        async plan() { return { mode: 'parallel' as const, maxConcurrency: 1 } },
        async dispatch() { baseDispatches++; return { kind: 'completed' as const, value: null, successful: true, mutated: false } },
        async reconcile() { return { kind: 'unknown' as const } },
      },
    },
    async directory(owner) {
      expect(owner).toBe('owner-a')
      return [{ name: 'mcp_places_lookup', description_short: '查地点', description: '查询地点',
        input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        server_id: 'server-a', server_name: 'places', tool_name: 'lookup' }]
    },
    runtime: { async dispatchForAgent(owner, server, name, args) {
      calls++
      expect([owner, server, name, args]).toEqual(['owner-a', 'server-a', 'mcp_places_lookup', { query: 'nearby' }])
      return { uncertain: true }
    } },
    async authorize(candidate, name) { return candidate.ownerId === 'owner-a' && name === 'mcp_places_lookup' },
  })
  const definitions = await ports.capabilities(identity)
  expect(definitions.map(tool => tool.name)).toEqual(['mcp_places_lookup'])
  const result = await ports.tools.dispatch({ id: 'call-a', name: 'mcp_places_lookup', input: { query: 'nearby' } }, {
    identity, roundId: 'round-a', signal: new AbortController().signal,
    async execute() { throw new Error('MCP 不应绕过专用 runtime') }, resolution: null,
  })
  expect(result).toEqual({ kind: 'unknown' })
  expect(await ports.tools.reconcile({ id: 'call-a', name: 'mcp_places_lookup', input: { query: 'nearby' } },
    { ...identity, roundId: 'round-a' })).toEqual({ kind: 'unknown' })
  expect(calls).toBe(1)
  expect(baseDispatches).toBe(0)
})
})
