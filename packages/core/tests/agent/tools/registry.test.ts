import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolDefinition, ToolScope } from '../../../src/agent/tools/contracts.js'
import { createProjectTool } from '../../../src/agent/tools/projects/index.js'

const identity = { ownerId: 'owner-a', sessionId: '1', runId: 'run-a' }
function setup(effect: 'read' | 'write' = 'read', destructive = false) {
  const execute = vi.fn<ToolDefinition['execute']>().mockResolvedValue({ kind: 'completed', value: { owner: identity.ownerId }, successful: true, mutated: effect === 'write' })
  const authorize = vi.fn().mockResolvedValue(true)
  const tool: ToolDefinition = { definition: { name: 'example', schema: { type: 'function', function: { name: 'example', parameters: { type: 'object', properties: {} } } } }, effect, destructive,
    validate: input => typeof input === 'object' && input !== null && !Array.isArray(input) ? { success: true, data: input } : { success: false }, execute }
  const registry = createToolRegistry({ tools: [tool], authorize })
  const scope: ToolScope = { identity, roundId: 'round-a', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
  const call = { id: 'call-a', name: 'example', input: {} }
  return { registry, scope, call, execute, authorize, tool }
}

describe('可信工具注册边界', () => {
  it('真实派发返回Python纠错载荷，未知字段名称和值不进入错误', async () => {
    const create = vi.fn().mockResolvedValue({ success: true })
    const f = setup()
    const registry = createToolRegistry({ tools: [createProjectTool({ create })], authorize: async () => true })
    const result = await registry.tools.dispatch({ id: 'missing', name: 'create_project', input: {} }, f.scope)
    expect(result).toEqual({ kind: 'completed', successful: false, mutated: false, executed: false, value: {
      error: 'tool_input_invalid', tool: 'create_project', issues: [
        { path: 'deadline', rule: 'required', message: '缺少必填字段 deadline' },
        { path: 'project_name', rule: 'required', message: '缺少必填字段 project_name' },
        { path: 'start_date', rule: 'required', message: '缺少必填字段 start_date' },
      ], _schema_recovery: { needed: true, reason: 'validation_error' },
      usage_hint: '参数不符合工具 schema。先按 issues 修正；缺少无法从上下文确定的必填信息时，先向用户询问。',
      next_action: '请补齐必填字段：deadline、project_name、start_date。如果当前对话没有提供且无法可靠推断，请先向用户询问，不要提交空参数重试。',
    } })
    const privateInput = { project_name: '项目', start_date: '2026-01-01', deadline: '2026-02-01', 'synthetic-private-key': 'synthetic-secret-value' }
    const rejected = await registry.tools.dispatch({ id: 'private', name: 'create_project', input: privateInput }, f.scope)
    expect(rejected).toMatchObject({ successful: false, executed: false, value: { issues: [{ path: '$', rule: 'additionalProperties' }] } })
    expect(JSON.stringify(rejected)).not.toContain('synthetic-private-key')
    expect(JSON.stringify(rejected)).not.toContain('synthetic-secret-value')
    expect(create).not.toHaveBeenCalled()
  })
  it('显式领域注册和配置启停同时控制发现与实际调用', async () => {
    const f = setup()
    const registry = createToolRegistry({ authorize: async () => true })
    registry.registerGroup({ id: 'clients', name: '联系人', tools: [f.tool] })
    expect(await registry.capabilities(identity)).toHaveLength(1)
    registry.configure({ groups: { clients: false }, tools: { example: true } })
    expect(await registry.capabilities(identity)).toEqual([])
    expect(await registry.tools.dispatch(f.call, f.scope)).toMatchObject({ executed: false })
    expect(f.execute).not.toHaveBeenCalled()
    registry.configure({ tools: { example: false } })
    expect(await registry.capabilities(identity)).toEqual([])
    registry.configure({})
    expect(await registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: true })
  })
  it('分组重名或非法配置原子拒绝，外部修改不会篡改已注册定义', async () => {
    const f = setup()
    const registry = createToolRegistry({ authorize: async () => true })
    expect(() => registry.registerGroup({ id: 'bad', name: '错误分组', tools: [f.tool, f.tool] })).toThrow()
    expect(await registry.capabilities(identity)).toEqual([])
    registry.register(f.tool)
    Object.assign(f.tool.definition, { name: 'changed' })
    expect((await registry.capabilities(identity)).map(tool => tool.name)).toEqual(['example'])
    registry.configure({ tools: { example: false } })
    expect(() => registry.configure({ tools: { missing: true } })).toThrow()
    expect(await registry.capabilities(identity)).toEqual([])
    expect(() => registry.register(f.tool)).toThrow('工具声明名称不一致')
  })
  it('权限等待期间配置停用不能执行已发现工具', async () => {
    const f = setup()
    const registry = createToolRegistry({ tools: [f.tool], authorize: async () => {
      registry.configure({ tools: { example: false } })
      return true
    } })
    expect(await registry.tools.dispatch(f.call, f.scope)).toMatchObject({ executed: false })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('发现后撤权仍阻止调用且不产生副作用', async () => {
    const f = setup()
    expect(await f.registry.capabilities(identity)).toHaveLength(1)
    f.authorize.mockResolvedValue(false)
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(f.execute).not.toHaveBeenCalled()
    expect(await f.registry.capabilities(identity)).toEqual([])
  })
  it('未知工具、非法参数、解析失败和伪造确认都不执行', async () => {
    const f = setup()
    for (const call of [{ ...f.call, name: 'missing' }, { ...f.call, input: [] }, { ...f.call, parseError: 'invalid_json' as const }]) {
      expect(await f.registry.tools.dispatch(call, f.scope)).toMatchObject({ successful: false, executed: false })
    }
    expect(await f.registry.tools.dispatch(f.call, { ...f.scope, resolution: { interactionId: 'fake', receiptId: 'fake', status: 'confirmed', value: true } })).toMatchObject({ successful: false, executed: false })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('只有显式支持确认重放的工具可收到已确认的可信交互回执', async () => {
    const execute = vi.fn<ToolDefinition['execute']>().mockImplementation(async (_input, scope) => scope.resolution
      ? { kind: 'completed', value: { status: scope.resolution.status }, successful: true, mutated: true }
      : { kind: 'waiting', interaction: { id: 'interaction-a', kind: 'confirmation', toolCall: { id: 'call-a', name: 'example', input: {} } } })
    const definition: ToolDefinition = {
      definition: { name: 'example', schema: { type: 'function', function: { name: 'example', parameters: { type: 'object', properties: {} } } } },
      effect: 'write', requiresInteraction: true, confirmationReplay: true,
      validate: input => typeof input === 'object' && input !== null && !Array.isArray(input) ? { success: true, data: input } : { success: false },
      execute,
    }
    const registry = createToolRegistry({ tools: [definition], authorize: async () => true })
    const scope: ToolScope = { identity, roundId: 'round-a', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
    const call = { id: 'call-a', name: 'example', input: {} }
    expect(await registry.tools.dispatch(call, scope)).toMatchObject({ kind: 'waiting', interaction: { id: 'interaction-a' } })
    expect(await registry.tools.dispatch(call, { ...scope, resolution: { interactionId: 'interaction-a', receiptId: 'receipt-a', status: 'answered', value: null } }))
      .toMatchObject({ kind: 'completed', successful: false, executed: false })
    expect(await registry.tools.dispatch(call, { ...scope, resolution: { interactionId: 'interaction-a', receiptId: 'receipt-a', status: 'confirmed', value: null } }))
      .toMatchObject({ kind: 'completed', successful: true, mutated: true, value: { status: 'confirmed' } })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1]?.[1].resolution).toMatchObject({ status: 'confirmed', receiptId: 'receipt-a' })
  })
  it('危险工具未接可信确认时保持不可用', async () => {
    const f = setup('write', true)
    expect(await f.registry.capabilities(identity)).toEqual([])
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('只向实现传递已验证参数与可信身份，返回真实结果', async () => {
    const f = setup()
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: true, value: { owner: 'owner-a' } })
    expect(f.execute).toHaveBeenCalledWith({}, f.scope, f.call)
  })
  it('读错误不暴露异常内容，写错误保留未知状态，恢复不重复执行', async () => {
    for (const effect of ['read', 'write'] as const) {
      const f = setup(effect)
      f.execute.mockRejectedValue(new Error('secret=synthetic-token'))
      const result = await f.registry.tools.dispatch(f.call, f.scope)
      expect(result).toEqual(effect === 'write' ? { kind: 'unknown' } : { kind: 'completed', value: { error: '工具执行失败' }, successful: false, mutated: false, executed: true })
      expect(await f.registry.tools.reconcile(f.call, { ...identity, roundId: 'round-a' })).toEqual({ kind: 'unknown' })
      expect(f.execute).toHaveBeenCalledTimes(1)
    }
  })
  it('已取消请求拒绝执行，执行中取消等待处理器清理后才结束', async () => {
    const f = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(f.registry.tools.dispatch(f.call, { ...f.scope, signal: controller.signal })).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled()
    const active = new AbortController()
    let cleaned = false
    f.execute.mockImplementation(async () => { active.abort(); await Promise.resolve(); cleaned = true; throw new Error('取消') })
    await expect(f.registry.tools.dispatch(f.call, { ...f.scope, signal: active.signal })).rejects.toThrow()
    expect(cleaned).toBe(true)
  })
  it('授权服务异常时拒绝发现和执行，不透传异常', async () => {
    const f = setup()
    f.authorize.mockRejectedValue(new Error('secret=synthetic-token'))
    expect(await f.registry.capabilities(identity)).toEqual([])
    expect(await f.registry.tools.dispatch(f.call, f.scope)).toMatchObject({ successful: false, executed: false })
    expect(f.execute).not.toHaveBeenCalled()
  })
})

import type { ToolCall } from '../../../src/agent/models.js'
function boundaryDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}
function boundaryTool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return { definition: { name, schema: { type: 'function', function: { name, parameters: { type: 'object', properties: { label: { type: 'string' } } } } } }, effect: 'write',
    validate: input => ({ success: true, data: input }), execute }
}
type MutableToolScope = { -readonly [Key in keyof ToolScope]: ToolScope[Key] }

describe('工具调用可信身份与坐标的异步快照', () => {
  it('授权等待中修改原identity、scope及call，实际handler仍只操作原工具和原坐标', async () => {
    const entered = boundaryDeferred<void>(), authorization = boundaryDeferred<boolean>(), effects: string[] = []
    const originalIdentity = { ownerId: 'owner-original', sessionId: 'session-original', runId: 'run-original' }
    const controller = new AbortController(), replacement = new AbortController()
    const scope: MutableToolScope = { identity: originalIdentity, roundId: 'round-original', signal: controller.signal, execute: vi.fn(), resolution: null }
    const requested = { id: 'call-original', name: 'original', input: { label: '业务参数' }, parseError: undefined as ToolCall['parseError'] }
    const registry = createToolRegistry({ authorize: async () => { entered.resolve(); return authorization.promise }, tools: [
      boundaryTool('original', async (input, trusted, call) => {
        expect(input).toEqual({ label: '业务参数' })
        expect(trusted.identity).toEqual({ ownerId: 'owner-original', sessionId: 'session-original', runId: 'run-original' })
        expect(trusted.roundId).toBe('round-original')
        expect(trusted.signal).toBe(controller.signal)
        expect(trusted.resolution).toBeNull()
        expect(call).toMatchObject({ id: 'call-original', name: 'original', input: { label: '业务参数' } })
        expect(call.parseError).toBeUndefined()
        effects.push(`${trusted.identity.ownerId}:${trusted.roundId}:${call.name}:${call.id}`)
        return { kind: 'completed', value: { saved: true }, successful: true, mutated: true }
      }), boundaryTool('replacement', async () => { effects.push('错误工具副作用'); return { kind: 'completed', value: {}, successful: true, mutated: true } }),
    ] })
    const pending = registry.tools.dispatch(requested, scope)
    await entered.promise
    Object.assign(originalIdentity, { ownerId: 'owner-other', sessionId: 'session-other', runId: 'run-other' })
    scope.roundId = 'round-other'; scope.signal = replacement.signal
    scope.resolution = { interactionId: 'fake', receiptId: 'fake', status: 'confirmed', value: true }
    requested.name = 'replacement'; requested.id = 'call-other'; requested.parseError = 'invalid_json'
    authorization.resolve(true)
    expect(await pending).toMatchObject({ successful: true, mutated: true })
    expect(effects).toEqual(['owner-original:round-original:original:call-original'])
  })
  it('授权期间替换原scope.signal不能逃逸已取消的真实请求，不产生工具副作用', async () => {
    const entered = boundaryDeferred<void>(), authorization = boundaryDeferred<boolean>(), effects: string[] = []
    const controller = new AbortController(), replacement = new AbortController()
    const scope: MutableToolScope = { identity: { ...identity }, roundId: 'round', signal: controller.signal, execute: vi.fn(), resolution: null }
    const registry = createToolRegistry({ authorize: async () => { entered.resolve(); return authorization.promise }, tools: [boundaryTool('original', async () => {
      effects.push('不得写入'); return { kind: 'completed', value: {}, successful: true, mutated: true }
    })] })
    const pending = registry.tools.dispatch({ id: 'call', name: 'original', input: {} }, scope)
    await entered.promise
    scope.signal = replacement.signal
    const reason = new Error('原请求取消')
    controller.abort(reason)
    const rejected = expect(pending).rejects.toBe(reason)
    authorization.resolve(true)
    await rejected
    expect(effects).toEqual([])
  })
  it('capabilities首项判权等待中修改原identity，所有后续条目仍按入口身份过滤', async () => {
    const entered = boundaryDeferred<void>(), authorization = boundaryDeferred<void>()
    const mutableIdentity = { ownerId: 'owner-original', sessionId: 'session-original', runId: 'run-original' }
    const effects: string[] = []
    const registry = createToolRegistry({ tools: ['first', 'original_only', 'other_only'].map(name => boundaryTool(name, async () => {
      effects.push(name); return { kind: 'completed', value: {}, successful: true, mutated: true }
    })), authorize: async (trusted, name) => {
      if (name === 'first') { entered.resolve(); await authorization.promise }
      const original = trusted.ownerId === 'owner-original' && trusted.sessionId === 'session-original' && trusted.runId === 'run-original'
      return name === 'other_only' ? !original : original
    } })
    const pending = registry.capabilities(mutableIdentity)
    await entered.promise
    Object.assign(mutableIdentity, { ownerId: 'owner-other', sessionId: 'session-other', runId: 'run-other' })
    authorization.resolve()
    expect((await pending).map(definition => definition.name)).toEqual(['first', 'original_only'])
    expect(effects).toEqual([])
  })
})

import { z } from 'zod'
import type { Json } from '../../../src/agent/models.js'

describe('dispatch首个异步边界前保存可移植输入快照', () => {
  it('授权等待中修改嵌套object和array，handler仍接收初始校验结果且不污染原参数', async () => {
    const entered = boundaryDeferred<void>(), authorization = boundaryDeferred<boolean>()
    const schema = z.object({ nested: z.object({ file_id: z.number().int(), label: z.string() }), items: z.array(z.object({ label: z.string() })) })
    const input = { nested: { file_id: '#7', label: '最初对象' }, items: [{ label: '最初数组元素' }] }
    const effects: unknown[] = []
    const registry = createToolRegistry({ authorize: async () => { entered.resolve(); return authorization.promise }, tools: [{
      definition: { name: 'nested_snapshot', schema: { type: 'function', function: { name: 'nested_snapshot', parameters: z.toJSONSchema(schema) as Record<string, Json> } } },
      effect: 'write', validate: value => schema.safeParse(value),
      async execute(parsed) {
        const args = parsed as z.infer<typeof schema>
        expect(args).toEqual({ nested: { file_id: 7, label: '最初对象' }, items: [{ label: '最初数组元素' }] })
        effects.push(structuredClone(args))
        args.nested.label = 'handler内部改动'
        args.items.push({ label: 'handler内部新增' })
        return { kind: 'completed', value: { saved: true }, successful: true, mutated: true }
      },
    }] })
    const scope: ToolScope = { identity: { ...identity }, roundId: 'round', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
    const pending = registry.tools.dispatch({ id: 'call', name: 'nested_snapshot', input }, scope)
    await entered.promise
    input.nested.file_id = '#99'; input.nested.label = '授权等待中的外部改动'
    input.items[0]!.label = '外部改过的数组元素'; input.items.push({ label: '外部新增' })
    const externallyChanged = structuredClone(input)
    authorization.resolve(true)
    expect(await pending).toMatchObject({ successful: true, mutated: true })
    expect(effects).toEqual([{ nested: { file_id: 7, label: '最初对象' }, items: [{ label: '最初数组元素' }] }])
    expect(input).toEqual(externallyChanged)
  })
  it('enumerable getter输入不得执行访问器或handler，错误不含敏感值', async () => {
    const getter = vi.fn(() => 'synthetic-private-value'), effects: string[] = []
    const input = Object.defineProperty({}, 'label', { enumerable: true, get: getter })
    const authorize = vi.fn(async () => true)
    const registry = createToolRegistry({ authorize, tools: [boundaryTool('original', async () => {
      effects.push('不应执行'); return { kind: 'completed', value: {}, successful: true, mutated: true }
    })] })
    const scope: ToolScope = { identity: { ...identity }, roundId: 'round', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
    const result = await registry.tools.dispatch({ id: 'getter', name: 'original', input }, scope)
    expect(result).toMatchObject({ successful: false, executed: false, value: { error: 'tool_input_invalid' } })
    expect(getter).not.toHaveBeenCalled()
    expect(effects).toEqual([])
    expect(authorize).toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('synthetic-private-value')
  })
  it('同一非法getter输入未授权仍返回权限拒绝，不泄露输入校验或schema', async () => {
    const getter = vi.fn(() => 'synthetic-private-value'), effects: string[] = []
    const input = Object.defineProperty({}, 'label', { enumerable: true, get: getter })
    const registry = createToolRegistry({ authorize: async () => false, tools: [boundaryTool('original', async () => {
      effects.push('不应执行'); return { kind: 'completed', value: {}, successful: true, mutated: true }
    })] })
    const scope: ToolScope = { identity: { ...identity }, roundId: 'round', signal: new AbortController().signal, execute: vi.fn(), resolution: null }
    const result = await registry.tools.dispatch({ id: 'denied-getter', name: 'original', input }, scope)
    expect(result).toEqual({ kind: 'completed', value: { error: '没有权限使用此工具' }, successful: false, mutated: false, executed: false })
    expect(getter).not.toHaveBeenCalled()
    expect(effects).toEqual([])
    expect(JSON.stringify(result)).not.toMatch(/synthetic-private-value|tool_input_invalid|schema_recovery|issues/)
  })
})
