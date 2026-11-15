import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolDefinition } from '../../../src/agent/tools/contracts.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createTimeTool } from '../../../src/agent/tools/time.js'
import { createUseSkillTool } from '../../../src/agent/tools/meta.js'
import { createSkillRegistry } from '../../../src/agent/skills/registry.js'
import { createClientTools } from '../../../src/agent/tools/clients.js'
import { createListProjectsTool, createGetProjectTool } from '../../../src/agent/tools/projects.js'
import { createProjectTool } from '../../../src/agent/tools/projects.js'
import { createProjectMutationTools } from '../../../src/agent/tools/projects.js'
import { createReadFileTool } from '../../../src/agent/tools/files.js'

const identity = { ownerId: 'owner-a', sessionId: 'session-a', runId: 'run-a' }
function tool(name = 'example'): ToolDefinition {
  return { definition: { name, schema: { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } } }, effect: 'read',
    validate: input => ({ success: true, data: input }),
    execute: async () => ({ kind: 'completed', value: [], successful: true, mutated: false }) }
}
function changedSchema(schema: unknown): ToolDefinition { return { ...tool(), definition: { name: 'example', schema } } as ToolDefinition }

describe('工具注册期公开契约与原子性', () => {
  it.each(['', ' ', ' example', 'example '])('空白或非规范名称%s在注册期拒绝', name => {
    expect(() => createToolRegistry({ tools: [tool(name)], authorize: async () => true })).toThrow()
  })
  it('重复名称拒绝，不覆盖原有实现', async () => {
    const registry = createToolRegistry({ tools: [tool()], authorize: async () => true })
    expect(() => registry.register(tool())).toThrow()
    expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(['example'])
  })
  it('function.name与注册名不一致在发现和执行前拒绝', () => {
    const bad = changedSchema({ type: 'function', function: { name: 'other', parameters: { type: 'object', properties: {} } } })
    expect(() => createToolRegistry({ tools: [bad], authorize: async () => true })).toThrow()
  })
  it.each([null, [], 'object', { type: 'string' }, { type: ['object', 'null'] }])('parameters必须为根object schema：%j', parameters => {
    expect(() => createToolRegistry({ tools: [changedSchema({ type: 'function', function: { name: 'example', parameters } })], authorize: async () => true })).toThrow()
  })
  it.each([null, [], { type: 'array' }, { type: 'string' }])('input_schema必须为根object schema：%j', input_schema => {
    expect(() => createToolRegistry({ tools: [changedSchema({ name: 'example', input_schema })], authorize: async () => true })).toThrow()
  })
  it.each([null, [], { type: 'string' }, { type: 'function' }, { type: 'object', properties: {} }])('未知或缺损schema形状%j在注册期拒绝', schema => {
    expect(() => createToolRegistry({ tools: [changedSchema(schema)], authorize: async () => true })).toThrow()
  })
  it.each([{ effect: 'execute' }, { effect: undefined }, { validate: null }, { execute: null }])('不支持的effect或无效实现%j在注册期拒绝', patch => {
    expect(() => createToolRegistry({ tools: [{ ...tool(), ...patch } as unknown as ToolDefinition], authorize: async () => true })).toThrow()
  })
  it('分组后项定义失败时不留下部分工具、成员关系或占用分组ID', async () => {
    const registry = createToolRegistry({ tools: [tool('existing')], authorize: async () => true })
    const invalid = { ...tool('bad'), effect: 'unknown' } as unknown as ToolDefinition
    expect(() => registry.registerGroup({ id: 'group', name: '测试分组', tools: [tool('first'), invalid] })).toThrow()
    expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(['existing'])
    registry.registerGroup({ id: 'group', name: '修正分组', tools: [tool('first'), tool('second')] })
    registry.configure({ groups: { group: false } })
    expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(['existing'])
  })
  it('合法input_schema envelope可注册，参数object不是公开工具envelope', async () => {
    const registry = createToolRegistry({ tools: [changedSchema({ name: 'example', input_schema: { type: 'object', properties: {} } })], authorize: async () => true })
    expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(['example'])
  })
  it('当前全部真实工具工厂的公开定义都可注册，不调用领域后端', async () => {
    // 仅验证真实工厂产物能注册：这些显式失败端口不提供业务成功、数据库或平台执行验收。
    const unused = vi.fn(async (): Promise<never> => { throw new Error('注册不得调用领域后端') })
    const core = { transaction: unused } as unknown as SqlDataRuntime
    const skills = createSkillRegistry({ authorize: async () => true })
    const definitions = [
      createTimeTool({ now: () => new Date('2026-11-14T00:00:00Z'), timezone: unused }),
      createUseSkillTool({ skills, origin: unused }),
      ...createClientTools(core), createListProjectsTool(core), createGetProjectTool({ core, fileOverview: unused }),
      createProjectTool({ create: unused }), ...createProjectMutationTools({ apply: unused }),
      createReadFileTool({ resolveOwnedFile: unused, openFile: unused }),
    ]
    const registry = createToolRegistry({ tools: definitions, authorize: async () => true })
    expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(definitions.map(item => item.definition.name))
    expect(unused).not.toHaveBeenCalled()
  })
})

const malformedKeywordCases: [string, unknown][] = [
  ['Python既有required字符串', { type: 'object', properties: { query: { type: 'string' } }, required: 'query' }],
  ['嵌套properties非法type', { type: 'object', properties: { nested: { type: 'object', properties: { value: { type: 'not-a-json-type' } } } } }],
  ['负minLength', { type: 'object', properties: { value: { type: 'string', minLength: -1 } } }],
  ['重复required', { type: 'object', properties: { query: { type: 'string' } }, required: ['query', 'query'] }],
]
it.each(malformedKeywordCases)('%s注册时失败且分组不留部分状态', async (_label, parameters) => {
  const malformed = changedSchema({ type: 'function', function: { name: 'example', parameters } })
  expect(() => createToolRegistry({ tools: [malformed], authorize: async () => true })).toThrow()
  const registry = createToolRegistry({ tools: [tool('existing')], authorize: async () => true })
  expect(() => registry.registerGroup({ id: 'keyword-group', name: '公开关键字分组', tools: [tool('first'), malformed] })).toThrow()
  expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(['existing'])
  // 重用失败分组ID及首项名称，证明工具、成员关系和group均没有提前注册。
  registry.registerGroup({ id: 'keyword-group', name: '修正分组', tools: [tool('first'), tool('example')] })
  registry.configure({ groups: { 'keyword-group': false } })
  expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(['existing'])
})
it('循环Schema在注册期安全拒绝且分组无残留，不进入递归校验栈', async () => {
  const cyclic: Record<string, unknown> = { type: 'object' }
  cyclic.properties = { child: cyclic }
  const malformed = changedSchema({ type: 'function', function: { name: 'example', parameters: cyclic } })
  const registry = createToolRegistry({ authorize: async () => true })
  let rejected: unknown
  try { registry.registerGroup({ id: 'cyclic-group', name: '循环声明', tools: [tool('first'), malformed] }) } catch (error) { rejected = error }
  expect(rejected).toBeInstanceOf(Error)
  expect(rejected).not.toBeInstanceOf(RangeError)
  expect(await registry.capabilities(identity)).toEqual([])
  registry.registerGroup({ id: 'cyclic-group', name: '修正分组', tools: [tool('first'), tool('example')] })
  expect((await registry.capabilities(identity)).map(item => item.name)).toEqual(['first', 'example'])
})
