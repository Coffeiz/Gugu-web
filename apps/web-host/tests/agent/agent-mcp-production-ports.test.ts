import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebAgentMcpProductionPorts } from '../../src/domains/agent-sessions/tools/agent-mcp-production-ports.js'

test('Web MCP Host 端口按当前 Run owner 复核目录并透传真实 runtime', async () => {
  let current = [{ name: 'mcp_places_lookup', server_id: 'server-a', tool_name: 'lookup' }]
  const runtime = { async dispatchForAgent() { return { result: 'synthetic' } } }
  const ports = createWebAgentMcpProductionPorts({
    directory: async owner => { assert.equal(owner, 'owner-a'); return current as never },
    runtime,
  })
  const identity = { ownerId: 'owner-a', sessionId: 'session-a', runId: 'run-a' }
  assert.equal(await ports.authorize(identity, 'mcp_places_lookup'), true)
  current = []
  assert.equal(await ports.authorize(identity, 'mcp_places_lookup'), false)
  assert.equal(await ports.authorize(identity, 'places_lookup'), false)
  assert.equal(ports.runtime, runtime)
})

test('MCP 目录复核尊重取消信号且不放行未发现工具', async () => {
  const controller = new AbortController()
  const ports = createWebAgentMcpProductionPorts({
    directory: async () => [],
    runtime: { async dispatchForAgent() { return { result: 'unreachable' } } },
  })
  controller.abort()
  await assert.rejects(ports.authorize({ ownerId: 'owner-a', sessionId: 'session-a', runId: 'run-a' }, 'mcp_places_lookup', controller.signal), { name: 'AbortError' })
})
