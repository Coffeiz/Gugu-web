import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWebAgentToolPorts } from '../../src/modules/agent/run/reconstruct.js'
import type { RunIdentity } from '@gugu/core/agent'

const identity: RunIdentity = { ownerId: 'owner-a', sessionId: '12', runId: 'run-a' }
const lease = { identity, input: { v: 2, source: 'web', userMessageId: '1' } } as never
const scope = { identity, roundId: 'round-1', signal: new AbortController().signal, execute: async () => { throw new Error('MCP 不应调用本地执行器') }, resolution: null }

function fixture(configured: readonly string[]) {
  const calls: unknown[][] = []
  let currentTools = [...configured]
  const base = {
    async capabilities() { return [] },
    tools: {
      async dispatch() { throw new Error('不应进入内置工具') },
      async reconcile() { return { kind: 'unknown' as const } },
    },
  }
  const preparation = {
    async configuration(current: RunIdentity) {
      return { identity: { ownerId: current.ownerId, subject: { kind: 'session', id: current.sessionId }, workspaceId: null }, source: 'web', toolNames: currentTools }
    },
    async discover() { return [] },
    capabilities: {
      async filterConfigured(names: readonly string[]) {
        return names.filter(name => currentTools.includes(name))
      },
    },
    formatPrefix() { return [] },
  }
  const mcp = {
    async directory(ownerId: string) {
      assert.equal(ownerId, identity.ownerId)
      return [{ name: 'mcp_places_lookup', description: '查询地点', description_short: '查询地点', input_schema: { type: 'object' }, server_id: 'server-a', server_name: '地点', tool_name: 'lookup' }]
    },
    runtime: { async dispatchForAgent(...args: unknown[]) { calls.push(args); return { result: '地点结果' } } },
    async authorize() { return true },
  }
  return {
    calls,
    setConfigured(names: readonly string[]) { currentTools = [...names] },
    ports: createWebAgentToolPorts(lease, base as never, preparation as never, mcp as never),
  }
}

test('MCP dispatch rejects a tool absent from the current session configuration', async () => {
  const { ports, calls } = fixture([])
  const result = await ports.tools.dispatch({ id: 'call-1', name: 'mcp_places_lookup', input: {} }, scope as never)
  assert.deepEqual(result, { kind: 'completed', value: { error: '工具不存在或未开放' }, successful: false, mutated: false, executed: false })
  assert.equal(calls.length, 0)
})

test('MCP dispatch remains available for a tool configured in the current session', async () => {
  const { ports, calls } = fixture(['mcp_places_lookup'])
  const result = await ports.tools.dispatch({ id: 'call-1', name: 'mcp_places_lookup', input: {} }, scope as never)
  assert.deepEqual(result, { kind: 'completed', value: { result: '地点结果' }, successful: true, mutated: true, executed: true })
  assert.equal(calls.length, 1)
})

test('MCP dispatch rechecks configuration after schema discovery when the tool was revoked', async () => {
  const { ports, calls, setConfigured } = fixture(['mcp_places_lookup'])
  const definitions = await ports.preparation.discover({
    identity: { ownerId: identity.ownerId, subject: { kind: 'session', id: identity.sessionId }, workspaceId: null },
    toolNames: ['mcp_places_lookup'],
  }, new AbortController().signal)
  assert.deepEqual(definitions.map(item => item.name), ['mcp_places_lookup'])
  setConfigured([])
  const result = await ports.tools.dispatch({ id: 'call-1', name: 'mcp_places_lookup', input: {} }, scope as never)
  assert.deepEqual(result, { kind: 'completed', value: { error: '工具不存在或未开放' }, successful: false, mutated: false, executed: false })
  assert.equal(calls.length, 0)
})
