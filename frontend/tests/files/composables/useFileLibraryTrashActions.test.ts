import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import { useFileLibraryTrashActions } from '@/composables/files/useFileLibraryTrashActions'
import { useLiveStore } from '@/stores/live'

const { confirmDialog, activeEmpty, getEmptyJob, startEmpty, showAppError, showAppSuccess } = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  activeEmpty: vi.fn(),
  getEmptyJob: vi.fn(),
  startEmpty: vi.fn(),
  showAppError: vi.fn(),
  showAppSuccess: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  trashApi: {
    list: vi.fn(),
    listFolders: vi.fn(),
    restore: vi.fn(),
    restoreFolder: vi.fn(),
    hardDelete: vi.fn(),
    hardDeleteFolder: vi.fn(),
    listFolderContents: vi.fn(),
    activeEmpty,
    getEmptyJob,
    startEmpty,
  },
}))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog }))
vi.mock('@/composables/core/useAppToast', () => ({ showAppError, showAppSuccess }))
vi.mock('@/composables/files/useFileDeleteConfirm', () => ({ confirmFileDeletion: vi.fn() }))

function mountActions() {
  const loadContents = vi.fn()
  const refreshCache = vi.fn().mockResolvedValue(undefined)
  const fetchStorage = vi.fn().mockResolvedValue(undefined)
  const pinia = createPinia()
  let actions!: ReturnType<typeof useFileLibraryTrashActions>
  const app = createApp({
    setup() {
      actions = useFileLibraryTrashActions({
        selectedFileIds: ref(new Set<number>()),
        selectedTrashFolderIds: ref(new Set<number>()),
        expandedTrashFolders: ref(new Set<number>()),
        trashFolderContents: ref({}),
        loadContents,
        clearSelection: vi.fn(),
        refreshCache,
        fetchStorage,
      })
      return () => h('div')
    },
  })
  app.use(i18n)
  app.use(pinia)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  return { actions, app, host, loadContents, refreshCache, fetchStorage, live: useLiveStore(pinia) }
}

describe('回收站后台清空任务', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    confirmDialog.mockResolvedValue(true)
    activeEmpty.mockResolvedValue(null)
  })

  it('重新进入页面时从服务端恢复正在运行的任务进度', async () => {
    activeEmpty.mockResolvedValue({
      id: 31, status: 'running', progressCurrent: 7, progressTotal: 20, failedCount: 0,
    })
    getEmptyJob.mockReturnValue(new Promise(() => {}))
    const mounted = mountActions()

    await vi.waitFor(() => expect(mounted.actions.emptyTrashProgress.value).toEqual({
      done: 7, total: 20, failed: 0,
    }))
    expect(mounted.actions.emptyTrashBusy.value).toBe(true)

    mounted.app.unmount()
    mounted.host.remove()
  })

  it('提交后台任务并在服务端报告完成后刷新回收站与存储用量', async () => {
    startEmpty.mockResolvedValue({
      id: 32, status: 'queued', progressCurrent: 0, progressTotal: 3, failedCount: 0,
    })
    getEmptyJob.mockResolvedValue({
      id: 32, status: 'completed', progressCurrent: 3, progressTotal: 3, failedCount: 0,
    })
    const mounted = mountActions()

    await mounted.actions.emptyTrash()
    await vi.waitFor(() => expect(showAppSuccess).toHaveBeenCalled())
    expect(startEmpty).toHaveBeenCalledOnce()
    expect(mounted.loadContents).toHaveBeenCalledOnce()
    expect(mounted.refreshCache).toHaveBeenCalledOnce()
    expect(mounted.fetchStorage).toHaveBeenCalledOnce()
    expect(mounted.actions.emptyTrashBusy.value).toBe(false)
    expect(mounted.actions.emptyTrashProgress.value).toBeNull()

    mounted.app.unmount()
    mounted.host.remove()
  })

  it('通过实时事件更新批次进度并在完成事件到达后结束任务', async () => {
    startEmpty.mockResolvedValue({
      id: 33, status: 'queued', progressCurrent: 0, progressTotal: 24, failedCount: 0,
    })
    getEmptyJob.mockResolvedValue({
      id: 33, status: 'running', progressCurrent: 0, progressTotal: 24, failedCount: 0,
    })
    const mounted = mountActions()

    await mounted.actions.emptyTrash()
    await vi.waitFor(() => expect(mounted.actions.emptyTrashBusy.value).toBe(true))
    mounted.live.trashPurgeEvent = {
      protocol_version: 'live-event-v1', event_id: 'evt-purge-progress',
      type: 'task.progress', task_type: 'trash_purge', task_id: 33,
      status: 'running', progress_current: 10, progress_total: 24,
      failed_count: 0, created_at: '2026-10-06T00:00:00Z', _t: 1,
    }
    await vi.waitFor(() => expect(mounted.actions.emptyTrashProgress.value?.done).toBe(10))
    expect(getEmptyJob).toHaveBeenCalledTimes(1)

    mounted.live.trashPurgeEvent = {
      protocol_version: 'live-event-v1', event_id: 'evt-purge-complete',
      type: 'task.progress', task_type: 'trash_purge', task_id: 33,
      status: 'completed', progress_current: 24, progress_total: 24,
      failed_count: 0, created_at: '2026-10-06T00:00:01Z', _t: 2,
    }
    await vi.waitFor(() => expect(mounted.actions.emptyTrashBusy.value).toBe(false))
    expect(showAppSuccess).toHaveBeenCalledOnce()

    mounted.app.unmount()
    mounted.host.remove()
  })
})
