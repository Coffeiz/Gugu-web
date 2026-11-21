import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { SqlDataRuntime } from '../../../src/data/runtime.js'
import { createGlobalSearchOperations } from '../../../src/search/global-search.js'
import { createKyselySqliteGlobalSearchSources } from '../../../src/search/sqlite.js'
import { createDesktopFileSearchSources } from '../../../src/search/desktop-files.js'
import { createGlobalSearchTool } from '../../../src/agent/tools/global-search.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { ToolResult } from '../../../src/agent/models.js'
import { collect, fixture } from '../run/fixtures.js'

let folder: string, core: SqlDataRuntime, owner: string, other: string
let operations: ReturnType<typeof createGlobalSearchOperations>
let registry: ReturnType<typeof createToolRegistry>, allowed: boolean
const identity = () => ({ ownerId: owner, sessionId: '1', runId: 'search-run' })
const scope = () => ({ identity: identity(), roundId: 'round', signal: new AbortController().signal,
  resolution: null, execute: async () => { throw new Error('不应执行进程') } })
const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'search', name: 'global_search', input }, scope())
interface Result { query: string; queries: string[]; mode: string; total: number; note?: string; groups: Array<{ type: string; items: Array<{ title: string }> }> }
function value(result: ToolResult): Result {
  expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false })
  if (result.kind !== 'completed') throw new Error('工具没有完成')
  return result.value as Result
}
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'gugu-tool-search-'))
  const filename = join(folder, 'core.db')
  await initializeSqlite(filename)
  const opened = await openSqliteRuntime(filename)
  core = opened.runtime; owner = opened.ownerId; other = randomUUID(); allowed = true
  const deletedId = await core.transaction(dataContext(owner), async data => {
    for (let index = 0; index < 23; index++) await data.projects.create({ name: `alpha ${index}` })
    await data.projects.create({ name: 'alpha beta' })
    const deleted = await data.projects.create({ name: 'alpha 已删除' })
    await data.clients.create({ name: 'alpha 联系人', notes: '' })
    return deleted.id
  })
  await sql`UPDATE projects SET deleted_at='2026-11-15 00:00:00' WHERE id=${deletedId}`.execute(core.db)
  await core.transaction(dataContext(other), data => data.projects.create({ name: 'alpha 他人' }))
  operations = createGlobalSearchOperations(createKyselySqliteGlobalSearchSources(core.db))
  registry = createToolRegistry({ tools: [createGlobalSearchTool(operations)], authorize: async () => allowed })
})
afterEach(async () => { await core?.close(); if (folder) await rm(folder, { recursive: true, force: true }) })

it('真实注册器复用SQLite搜索，固定每类20条、过滤软删并隔离模型伪造owner，查询不改数据', async () => {
  const before = await sql`SELECT * FROM projects ORDER BY id`.execute(core.db)
  const result = value(await dispatch({ query: 'alpha', types: ['project'], owner_id: other, per_type: 200 }))
  expect(result.total).toBe(20)
  expect(result.groups[0]!.items.every(item => !item.title.includes('他人') && !item.title.includes('已删除'))).toBe(true)
  const foreign = value(await registry.tools.dispatch({ id: 'other', name: 'global_search', input: { query: 'alpha', types: ['project'] } },
    { ...scope(), identity: { ...identity(), ownerId: other } }))
  expect(foreign.groups[0]!.items.map(item => item.title)).toEqual(['alpha 他人'])
  expect(await sql`SELECT * FROM projects ORDER BY id`.execute(core.db)).toEqual(before)
})

it('queries覆盖单词串并归一去重，AND与旧q工作，无命中补Python提示', async () => {
  const result = value(await dispatch({ query: '不使用', queries: [' alpha ', 'ALPHA', 'beta'], mode: 'AND', types: ['project'] }))
  expect(result.queries).toEqual(['alpha', 'beta'])
  expect(result.mode).toBe('AND')
  expect(result.groups[0]!.items.map(item => item.title)).toEqual(['alpha beta'])
  expect(value(await dispatch({ q: 'alpha 联系人', types: ['client'] })).total).toBe(1)
  const empty = value(await dispatch({ query: '完全不存在', types: ['project'] }))
  expect(empty).toMatchObject({ total: 0, groups: [] })
  expect(empty.note).toContain('不搜文件内容')
})

