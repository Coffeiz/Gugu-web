import { rankToolSearch } from '../../../src/agent/tools/search-tools.js'
import { createSearchToolsTool } from '../../../src/agent/tools/meta.js'
import { expect, it, vi } from 'vitest'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolDefinition } from '../../../src/agent/tools/contracts.js'
import { createAgentToolBrief, projectAgentToolBrief } from '../../../src/agent/capabilities/brief.js'

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

it('工具搜索按用途排序，多个候选只给扁平参数，精确查询发出可信 Schema 事件', async () => {
  const f = fixture(['get_current_time'])
  const createEvent = f.tool('create_event')
  const complete = { type: 'function', function: { name: 'create_event', description: '创建日历活动', parameters: {
    type: 'object', properties: { title: { type: 'string' }, reminder: { type: 'object', properties: { minutes: { type: 'integer' } } } },
    required: ['title'],
  } } }
  f.registry.register({ ...createEvent, definition: { name: 'create_event', schema: complete } })
  f.registry.register(f.tool('list_events'))
  f.registry.register(f.tool('delete_event'))
  f.denied.add('delete_event')
  f.registry.register(createSearchToolsTool(candidate => f.registry.capabilities(candidate)))
  const directory = await f.registry.capabilities(identity)
  const names = directory.map(tool => tool.name)
  const brief = createAgentToolBrief({ tool_injection_mode: 'description' }, directory)
  expect(projectAgentToolBrief(brief, names).providerToolNames).toContain('search_tools')
  expect(projectAgentToolBrief(brief, names).providerToolNames).not.toContain('get_tool_schema')
  const run = (input: unknown, caller = identity) => f.registry.tools.dispatch({ id: 'discovery', name: 'search_tools', input }, {
    identity: caller, roundId: 'round', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('发现工具不得执行目标') },
  })
  const search = await run({ query: '在日历里安排会议' })
  expect(search).toMatchObject({ kind: 'completed', successful: true, value: { results: [
    { name: 'create_event', parameters: [{ name: 'title', type: 'string', required: true },
      { name: 'reminder', type: 'object', required: false }], requires_full_schema: true },
    { name: 'list_events' },
  ] } })
  expect(search).not.toHaveProperty('canonicalEvents')
  expect(JSON.stringify(search)).not.toContain('"schema":')
  expect(await run({ query: '没有相关工具' })).toMatchObject({ value: { results: [] } })

  const exact = await run({ names: ['create_event', 'delete_event'] })
  expect(exact).toMatchObject({
    value: { results: [{ name: 'create_event', schema: complete }], rejected: ['delete_event'] },
    canonicalEvents: [{ type: 'tool-discovery', tool_names: ['create_event'] },
      { type: 'tool-schema', tool_name: 'create_event', schema: complete }],
  })
  expect(await run({ query: 'create_event' })).toMatchObject({ value: { results: [{ name: 'create_event', schema: complete }] } })
  expect(await run({ names: ['*'] })).toMatchObject({ successful: false, executed: false })
  expect(await run({ names: Array.from({ length: 21 }, () => 'list_events') })).toMatchObject({ successful: false, executed: false })
  expect(await run({ query: '日历', names: ['create_event'] })).toMatchObject({ successful: false, executed: false })
  expect(await run({ names: ['create_event'] }, { ...identity, ownerId: 'owner-b' }))
    .toMatchObject({ successful: false, executed: false })
  f.denied.add('create_event')
  expect(await run({ names: ['create_event'] })).toMatchObject({ value: { results: [], rejected: ['create_event'] } })
  expect(f.execute).not.toHaveBeenCalled()
})

it('工具发现默认返回 10 个候选，允许查到 20 个候选或精确名称', async () => {
  const names = Array.from({ length: 21 }, (_, index) => `list_events_${index}`)
  const f = fixture(names)
  f.registry.register(createSearchToolsTool(candidate => f.registry.capabilities(candidate)))
  const run = (input: unknown) => f.registry.tools.dispatch({ id: 'discovery', name: 'search_tools', input }, {
    identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('发现工具不得执行目标') },
  })
  for (const [input, count] of [
    [{ query: 'list' }, 10],
    [{ query: 'list', limit: 20 }, 20],
    [{ names: names.slice(0, 20) }, 20],
  ] as const) {
    const result = await run(input)
    expect(result).toMatchObject({ successful: true })
    expect(result).toHaveProperty('value.results.length', count)
  }
  for (const input of [{ query: 'list', limit: 0 }, { query: 'list', limit: 21 }, { names: names.slice(0, 1), limit: 5 }]) {
    expect(await run(input)).toMatchObject({ successful: false, executed: false })
  }
})

it('工具搜索分别优先返回普通笔记和画布便签的对应工具', async () => {
  const f = fixture(['canvas_create_note', 'note_create', 'canvas_search', 'note_search'])
  const tools = await f.registry.capabilities(identity)
  expect(rankToolSearch('创建笔记', tools, 5)[0]?.name).toBe('note_create')
  expect(rankToolSearch('搜索笔记', tools, 5)[0]?.name).toBe('note_search')
  expect(rankToolSearch('创建画布便签', tools, 5)[0]?.name).toBe('canvas_create_note')
  expect(rankToolSearch('搜索画布便签', tools, 5)[0]?.name).toBe('canvas_search')
})
