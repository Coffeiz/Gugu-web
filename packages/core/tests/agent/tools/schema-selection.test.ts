import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { selectToolSchemas } from '../../../src/agent/tools/schema-selection.js'
import type { ToolDefinition } from '../../../src/agent/tools/contracts.js'

const identity = { ownerId: 'owner-a', sessionId: 'session-a', runId: 'run-a' }
function definition(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return { definition: { name, schema: { type: 'function', function: { name, description: `定义:${name}`, parameters: { type: 'object', properties: {} } } } },
    effect: 'read', validate: input => ({ success: true, data: input }), execute }
}
function fixture(names: string[]) {
  const execute = vi.fn<ToolDefinition['execute']>(async () => { throw new Error('Schema选择不得执行工具') })
  const denied = new Set<string>()
  const authorize = vi.fn(async (owner: typeof identity, name: string) => owner.ownerId === identity.ownerId && !denied.has(name))
  const registry = createToolRegistry({ tools: names.map(name => definition(name, execute)), authorize })
  return { registry, execute, authorize, denied, tool: (name: string) => definition(name, execute) }
}

describe('仅从可信当前capabilities选择工具Schema', () => {
  it('授权、停用工具和停用分组均过滤后再展开prefix，不泄露不可见定义', async () => {
    const f = fixture(['visible_one', 'hidden_private', 'disabled_tool'])
    f.denied.add('hidden_private')
    f.registry.registerGroup({ id: 'off', name: '停用分组', tools: [f.tool('hidden_group_member')] })
    f.registry.configure({ tools: { disabled_tool: false }, groups: { off: false } })
    const available = await f.registry.capabilities(identity)
    const result = selectToolSchemas(['*', 'hidden_*', 'disabled_*'], available)
    expect(result).toEqual({ tool_schemas: ['visible_one'], rejected: ['hidden_*', 'disabled_*'] })
    expect(JSON.stringify(result)).not.toMatch(/hidden_private|hidden_group_member|定义:/)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.authorize).toHaveBeenCalled()
  })
  it('每次用最新capabilities响应撤权和启停，不依赖先前可见快照', async () => {
    const f = fixture(['work_a'])
    expect(selectToolSchemas(['work_*'], await f.registry.capabilities(identity))).toEqual({ tool_schemas: ['work_a'], rejected: [] })
    f.denied.add('work_a')
    expect(selectToolSchemas(['work_*'], await f.registry.capabilities(identity))).toEqual({ error: '没有可获取 Schema 的已授权工具', rejected: ['work_*'] })
    f.denied.clear()
    f.registry.configure({ tools: { work_a: false } })
    expect(selectToolSchemas(['work_*'], await f.registry.capabilities(identity))).toEqual({ error: '没有可获取 Schema 的已授权工具', rejected: ['work_*'] })
    expect(selectToolSchemas(['*'], await f.registry.capabilities({ ...identity, ownerId: 'other-owner' }))).toEqual({ error: '没有可获取 Schema 的已授权工具', rejected: ['*'] })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('prefix按真实注册插入顺序动态展开，新增工具无需静态枚举', async () => {
    const f = fixture(['work_z', 'work_a', 'other'])
    expect(selectToolSchemas(['work_*'], await f.registry.capabilities(identity))).toEqual({ tool_schemas: ['work_z', 'work_a'], rejected: [] })
    f.registry.register(f.tool('work_m'))
    expect(selectToolSchemas(['work_*'], await f.registry.capabilities(identity))).toEqual({ tool_schemas: ['work_z', 'work_a', 'work_m'], rejected: [] })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('重复精确请求或全已声明prefix按Python accepted=false列入rejected', async () => {
    const f = fixture(['work_a', 'work_b'])
    expect(selectToolSchemas(['work_a', 'work_a', 'work_*', 'work_*'], await f.registry.capabilities(identity))).toEqual({ tool_schemas: ['work_a', 'work_b'], rejected: ['work_a', 'work_*'] })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('任一成功时保留正常结果与拒绝列表，全部拒绝才返回error', async () => {
    const f = fixture(['work_a'])
    const available = await f.registry.capabilities(identity)
    expect(selectToolSchemas(['missing', 'work_a', 'missing_*'], available)).toEqual({ tool_schemas: ['work_a'], rejected: ['missing', 'missing_*'] })
    expect(selectToolSchemas(['missing', 'missing_*'], available)).toEqual({ error: '没有可获取 Schema 的已授权工具', rejected: ['missing', 'missing_*'] })
  })
  it('只截取最先12条请求，空白也占请求槽位且不生成rejected', async () => {
    const f = fixture(['work_a'])
    expect(selectToolSchemas([...Array.from({ length: 12 }, () => '  '), 'work_a'], await f.registry.capabilities(identity))).toEqual({ tool_schemas: [], rejected: [] })
  })
  it('最终声明至多12项，达到上限后的请求即使存在也被拒绝', async () => {
    const names = Array.from({ length: 15 }, (_, n) => `work_${String(n).padStart(2, '0')}`)
    const f = fixture(names)
    expect(selectToolSchemas(['*', 'work_12'], await f.registry.capabilities(identity))).toEqual({ tool_schemas: names.slice(0, 12), rejected: ['work_12'] })
    expect(selectToolSchemas(names, await f.registry.capabilities(identity))).toEqual({ tool_schemas: names.slice(0, 12), rejected: [] })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('Python strip移除C0与Unicode空白但保留BOM，不修改请求或公开声明', async () => {
    const f = fixture(['work_a', 'work_b'])
    const requested = ['\u001cwork_a\u0085', ' \twork_b\r\n', '\u001e\u001f', '\ufeffwork_a']
    const savedRequests = [...requested]
    const available = await f.registry.capabilities(identity), savedAvailable = structuredClone(available)
    expect(selectToolSchemas(requested, available)).toEqual({ tool_schemas: ['work_a', 'work_b'], rejected: ['\ufeffwork_a'] })
    expect(requested).toEqual(savedRequests)
    expect(available).toEqual(savedAvailable)
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('仅末尾星号是prefix语法，内部星号不当成任意通配', async () => {
    const f = fixture(['work_a', 'work_b'])
    expect(selectToolSchemas(['work_*_a', 'work_**', 'work_a'], await f.registry.capabilities(identity))).toEqual({ tool_schemas: ['work_a'], rejected: ['work_*_a', 'work_**'] })
  })
  it('无请求或只有空白返回空数组，非空规则留给工具输入schema', async () => {
    const f = fixture(['work_a'])
    const available = await f.registry.capabilities(identity)
    expect(selectToolSchemas([], available)).toEqual({ tool_schemas: [], rejected: [] })
    expect(selectToolSchemas([' ', '\u0085'], available)).toEqual({ tool_schemas: [], rejected: [] })
    expect(f.execute).not.toHaveBeenCalled()
  })
})
