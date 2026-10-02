import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileLibraryTrashActions } from './useFileLibraryTrashActions'

const { confirmDialog, hardDelete, list, listFolders, showAppError, showAppSuccess } = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  hardDelete: vi.fn(),
  list: vi.fn(),
  listFolders: vi.fn(),
  showAppError: vi.fn(),
  showAppSuccess: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  trashApi: { list, listFolders, hardDelete, hardDeleteFolder: vi.fn() },
}))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog }))
vi.mock('@/composables/core/useAppToast', () => ({ showAppError, showAppSuccess }))
vi.mock('./useFileDeleteConfirm', () => ({ confirmFileDeletion: vi.fn() }))

describe('回收站批量清空进度', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    confirmDialog.mockResolvedValue(true)
    list.mockResolvedValue([{ id: 17 }])
    listFolders.mockResolvedValue([])
  })

  it('清空期间显示进度，完成后移除进度条状态', async () => {
    let resolveDelete!: () => void
    hardDelete.mockReturnValue(new Promise<void>(resolve => { resolveDelete = resolve }))
    // 首次读取回收站有一项，复查时为空。
    list.mockResolvedValueOnce([{ id: 17 }]).mockResolvedValueOnce([])
    const actions = useFileLibraryTrashActions({
      selectedFileIds: ref(new Set<number>()),
      selectedTrashFolderIds: ref(new Set<number>()),
      expandedTrashFolders: ref(new Set<number>()),
      trashFolderContents: ref({}),
      loadContents: vi.fn(),
      clearSelection: vi.fn(),
      refreshCache: vi.fn(),
      fetchStorage: vi.fn(),
    })

    const clearing = actions.emptyTrash()
    await vi.waitFor(() => expect(actions.emptyTrashProgress.value).toEqual({ done: 0, total: 1, failed: 0 }))
    expect(actions.emptyTrashBusy.value).toBe(true)

    resolveDelete()
    await clearing

    expect(actions.emptyTrashBusy.value).toBe(false)
    expect(actions.emptyTrashProgress.value).toBeNull()
  })
})
