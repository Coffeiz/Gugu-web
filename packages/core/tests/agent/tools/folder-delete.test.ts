import { expect, it, vi } from 'vitest'
import { createDeleteFolderTool, type FileFolderDeletePort } from '../../../src/agent/tools/files.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '33', runId: 'folder-delete-run' }
const scope = { identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
  execute: async () => { throw new Error('文件夹工具不得执行宿主进程') } }
const port: FileFolderDeletePort = { remove: vi.fn(async (_identity, folderId) => ({ success: true, deleted_folder_id: folderId,
  note: '已移入回收站', _file_op: { op: 'remove', kind: 'folder', id: folderId } })) }
const registry = createToolRegistry({ groups: [{ id: 'files', name: '文件', tools: [createDeleteFolderTool(port)] }], authorize: async () => true })
const call = (input: unknown, id = 'delete') => registry.tools.dispatch({ id, name: 'delete_folder', input }, scope)

it('注册器将稳定 folder_id 交给 Host 软删除并返回可撤销的回收站结果', async () => {
  const result = await call({ folder_id: 42 })
  expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: true,
    value: { success: true, deleted_folder_id: 42, _file_op: { kind: 'folder', id: 42 } } })
  expect(port.remove).toHaveBeenCalledWith(identity, 42, scope.roundId, expect.objectContaining({ id: 'delete', name: 'delete_folder' }), expect.any(AbortSignal))
})

it('拒绝非正数、名字定位和批量参数，防止绕过明确 ID 与原子批量缺口', async () => {
  port.remove.mockClear()
  for (const input of [{ folder_id: 0 }, { folder_id: 42, folder_ids: [42] }, { folder_name: '目录' }, { folder_ids: [42] }])
    expect(await call(input)).toMatchObject({ kind: 'completed', successful: false })
  expect(port.remove).toHaveBeenCalledTimes(0)
})

it('提交结果未知时保留 unknown，等待 Host 收据恢复', async () => {
  port.remove.mockResolvedValue({ kind: 'unknown' })
  expect(await call({ folder_id: 42 }, 'uncertain')).toEqual({ kind: 'unknown' })
})