it('缺词、非法枚举和缺少平台来源明确失败，不将缺后端伪装为空结果', async () => {
  const search = vi.spyOn(operations, 'search')
  for (const input of [{}, { queries: ['', '  '] }, { query: 'alpha', types: ['bogus'] }, { query: 'alpha', mode: 'invalid' }, { query: 'alpha', types: ['file'] }, { query: 'alpha' }])
    expect(await dispatch(input)).toMatchObject({ kind: 'completed', successful: false, mutated: false })
  expect(search).not.toHaveBeenCalled()
  expect(await dispatch({ query: 'alpha', types: ['file'] })).toMatchObject({ value: {
    error: '当前平台未提供所请求的搜索来源', unavailable_types: ['file'],
  } })
})

it('桌面默认查询所有可用来源，文件与文件夹只扫描一次', async () => {
  const host = vi.fn(async () => ({ groups: [
    { type: 'file', items: [{ id: '1', title: '样本.txt', path_file: { sandboxPath: '/personal/样本.txt' } }] },
    { type: 'folder', items: [{ id: '2', title: '样本目录' }] },
  ] }))
  registry = createToolRegistry({
    tools: [createGlobalSearchTool(createGlobalSearchOperations(createDesktopFileSearchSources(host)), true)],
    authorize: async () => true,
  })
  const result = value(await dispatch({ queries: ['样本', '资料'], mode: 'AND' }))
  expect(result.total).toBe(2)
  expect(host).toHaveBeenCalledExactlyOnceWith({ queries: ['样本', '资料'], mode: 'AND', perType: 20 }, expect.any(AbortSignal))
  expect(result.groups).toMatchObject([
    { source_type: 'file', items: [{ path_file: { sandboxPath: '/personal/样本.txt' } }] },
    { source_type: 'folder', items: [{ title: '样本目录' }] },
  ])
})

it('发现后撤权、预取消及查询中取消均不产生可用结果，SQL失败不泄漏内部错误', async () => {
  const search = vi.spyOn(operations, 'search')
  expect((await registry.capabilities(identity())).map(tool => tool.name)).toContain('global_search')
  allowed = false
  expect(await dispatch({ query: 'alpha', types: ['project'] })).toMatchObject({ successful: false, executed: false })
  expect(search).not.toHaveBeenCalled()
  allowed = true
  const controller = new AbortController(); controller.abort()
  await expect(registry.tools.dispatch({ id: 'cancel', name: 'global_search', input: { query: 'alpha', types: ['project'] } }, { ...scope(), signal: controller.signal })).rejects.toThrow()
  expect(search).not.toHaveBeenCalled()
  const pending = new AbortController()
  const original = operations.search.bind(operations)
  search.mockImplementationOnce(async (...args) => { const found = await original(...args); pending.abort(); return found })
  await expect(registry.tools.dispatch({ id: 'late', name: 'global_search', input: { query: 'alpha', types: ['project'] } }, { ...scope(), signal: pending.signal })).rejects.toThrow()
  await sql`DROP TABLE clients`.execute(core.db)
  const failed = await dispatch({ query: 'alpha', types: ['client'] })
  expect(failed).toMatchObject({ successful: false, value: { error: '工具执行失败' } })
  expect(JSON.stringify(failed)).not.toMatch(/no such table|SELECT|clients/)
})

it('Agent循环通过真实注册器和SQLite执行搜索，结果进入下一次Provider请求', async () => {
  const call = { id: 'search', name: 'global_search', input: { queries: ['alpha', 'beta'], mode: 'AND', types: ['project'] } }
  const f = fixture([[{ type: 'complete', text: '', calls: [call] }], [{ type: 'complete', text: '已定位项目', calls: [] }]])
  f.ports.tools = registry.tools
  f.ports.context.afterTool = async (context, _call, result) => [...context, JSON.stringify(value(result))]
  const result = await collect(f.harness.start(identity()))
  expect(result.state.status).toBe('completed')
  const requests = vi.mocked(f.ports.provider.stream).mock.calls
  expect(requests).toHaveLength(2)
  expect(requests[1]![0].context.join('\n')).toContain('alpha beta')
  expect(requests[1]![0].context.join('\n')).not.toContain('alpha 他人')
  expect(result.events.some(event => event.type === 'tool_done')).toBe(true)
})
