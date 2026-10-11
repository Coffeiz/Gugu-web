import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { FileMeta } from '@/stores/filesCache'
import { useFileLibraryFileActions } from '@/composables/files/useFileLibraryFileActions'

vi.mock('vue-i18n', async importOriginal => ({
  ...await importOriginal<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/composables/files/useFileDeleteConfirm', () => ({
  confirmFileDeletion: vi.fn().mockResolvedValue(true),
}))

const file = { id: 18, displayName: '刚复制的文件', ext: 'txt' } as FileMeta

describe('文件库删除后的视图同步', () => {
  beforeEach(() => vi.clearAllMocks())

  it('服务端确认删除前保持卡片与选择状态，成功后再同步目录', async () => {
    const loadContents = vi.fn()
    const removeFilesFromSnapshots = vi.fn()
    const fetchStorage = vi.fn()
    const cacheStore = {
      getFile: vi.fn(() => file),
      removeFile: vi.fn(),
      addFile: vi.fn(),
    }
    let resolveDelete!: () => void
    const fileActions = { deleteFile: vi.fn(() => new Promise<void>(resolve => { resolveDelete = resolve })) }
    const selectedIds = ref(new Set([file.id]))
    const actions = useFileLibraryFileActions({
      cacheStore: cacheStore as never,
      fileActions: fileActions as never,
      selectedIds,
      loadContents,
      removeFilesFromSnapshots,
      fetchStorage,
    })

    const deletion = actions.deleteSingleFile(file)
    await vi.waitFor(() => expect(fileActions.deleteFile).toHaveBeenCalledOnce())

    expect(cacheStore.removeFile).not.toHaveBeenCalled()
    expect(removeFilesFromSnapshots).not.toHaveBeenCalled()
    expect(loadContents).not.toHaveBeenCalled()
    expect(fetchStorage).not.toHaveBeenCalled()
    expect(selectedIds.value).toEqual(new Set([file.id]))

    resolveDelete()
    await deletion

    expect(cacheStore.removeFile).toHaveBeenCalledWith(file.id)
    expect(removeFilesFromSnapshots).toHaveBeenCalledWith([file.id])
    expect(fileActions.deleteFile).toHaveBeenCalledWith(file.id, expect.objectContaining({ mutationId: expect.any(String) }))
    expect(loadContents).toHaveBeenCalledOnce()
    expect(fetchStorage).toHaveBeenCalledOnce()
    expect(selectedIds.value).toEqual(new Set())
  })
})
