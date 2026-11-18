import { describe, expect, it, vi } from 'vitest'
import { fixture, collect } from './fixtures.js'

import { createAgentRunToolPorts } from '../../../src/agent/index.js'
import type { CanonicalRunPreparationPorts, RunIdentity, ToolPort } from '../../../src/agent/index.js'

const identity: RunIdentity = { ownerId: 'owner-a', sessionId: 'session-a', runId: 'run-a' }
const preparationIdentity = { ownerId: identity.ownerId, subject: { kind: 'session' as const, id: identity.sessionId }, workspaceId: null }

describe('Agent Run tool binding', () => {
  it('只发现配置快照中的工具，并拒绝身份漂移和越界分派/恢复', async () => {
    const dispatch = vi.fn(async () => ({ kind: 'completed' as const, value: { ok: true }, successful: true, mutated: false, executed: true }))
    const reconcile = vi.fn(async () => ({ kind: 'completed' as const, value: { ok: true }, successful: true, mutated: false, executed: true }))
    const registry = {
      capabilities: vi.fn(async () => [{ name: 'allowed', schema: {} }, { name: 'later-added', schema: {} }]),
      tools: { dispatch, reconcile } as ToolPort,
    }
    const configuration = vi.fn(async () => ({ identity: preparationIdentity, source: 'web', toolNames: ['allowed', 'later-added'] }))
    const preparation = {
      configuration, capabilities: { async filterConfigured(names: readonly string[]) { return names } },
    } as Omit<CanonicalRunPreparationPorts, 'discover'>
    const bound = createAgentRunToolPorts({
      identity, registry, preparation,
      configurationMatches: (value, run) => value.source === 'web' && value.identity.ownerId === run.ownerId
        && value.identity.subject.kind === 'session' && value.identity.subject.id === run.sessionId,
    })

    expect((await bound.preparation.discover({ identity: preparationIdentity, toolNames: ['allowed'] }, new AbortController().signal)).map(item => item.name)).toEqual(['allowed'])
    expect(registry.capabilities).toHaveBeenCalledWith(identity)
    expect(await bound.tools.dispatch({ name: 'allowed', input: {} }, { identity: { ...identity, runId: 'other' }, signal: new AbortController().signal } as never)).toMatchObject({ successful: false, mutated: false, executed: false })
    expect(await bound.tools.reconcile({ name: 'allowed', input: {} }, { ...identity, runId: 'other' })).toEqual({ kind: 'unknown' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()

    configuration.mockResolvedValueOnce({ identity: { ...preparationIdentity, subject: { kind: 'session', id: 'session-b' } }, source: 'web', toolNames: ['allowed'] })
    await expect(bound.preparation.discover({ identity: preparationIdentity, toolNames: ['allowed'] }, new AbortController().signal)).rejects.toThrow('工具运行身份不匹配')
  })
})

it('经已授权的 call_tool 执行最终工具，保留 Provider 原调用并续轮', async () => {
  const wrapped = { id: 'provider-call', name: 'call_tool', input: {
    tool_name: 'call_tool', arguments: { name: ' lookup ', arguments: { query: '合成目标' } },
  } }
  const h = fixture([[{ type: 'complete', text: '', calls: [wrapped] }], [{ type: 'complete', text: '处理完成', calls: [] }]])
  const dispatch = vi.fn<ToolPort['dispatch']>(async (call, scope) => {
    expect(call).toMatchObject({ id: wrapped.id, name: 'lookup', input: { query: '合成目标' } })
    expect(scope.identity).toEqual(identity)
    if (!scope.resolution) return { kind: 'waiting', interaction: { id: 'confirmation', kind: 'confirmation', toolCall: call } }
    return { kind: 'completed', value: { id: 1 }, successful: true, mutated: true }
  })
  const plan = vi.fn<NonNullable<ToolPort['plan']>>(async () => ({ mode: 'serial' as const }))
  let allowed = true
  const bound = createAgentRunToolPorts({
    identity,
    registry: { capabilities: async () => [{ name: 'call_tool', schema: {} }, ...(allowed ? [{ name: 'lookup', schema: {} }] : [])],
      tools: { dispatch, plan, reconcile: async () => ({ kind: 'unknown' }) } },
    preparation: {
      configuration: async () => ({ identity: preparationIdentity, source: 'web', toolNames: ['call_tool', 'lookup'] }),
      capabilities: { async filterConfigured(names) { return names } },
    } as Omit<CanonicalRunPreparationPorts, 'discover'>,
    configurationMatches: () => true,
  })
  h.ports.tools = bound.tools
  const waiting = await collect(h.harness.start(identity))
  expect(waiting.state.status).toBe('waiting')
  expect(waiting.state.pending?.toolCall.name).toBe('lookup')
  expect(plan).toHaveBeenCalledWith([expect.objectContaining({ id: wrapped.id, name: 'lookup', input: { query: '合成目标' } })], identity)
  expect(h.ports.context.afterRound).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ calls: [wrapped] }), 1)
  const result = await collect(h.harness.resume(identity, { interactionId: 'confirmation', receiptId: 'receipt', status: 'confirmed', value: null }))
  expect(result.state.status).toBe('completed')
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'tool_done', payload: expect.objectContaining({ name: 'lookup', status: 'success' }) }))
  allowed = false
  expect(await bound.tools.resolveCall!(wrapped, identity, new AbortController().signal)).toEqual({ error: '工具不存在或未开放' })
  let recursive: unknown = wrapped.input
  for (let index = 0; index < 4; index++) recursive = { tool_name: 'call_tool', arguments: recursive }
  expect(await bound.tools.resolveCall!({ ...wrapped, input: recursive }, identity, new AbortController().signal)).toEqual({ error: 'call_tool 嵌套层数超过限制' })
  expect(dispatch).toHaveBeenCalledTimes(2)
})

