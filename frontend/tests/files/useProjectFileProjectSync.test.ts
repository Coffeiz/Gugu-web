import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { filesApi, foldersApi } from '@/services/api'
import type { FolderMeta } from '@/stores/filesCache'
import { useProjectFileProjectSync } from '@/composables/files/useProjectFileProjectSync'
import type { Project } from '@/types/project'

vi.mock('@/services/api', () => ({
  filesApi: { list: vi.fn(), all: vi.fn() },
  foldersApi: { list: vi.fn(), all: vi.fn() },
}))

describe('项目文件目录按需加载', () => {
  let scope: EffectScope

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(filesApi.list).mockResolvedValue([] as never)
    vi.mocked(foldersApi.list).mockResolvedValue([] as never)
    scope = effectScope()
  })

  afterEach(() => scope.stop())

  it('首次打开项目只读项目根目录，进入子目录时按需读取且不调用全量接口', async () => {
    const project = ref({ id: 41 } as Project | null)
    const folderStack = ref<FolderMeta[]>([])
    const mergeDirectorySnapshot = vi.fn()
    let sync!: ReturnType<typeof useProjectFileProjectSync>

    scope.run(() => {
      sync = useProjectFileProjectSync({
        project: () => project.value,
        openFolders: ref(new Set<number>()),
        folderStack,
        resetNavigation: vi.fn(),
        showNewFolder: ref(false),
        resetDraft: vi.fn(),
        fileCacheStore: { loaded: false, mergeDirectorySnapshot },
      })
    })

    await vi.waitFor(() => expect(mergeDirectorySnapshot).toHaveBeenCalledOnce())
    expect(filesApi.list).toHaveBeenNthCalledWith(1, { space: 'project', projectId: 41, folderId: undefined })
    expect(foldersApi.list).toHaveBeenNthCalledWith(1, { projectId: 41, parentId: undefined })
    expect(sync.isDirectoryLoaded(41, null)).toBe(true)

    await Promise.all([
      sync.ensureDirectoryLoaded(41, 93),
      sync.ensureDirectoryLoaded(41, 93),
    ])

    expect(filesApi.list).toHaveBeenCalledTimes(2)
    expect(filesApi.list).toHaveBeenNthCalledWith(2, { space: 'project', projectId: 41, folderId: 93 })
    expect(foldersApi.list).toHaveBeenNthCalledWith(2, { projectId: 41, parentId: 93 })
    expect(sync.isDirectoryLoaded(41, 93)).toBe(true)
    expect(filesApi.all).not.toHaveBeenCalled()
    expect(foldersApi.all).not.toHaveBeenCalled()
    expect(mergeDirectorySnapshot).toHaveBeenCalledTimes(2)
  })

  it('项目全量缓存已就绪时不重复请求目录', async () => {
    const mergeDirectorySnapshot = vi.fn()
    let sync!: ReturnType<typeof useProjectFileProjectSync>
    scope.run(() => {
      sync = useProjectFileProjectSync({
        project: () => null,
        openFolders: ref(new Set<number>()),
        folderStack: ref<FolderMeta[]>([]),
        resetNavigation: vi.fn(),
        showNewFolder: ref(false),
        resetDraft: vi.fn(),
        fileCacheStore: { loaded: true, mergeDirectorySnapshot },
      })
    })

    await sync.ensureDirectoryLoaded(41)
    expect(filesApi.list).not.toHaveBeenCalled()
    expect(foldersApi.list).not.toHaveBeenCalled()
    expect(mergeDirectorySnapshot).not.toHaveBeenCalled()
  })
})
