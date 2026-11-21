import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { filesApi, foldersApi, type CursorPage } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import type { DirectoryPageState, FileMeta, FolderMeta } from '@/stores/filesCache'
import { useProjectFileProjectSync } from '@/composables/files/useProjectFileProjectSync'
import type { Project } from '@/types/project'

vi.mock('@/services/api', () => ({
  filesApi: { page: vi.fn() },
  foldersApi: { page: vi.fn() },
}))
vi.mock('@/stores/live', async () => {
  const { reactive } = await import('vue')
  const live = reactive({ rev: { files: 0 } })
  return { useLiveStore: () => live }
})

const cursorPage = <T>(items: T[]): CursorPage<T> => ({ items, next_cursor: null, has_more: false })

describe('项目文件目录按需分页', () => {
  let scope: EffectScope
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(filesApi.page).mockResolvedValue(cursorPage<FileMeta>([]) as never)
    vi.mocked(foldersApi.page).mockResolvedValue(cursorPage<FolderMeta>([]) as never)
    useLiveStore().rev.files = 0
    scope = effectScope()
  })
  afterEach(() => scope.stop())

  it('打开项目只读根目录页，进入子目录时按需读取，并合并重复导航请求', async () => {
    const project = ref({ id: 41 } as Project | null)
    const folderStack = ref<FolderMeta[]>([])
    const setDirectoryPage = vi.fn()
    const getDirectory = vi.fn(() => null as DirectoryPageState | null)
    let sync!: ReturnType<typeof useProjectFileProjectSync>
    scope.run(() => {
      sync = useProjectFileProjectSync({
        project: () => project.value, openFolders: ref(new Set<number>()), folderStack,
        resetNavigation: vi.fn(), showNewFolder: ref(false), resetDraft: vi.fn(),
        sortBy: () => 'createdAt', sortOrder: () => 'desc',
        fileCacheStore: { getDirectory, setDirectoryPage, invalidatePages: vi.fn() },
      })
    })
    await vi.waitFor(() => expect(setDirectoryPage).toHaveBeenCalledOnce())
    expect(filesApi.page).toHaveBeenNthCalledWith(1, { space: 'project', projectId: 41, folderId: undefined, sortBy: 'createdAt', sortOrder: 'desc' })
    expect(foldersApi.page).toHaveBeenNthCalledWith(1, { projectId: 41, parentId: undefined, sortBy: 'createdAt', sortOrder: 'desc' })
    expect(sync.isDirectoryLoaded(41, null)).toBe(true)

    await Promise.all([sync.ensureDirectoryLoaded(41, 93), sync.ensureDirectoryLoaded(41, 93)])
    expect(filesApi.page).toHaveBeenCalledTimes(2)
    expect(filesApi.page).toHaveBeenNthCalledWith(2, { space: 'project', projectId: 41, folderId: 93, sortBy: 'createdAt', sortOrder: 'desc' })
    expect(foldersApi.page).toHaveBeenNthCalledWith(2, { projectId: 41, parentId: 93, sortBy: 'createdAt', sortOrder: 'desc' })
    expect(sync.isDirectoryLoaded(41, 93)).toBe(true)
    expect(setDirectoryPage).toHaveBeenCalledTimes(2)
  })

  it('目录页缓存命中时不重复请求', async () => {
    const cached = { files: [], folders: [], fileCursor: null, folderCursor: null, fileHasMore: false, folderHasMore: false }
    const setDirectoryPage = vi.fn()
    const getDirectory = vi.fn(() => cached)
    let sync!: ReturnType<typeof useProjectFileProjectSync>
    scope.run(() => {
      sync = useProjectFileProjectSync({
        project: () => null, openFolders: ref(new Set<number>()), folderStack: ref<FolderMeta[]>([]),
        resetNavigation: vi.fn(), showNewFolder: ref(false), resetDraft: vi.fn(),
        sortBy: () => 'createdAt', sortOrder: () => 'desc',
        fileCacheStore: { getDirectory, setDirectoryPage, invalidatePages: vi.fn() },
      })
    })
    await sync.ensureDirectoryLoaded(41)
    expect(getDirectory).toHaveBeenCalledWith({ space: 'project', projectId: 41, sortBy: 'createdAt', sortOrder: 'desc' })
    expect(filesApi.page).not.toHaveBeenCalled()
    expect(foldersApi.page).not.toHaveBeenCalled()
    expect(setDirectoryPage).not.toHaveBeenCalled()
  })

  it('项目弹窗打开时文件版本变化会刷新当前目录', async () => {
    const project = ref({ id: 41 } as Project | null)
    const setDirectoryPage = vi.fn()
    const getDirectory = vi.fn(() => null as DirectoryPageState | null)
    const invalidatePages = vi.fn()
    scope.run(() => {
      useProjectFileProjectSync({
        project: () => project.value, openFolders: ref(new Set<number>()), folderStack: ref<FolderMeta[]>([]),
        resetNavigation: vi.fn(), showNewFolder: ref(false), resetDraft: vi.fn(),
        sortBy: () => 'createdAt', sortOrder: () => 'desc',
        fileCacheStore: { getDirectory, setDirectoryPage, invalidatePages },
      })
    })
    await vi.waitFor(() => expect(setDirectoryPage).toHaveBeenCalledOnce())

    useLiveStore().rev.files++

    await vi.waitFor(() => expect(setDirectoryPage).toHaveBeenCalledTimes(2), { timeout: 1000 })
    expect(invalidatePages).toHaveBeenCalledWith({ space: 'project', projectId: 41, sortBy: 'createdAt', sortOrder: 'desc' })
    expect(filesApi.page).toHaveBeenCalledTimes(2)
    expect(foldersApi.page).toHaveBeenCalledTimes(2)
  })

  it('目录请求进行中收到文件变更时丢弃旧结果并重新读取', async () => {
    const project = ref({ id: 41 } as Project | null)
    let resolveInitialFiles!: (page: CursorPage<FileMeta>) => void
    let resolveInitialFolders!: (page: CursorPage<FolderMeta>) => void
    const staleFile = { id: 1, name: '旧快照' } as FileMeta
    const freshFile = { id: 2, name: '新快照' } as FileMeta
    vi.mocked(filesApi.page).mockResolvedValue(cursorPage([freshFile]) as never)
    vi.mocked(foldersApi.page).mockResolvedValue(cursorPage<FolderMeta>([]) as never)
    vi.mocked(filesApi.page).mockImplementationOnce(() => new Promise(resolve => {
      resolveInitialFiles = resolve as (page: CursorPage<FileMeta>) => void
    }) as never)
    vi.mocked(foldersApi.page).mockImplementationOnce(() => new Promise(resolve => {
      resolveInitialFolders = resolve as (page: CursorPage<FolderMeta>) => void
    }) as never)
    const setDirectoryPage = vi.fn()
    let sync!: ReturnType<typeof useProjectFileProjectSync>
    scope.run(() => {
      sync = useProjectFileProjectSync({
        project: () => project.value, openFolders: ref(new Set<number>()), folderStack: ref<FolderMeta[]>([]),
        resetNavigation: vi.fn(), showNewFolder: ref(false), resetDraft: vi.fn(),
        sortBy: () => 'createdAt', sortOrder: () => 'desc',
        fileCacheStore: { getDirectory: () => null, setDirectoryPage, invalidatePages: vi.fn() },
      })
    })
    await vi.waitFor(() => expect(filesApi.page).toHaveBeenCalledOnce())

    useLiveStore().rev.files++
    await new Promise(resolve => setTimeout(resolve, 200))
    resolveInitialFiles(cursorPage([staleFile]) as CursorPage<FileMeta>)
    resolveInitialFolders(cursorPage<FolderMeta>([]))

    await vi.waitFor(() => expect(setDirectoryPage).toHaveBeenCalledOnce())
    expect(filesApi.page).toHaveBeenCalledTimes(2)
    const [loadedScope, loadedFiles, loadedFolders] = setDirectoryPage.mock.calls[0]
    expect(loadedScope).toEqual({ space: 'project', projectId: 41, sortBy: 'createdAt', sortOrder: 'desc' })
    expect(loadedFiles.items).toEqual([freshFile])
    expect(loadedFolders.items).toEqual([])
    expect(sync.isDirectoryLoaded(41, null)).toBe(true)
  })
})
