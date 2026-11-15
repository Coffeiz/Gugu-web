import { expect, it } from 'vitest'
import { createListTrashTool, type TrashListItem } from '../../../src/agent/tools/trash.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { collect, fixture } from '../run/fixtures.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'trash' }
const scope = () => ({ identity, signal: new AbortController().signal, roundId: '1', resolution: null,
  execute: async () => { throw new Error('只读工具不可执行进程') } })
const file = (id: number, time: string): TrashListItem => ({ id, file_id: id, kind: 'file', name: `合成文件${id}.txt`, space: 'personal', deleted_at: time })
const folder: TrashListItem = { id: 3, folder_id: 3, kind: 'folder', name: '合成目录', space: 'workspace', deleted_at: '2026-11-15T00:00:00.000002+00:00' }

it('真实注册器合并顶层文件与目录，保留微秒排序，满额即提示可能还有更多', async () => {
  const reads: number[] = []
  const registry = createToolRegistry({ tools: [createListTrashTool({ async list(current, limit) {
    expect(current.ownerId).toBe(identity.ownerId); reads.push(limit)
    return { files: [file(1, '2026-11-15T00:00:00.000001+00:00'), file(2, '2026-11-15T00:00:00.000000+00:00')].slice(0, limit), folders: [folder] }
  } })], authorize: async () => true })
  const result = await registry.tools.dispatch({ id: 'list', name: 'list_trash', input: { limit: 2, owner_id: '伪造' } }, scope())
  expect(result).toMatchObject({ successful: true, mutated: false, value: { items: [{ id: 3 }, { id: 1 }], note: '仅列出最近 2 个，可能还有更多；要清空整个回收站用 permanent_delete(all=true) 一次清，别逐个删。' } })
  expect(reads).toEqual([2])
  expect(await registry.tools.dispatch({ id: 'all', name: 'list_trash', input: {} }, scope())).toMatchObject({ value: [{ id: 3 }, { id: 1 }, { id: 2 }] })
})

it('旧limit参数保留Python整数转换与1到100夹取，非法值不调用后端', async () => {
  const limits: number[] = []
  const registry = createToolRegistry({ tools: [createListTrashTool({ async list(_identity, limit) { limits.push(limit); return { files: [], folders: [] } } })], authorize: async () => true })
  for (const [limit, expected] of [[undefined, 50], [true, 1], [false, 1], [-3, 1], [2.9, 2], ['１２', 12], ['+1_0', 10], ['9'.repeat(100), 100]] as const) {
    expect(await registry.tools.dispatch({ id: 'limit', name: 'list_trash', input: limit === undefined ? {} : { limit } }, scope())).toMatchObject({ successful: true, value: [] })
    expect(limits.at(-1)).toBe(expected)
  }
  const before = limits.length
  for (const limit of [null, '', '1.5', [], {}, '9'.repeat(4301)]) expect(await registry.tools.dispatch({ id: 'invalid', name: 'list_trash', input: { limit } }, scope())).toMatchObject({ successful: false })
  expect(limits).toHaveLength(before)
})

it('撤权、预取消与查询后取消拒绝发布结果，后端异常不泄漏凭据', async () => {
  let authorized = true, reads = 0
  const controller = new AbortController()
  const registry = createToolRegistry({ tools: [createListTrashTool({ async list() { reads++; controller.abort(); return { files: [], folders: [] } } })], authorize: async () => authorized })
  await registry.capabilities(identity); authorized = false
  expect(await registry.tools.dispatch({ id: 'denied', name: 'list_trash', input: {} }, scope())).toMatchObject({ successful: false, executed: false })
  expect(reads).toBe(0); authorized = true
  const cancelled = new AbortController(); cancelled.abort()
  await expect(registry.tools.dispatch({ id: 'pre', name: 'list_trash', input: {} }, { ...scope(), signal: cancelled.signal })).rejects.toThrow()
  expect(reads).toBe(0)
  await expect(registry.tools.dispatch({ id: 'during', name: 'list_trash', input: {} }, { ...scope(), signal: controller.signal })).rejects.toThrow()
  const failing = createToolRegistry({ tools: [createListTrashTool({ async list() { throw new Error('synthetic-private-database-error') } })], authorize: async () => true })
  expect(await failing.tools.dispatch({ id: 'failed', name: 'list_trash', input: {} }, scope())).toMatchObject({ successful: false, value: { error: '工具执行失败' } })
})

it('Agent循环执行只读回收站工具后继续Provider，工具结果进入上下文', async () => {
  const registry = createToolRegistry({ tools: [createListTrashTool({ async list() { return { files: [file(1, '2026-11-15T00:00:00+00:00')], folders: [] } } })], authorize: async () => true })
  const f = fixture([[{ type: 'complete', text: '', calls: [{ id: 'list', name: 'list_trash', input: {} }] }], [{ type: 'complete', text: '回收站结果', calls: [] }]])
  f.ports.tools = registry.tools
  f.ports.context.afterTool = async (context, _call, result) => [...context, result.kind === 'completed' ? JSON.stringify(result.value) : '未完成']
  const result = await collect(f.harness.start(identity))
  expect(result.state.status).toBe('completed')
  expect(result.state.context!.join('\n')).toContain('合成文件1.txt')
})
