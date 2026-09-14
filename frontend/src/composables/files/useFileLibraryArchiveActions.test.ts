import { createApp, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import type { FileMeta } from '@/stores/filesCache'
import { useFileLibraryArchiveActions } from './useFileLibraryArchiveActions'

const { unarchive, showAppError } = vi.hoisted(() => ({
  unarchive: vi.fn(),
  showAppError: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  filesApi: {
    archive: vi.fn(),
    unarchive,
  },
}))

vi.mock('@/composables/core/useAppToast', () => ({
  errorMessage: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
  showAppError,
}))

function mountActions() {
  const archive = {
    id: 42,
    displayName: '素材',
    ext: 'zip',
    space: 'personal',
    projectId: null,
    workspaceDirectoryId: null,
  } as FileMeta
  const removeGhost = vi.fn()
  const createExtractionGhost = vi.fn(() => removeGhost)
  const refresh = vi.fn().mockResolvedValue(undefined)
  let actions!: ReturnType<typeof useFileLibraryArchiveActions>
  const app = createApp({
    setup() {
      actions = useFileLibraryArchiveActions({
        cacheStore: {
          getFile: () => archive,
          getFolder: () => null,
          addFile: vi.fn(),
          refresh,
        },
        selectedFileIds: ref(new Set<number>()),
        selectedFolderKeys: ref(new Set<number | string>()),
        getVisibleFolders: () => [],
        clearSelection: vi.fn(),
        createExtractionGhost,
      })
      return () => h('div')
    },
  })
  app.use(i18n)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  return { actions, archive, app, host, createExtractionGhost, refresh, removeGhost }
}

describe('文件库归档操作', () => {
  beforeEach(() => {
    unarchive.mockReset()
    showAppError.mockReset()
  })

  it('提交解压后立即关闭弹窗，以文件夹 ghost 表示进行中并在刷新后移除', async () => {
    let resolveUnarchive!: (value: unknown) => void
    unarchive.mockReturnValue(new Promise(resolve => { resolveUnarchive = resolve }))
    const mounted = mountActions()
    mounted.actions.extractFile(mounted.archive)

    const submission = mounted.actions.submit({ name: '解压结果' })
    expect(mounted.actions.dialogOpen.value).toBe(false)
    expect(mounted.actions.success.value).toBe('')
    expect(unarchive).toHaveBeenCalledWith({ fileId: 42, folderName: '解压结果', format: 'zip' })
    expect(mounted.createExtractionGhost).toHaveBeenCalledWith('解压结果')

    resolveUnarchive({ file_count: 11, folder_count: 1, skipped_count: 0 })
    await submission
    expect(mounted.refresh).toHaveBeenCalledOnce()
    expect(mounted.removeGhost).toHaveBeenCalledOnce()
    expect(showAppError).not.toHaveBeenCalled()

    mounted.app.unmount()
    mounted.host.remove()
  })

  it('解压失败时关闭弹窗、移除 ghost 并通过应用提示显示错误', async () => {
    unarchive.mockRejectedValue(new Error('解压失败'))
    const mounted = mountActions()
    mounted.actions.extractFile(mounted.archive)

    await mounted.actions.submit({ name: '解压结果' })
    expect(mounted.actions.dialogOpen.value).toBe(false)
    expect(mounted.removeGhost).toHaveBeenCalledOnce()
    expect(showAppError).toHaveBeenCalledWith('解压失败')

    mounted.app.unmount()
    mounted.host.remove()
  })
})
