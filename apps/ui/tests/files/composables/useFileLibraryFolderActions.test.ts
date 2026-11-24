import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useFileLibraryFolderActions } from '@/composables/files/useFileLibraryFolderActions'
import type { PathFileRef } from '@/services/api'

const createFolder = vi.fn().mockResolvedValue(undefined)
vi.mock('@/composables/files/useFileDeleteConfirm', () => ({ confirmFileDeletion: vi.fn() }))
vi.mock('@/services/pathFileAccess', () => ({ usePathFileAccess: () => ({ createFolder }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/composables/core/useAppToast', () => ({ errorMessage: String, showAppError: vi.fn() }))

describe('文件夹路径创建', () => {
  it('向当前路径创建并刷新，不发送旧目录标识', async () => {
    const reload = vi.fn()
    const actions = useFileLibraryFolderActions({ pathTarget: ref<PathFileRef | null>({ directoryId: 'personal', relativePath: '已有目录' }),
      cacheStore: {} as never, fileActions: {} as never, loadContents: vi.fn(), fetchStorage: vi.fn(),
      pruneHistoryForFolders: vi.fn(), reloadWorkspace: reload })
    actions.newFolderName.value = '新目录'
    await actions.createFolder()
    expect(createFolder).toHaveBeenCalledWith({ directoryId: 'personal', relativePath: '已有目录/新目录' })
    expect(reload).toHaveBeenCalledOnce()
    expect(actions.newFolderName.value).toBe('')
  })
  it('没有路径目标时不创建文件夹', async () => {
    createFolder.mockClear()
    const actions = useFileLibraryFolderActions({ pathTarget: ref<PathFileRef | null>(null),
      cacheStore: {} as never, fileActions: {} as never, loadContents: vi.fn(), fetchStorage: vi.fn(), pruneHistoryForFolders: vi.fn() })
    actions.newFolderName.value = '新目录'
    await actions.createFolder()
    expect(createFolder).not.toHaveBeenCalled()
  })
})
