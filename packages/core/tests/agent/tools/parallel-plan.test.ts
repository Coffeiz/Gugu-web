import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolDefinition, ToolScope } from '../../../src/agent/tools/contracts.js'
import type { ToolCall, ToolResult } from '../../../src/agent/models.js'
import { collect, deferred, fixture, identity } from '../run/fixtures.js'

const inputSchema = z.object({ value: z.number().int() })
function tool(name: string, effect: 'read' | 'write', execute: ToolDefinition['execute'], extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return { definition: { name, schema: { type: 'function', function: { name, parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } } } },
    effect, validate: value => inputSchema.safeParse(value), execute, ...extra }
}
function result(value: unknown, mutated = false): ToolResult { return { kind: 'completed', value, successful: true, mutated } }
const unused = vi.fn<ToolDefinition['execute']>().mockResolvedValue(result('未使用'))
function call(id: string, name = 'work', input: unknown = { value: 1 }): ToolCall { return { id, name, input } }
function runFixture(calls: ToolCall[]) {
  return fixture([[{ type: 'complete', text: '', calls }], [{ type: 'complete', text: '完成', calls: [] }]])
}

describe('真实工具注册器同轮并发计划', () => {
  it('只分流交互和协议异常，不预查权限、schema或依据读写推断冲突', async () => {
    const authorize = vi.fn(async () => true), validate = vi.fn(inputSchema.safeParse.bind(inputSchema))
    const definitions = [tool('read', 'read', unused, { validate }), tool('write', 'write', unused),
      tool('ask_user', 'read', unused), tool('manage_mcp_servers', 'write', unused),
      tool('interactive', 'write', unused, { requiresInteraction: true }), tool('disabled', 'read', unused),
      tool('dangerous', 'write', unused, { destructive: true })]
    const registry = createToolRegistry({ tools: definitions, authorize })
    registry.configure({ tools: { disabled: false } })
    const calls: ToolCall[] = [call('read', 'read', {}), call('write', 'write'), call('dangerous', 'dangerous'),
      { ...call('parse', 'read'), parseError: 'invalid_json' }, call('missing', 'missing'), call('array', 'read', []), call('null', 'read', null),
      call('ask', 'ask_user'), call('mcp', 'manage_mcp_servers'), call('interactive', 'interactive'), call('disabled', 'disabled')]
    expect(await registry.tools.plan!(calls, identity)).toEqual({ mode: 'parallel', maxConcurrency: 5,
      serialCallIds: ['dangerous', 'parse', 'missing', 'array', 'null', 'ask', 'mcp', 'interactive', 'disabled'] })
    expect(authorize).not.toHaveBeenCalled(); expect(validate).not.toHaveBeenCalled()
    // Node危险工具尚未开放，保持串行拒绝；这不同于Python已可用危险工具的并发资格。
    const scope: ToolScope = { identity, roundId: 'round', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
    expect(await registry.tools.dispatch(call('dangerous', 'dangerous'), scope)).toMatchObject({ successful: false, executed: false })
  })
  it.each([0, -1, 1.5, 129, NaN, Infinity])('非法并发上限%s在装配时拒绝', maxConcurrency => {
    expect(() => createToolRegistry({ tools: [], authorize: async () => true, maxConcurrency })).toThrow()
  })
  it.each([1, 128])('合法并发边界%s保留', async maxConcurrency => {
    const registry = createToolRegistry({ tools: [tool('work', 'write', unused)], authorize: async () => true, maxConcurrency })
    expect(await registry.tools.plan!([call('a')], identity)).toMatchObject({ mode: 'parallel', maxConcurrency })
  })
  it('Harness中普通读写确实同时启动，完成前可观察真实内存副作用', async () => {
    const started = deferred<void>(), release = deferred<void>(), effects: string[] = []
    const execute = (name: string, write: boolean): ToolDefinition['execute'] => async () => {
      effects.push(`start:${name}`)
      if (effects.length === 2) started.resolve()
      await release.promise
      effects.push(`finish:${name}`)
      return result(name, write)
    }
    const registry = createToolRegistry({ tools: [tool('read', 'read', execute('read', false)), tool('write', 'write', execute('write', true))], authorize: async () => true })
    const f = runFixture([call('a', 'read'), call('b', 'write')]); f.ports.tools = registry.tools
    const running = collect(f.harness.start(identity))
    try {
      await vi.waitFor(() => expect(effects).toHaveLength(2), { timeout: 2000 })
      await started.promise
      expect(effects).toEqual(['start:read', 'start:write'])
    } finally { release.resolve() }
    expect((await running).state.status).toBe('completed')
    expect(effects).toHaveLength(4)
  })
  it('Harness并发上限生效，未释放前不会启动第三项', async () => {
    const release = deferred<void>(), entered: number[] = []
    let active = 0, maximum = 0
    const execute: ToolDefinition['execute'] = async input => {
      const n = (input as { value: number }).value; entered.push(n)
      active++; maximum = Math.max(maximum, active)
      try { await release.promise; return result(n, true) } finally { active-- }
    }
    const registry = createToolRegistry({ tools: [tool('work', 'write', execute)], authorize: async () => true, maxConcurrency: 2 })
    const f = runFixture([call('a', 'work', { value: 1 }), call('b', 'work', { value: 2 }), call('c', 'work', { value: 3 })]); f.ports.tools = registry.tools
    const running = collect(f.harness.start(identity))
    try {
      await vi.waitFor(() => expect(entered).toEqual([1, 2]), { timeout: 2000 })
      expect(active).toBe(2)
    } finally { release.resolve() }
    expect((await running).state.status).toBe('completed')
    expect(entered).toEqual([1, 2, 3]); expect(maximum).toBe(2)
  })
  it('同轮非法schema仅拒绝该项，其他写调用仍产生实际副作用', async () => {
    const effects: number[] = []
    const registry = createToolRegistry({ tools: [tool('work', 'write', async input => { effects.push((input as { value: number }).value); return result('已写入', true) })], authorize: async () => true })
    const f = runFixture([call('invalid', 'work', { value: '非法' }), call('valid', 'work', { value: 2 })]); f.ports.tools = registry.tools
    const outputs = new Map<string, ToolResult>()
    const afterTool = f.ports.context.afterTool
    f.ports.context.afterTool = async (context, call, result, round) => { outputs.set(call.id, result); return afterTool(context, call, result, round) }
    expect((await collect(f.harness.start(identity))).state.status).toBe('completed')
    expect(effects).toEqual([2])
    expect(outputs.get('invalid')).toMatchObject({ kind: 'completed', successful: false, executed: false, value: { error: 'tool_input_invalid' } })
    expect(outputs.get('valid')).toMatchObject({ kind: 'completed', successful: true, mutated: true })
  })
  it('取消并发读取等待handler清理完成再结束Run，未放行cleanup不能假完成', async () => {
    const entered = deferred<void>(), aborted = deferred<void>(), cleanup = deferred<void>()
    let cleaned = false, settled = false
    const registry = createToolRegistry({ tools: [tool('work', 'read', async (_input, scope) => {
      entered.resolve()
      await new Promise<void>(resolve => { if (scope.signal.aborted) resolve(); else scope.signal.addEventListener('abort', () => resolve(), { once: true }) })
      aborted.resolve()
      await cleanup.promise
      cleaned = true
      scope.signal.throwIfAborted()
      return result('不应返回')
    })], authorize: async () => true })
    const f = runFixture([call('read')]); f.ports.tools = registry.tools
    const running = collect(f.harness.start(identity)).finally(() => { settled = true })
    try {
      await entered.promise
      expect(await f.harness.cancel(identity)).toBe(true)
      await aborted.promise
      await Promise.resolve()
      expect(settled).toBe(false); expect(cleaned).toBe(false)
    } finally { cleanup.resolve() }
    expect((await running).state.status).toBe('cancelled')
    expect(cleaned).toBe(true)
  })
})