it.each(['lookup', 'call_tool'])('等待确认后撤销 %s 配置，旧转发不能派发或读取收据', async disabled => {
  const wrapped = { id: 'waiting-call', name: 'call_tool', input: { tool_name: 'lookup', arguments: {} } }
  const h = fixture([[{ type: 'complete', text: '', calls: [wrapped] }], [{ type: 'complete', text: '处理完成', calls: [] }]])
  const dispatch = vi.fn<ToolPort['dispatch']>(async call =>
    ({ kind: 'waiting', interaction: { id: 'confirmation', kind: 'confirmation', toolCall: call } }))
  const reconcile = vi.fn<ToolPort['reconcile']>(async () => ({ kind: 'unknown' }))
  const preparation = (toolNames: readonly string[]) => ({
    configuration: async () => ({ identity: preparationIdentity, source: 'web', toolNames }),
    capabilities: { async filterConfigured(names: readonly string[]) { return names } },
  }) as Omit<CanonicalRunPreparationPorts, 'discover'>
  const bind = (visible: readonly string[]) => createAgentRunToolPorts({
    identity, preparation: preparation(visible), configurationMatches: () => true,
    registry: { capabilities: async () => [{ name: 'call_tool', schema: {} }, { name: 'lookup', schema: {} }],
      tools: { dispatch, reconcile } },
  })
  const names = ['call_tool', 'lookup']
  h.ports.tools = bind(names).tools
  const waiting = await collect(h.harness.start(identity))
  expect(waiting.state.status).toBe('waiting')
  const revoked = bind(names.filter(name => name !== disabled))
  h.ports.tools = revoked.tools
  expect((await revoked.preparation.discover({ identity: preparationIdentity, toolNames: names }, new AbortController().signal))
    .map(item => item.name)).not.toContain(disabled)
  expect(await revoked.tools.reconcile(waiting.state.pending!.toolCall, { ...identity, roundId: '1' })).toEqual({ kind: 'unknown' })
  const result = await collect(h.harness.resume(identity, { interactionId: 'confirmation', receiptId: 'receipt', status: 'confirmed', value: null }))
  expect(result.state.status).toBe('completed')
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'tool_done', payload: expect.objectContaining({
    toolCallId: wrapped.id, result: { error: '工具不存在或未开放' },
  }) }))
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(reconcile).not.toHaveBeenCalled()
})

it('非法转发协议在计划之前形成配对错误，不调用目标', async () => {
  const wireCall = { id: 'invalid', name: 'call_tool', input: { tool_name: 'lookup', arguments: '不是对象' } }
  const h = fixture([[{ type: 'complete', text: '', calls: [wireCall] }], [{ type: 'complete', text: '收到错误', calls: [] }]])
  const plan = vi.fn<NonNullable<ToolPort['plan']>>(async () => ({ mode: 'serial' as const }))
  const dispatch = vi.fn<ToolPort['dispatch']>(async () => { throw new Error('非法转发不可派发') })
  const bound = createAgentRunToolPorts({
    identity, registry: { capabilities: async () => [], tools: { dispatch, plan, reconcile: async () => ({ kind: 'unknown' }) } },
    preparation: { configuration: async () => { throw new Error('非法请求不应查询授权配置') } } as Omit<CanonicalRunPreparationPorts, 'discover'>,
    configurationMatches: () => true,
  })
  h.ports.tools = bound.tools
  const result = await collect(h.harness.start(identity))
  expect(result.events).toContainEqual(expect.objectContaining({ type: 'tool_done', payload: expect.objectContaining({
    toolCallId: 'invalid', result: expect.objectContaining({
      error: 'tool_call_invalid', issues: [{ path: 'arguments', rule: 'type', message: 'call_tool.arguments 必须是 JSON object' }],
    }),
  }) }))
  expect(plan).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
})
