import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileMeta } from '@/stores/filesCache'
import { useFileLibraryRename } from './useFileLibraryRename'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))

vi.mock('@/interaction/sync/InteractionSync', () => ({
  InteractionSync: { execute },
}))

function createFile(ext: string): FileMeta {
  return { id: 7, displayName: 'notes', ext, version: 3 } as FileMeta
}

function createRename(file: FileMeta, onInvalidExtension = vi.fn()) {
  const files = new Map([[file.id, file]])
  const renameFile = vi.fn().mockResolvedValue(undefined)
  const updateFile = vi.fn((id: number, patch: Partial<FileMeta>) => {
    const current = files.get(id)
    if (current) Object.assign(current, patch)
  })
  const rename = useFileLibraryRename({
    getFile: id => files.get(id),
    getFolder: () => undefined,
    updateFile,
    updateFolder: vi.fn(),
    renameFile,
    renameFolder: vi.fn(),
    reload: vi.fn(),
    onInvalidExtension,
  })
  return { rename, renameFile, updateFile, onInvalidExtension }
}

describe('文件库分段重命名', () => {
  beforeEach(() => {
    execute.mockReset()
    execute.mockImplementation(async (policy: {
      apply: () => void
      request: (meta: { mutationId: string }) => Promise<unknown>
    }) => {
      policy.apply()
      return policy.request({ mutationId: 'mutation-1' })
    })
  })

  it('一次重命名同时提交文件名与标准化后的后缀', async () => {
    const file = createFile('TXT')
    const { rename, renameFile, updateFile } = createRename(file)
    rename.startFile(file)
    rename.renameText.value = 'readme'
    rename.renameExtension.value = ' md '

    await rename.commit()

    expect(renameFile).toHaveBeenCalledWith(7, 'readme', 'MD', { mutationId: 'mutation-1' })
    expect(updateFile).toHaveBeenCalledWith(7, { displayName: 'readme', ext: 'MD' })
  })

  it('无后缀文件保持 FILE 哨兵且仍可单独重命名', async () => {
    const file = createFile('FILE')
    const { rename, renameFile } = createRename(file)
    rename.startFile(file)
    rename.renameText.value = 'README'

    await rename.commit()

    expect(renameFile).toHaveBeenCalledWith(7, 'README', undefined, { mutationId: 'mutation-1' })
  })

  it('已有后缀被清空时保留编辑状态并拒绝提交', async () => {
    const file = createFile('TXT')
    const { rename, renameFile, updateFile, onInvalidExtension } = createRename(file)
    rename.startFile(file)
    rename.renameText.value = 'readme'
    rename.renameExtension.value = ''

    await rename.commit()

    expect(onInvalidExtension).toHaveBeenCalledOnce()
    expect(rename.renamingFileId.value).toBe(file.id)
    expect(renameFile).not.toHaveBeenCalled()
    expect(updateFile).not.toHaveBeenCalled()
  })
})
