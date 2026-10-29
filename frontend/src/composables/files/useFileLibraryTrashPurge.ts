import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { TrashPurgeJob } from '@/services/api'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { showAppError, showAppSuccess } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'
import { useLiveStore } from '@/stores/live'

export interface TrashPurgeApi {
  startEmpty: () => Promise<TrashPurgeJob>
  activeEmpty: () => Promise<TrashPurgeJob | null>
  getEmptyJob: (id: number) => Promise<TrashPurgeJob>
}

export interface EmptyTrashProgress {
  done: number
  total: number
  failed: number
}

interface TrashPurgeOptions {
  api: TrashPurgeApi
  loadContents: () => void
  refreshCache: () => void | Promise<void | boolean>
  fetchStorage: () => void | Promise<void>
}

interface PurgeController {
  options: TrashPurgeOptions
  busy: Ref<boolean>
  progress: Ref<EmptyTrashProgress | null>
  mounted: boolean
  jobId: number | null
  finishedJobId: number | null
  requestVersion: number
  latestEvent: ReturnType<typeof useLiveStore>['trashPurgeEvent']
  lastRefreshedProgress: number
  lastListRefreshAt: number
  listRefreshTimer: ReturnType<typeof setTimeout> | null
}

const LIST_REFRESH_INTERVAL_MS = 1000

function clearListRefreshTimer(controller: PurgeController) {
  if (controller.listRefreshTimer !== null) {
    clearTimeout(controller.listRefreshTimer)
    controller.listRefreshTimer = null
  }
}

function refreshTrashList(controller: PurgeController, progress: number) {
  if (progress <= controller.lastRefreshedProgress) return
  const elapsed = Date.now() - controller.lastListRefreshAt
  if (elapsed >= LIST_REFRESH_INTERVAL_MS) {
    controller.lastRefreshedProgress = progress
    controller.lastListRefreshAt = Date.now()
    controller.options.loadContents()
    return
  }
  if (controller.listRefreshTimer !== null) return
  controller.listRefreshTimer = setTimeout(() => {
    controller.listRefreshTimer = null
    if (!controller.mounted || controller.jobId === null) return
    controller.lastRefreshedProgress = controller.progress.value?.done ?? progress
    controller.lastListRefreshAt = Date.now()
    controller.options.loadContents()
  }, LIST_REFRESH_INTERVAL_MS - elapsed)
}

function acceptJob(controller: PurgeController, job: TrashPurgeJob) {
  const active = job.status === 'queued' || job.status === 'running'
  if (controller.jobId === job.id && active
    && controller.progress.value && job.progressCurrent < controller.progress.value.done) return
  if (controller.jobId !== job.id) controller.finishedJobId = null
  controller.jobId = active ? job.id : null
  controller.progress.value = {
    done: job.progressCurrent,
    total: job.progressTotal,
    failed: job.failedCount,
  }
  controller.busy.value = job.status === 'queued' || job.status === 'running'
}

async function finish(controller: PurgeController, job: TrashPurgeJob) {
  if (controller.finishedJobId === job.id) return
  clearListRefreshTimer(controller)
  controller.finishedJobId = job.id
  controller.jobId = null
  controller.busy.value = false
  controller.progress.value = null
  controller.options.loadContents()
  await Promise.all([controller.options.refreshCache(), controller.options.fetchStorage()])
  if (job.status === 'failed' || job.failedCount > 0) {
    showAppError(i18n.global.t('filesViewUi.emptyTrashPartial', { failed: Math.max(1, job.failedCount) }))
  } else if (job.progressTotal > 0) {
    showAppSuccess(i18n.global.t('filesViewUi.emptyTrashComplete', { count: job.progressTotal }))
  }
}

async function syncJob(controller: PurgeController, jobId: number) {
  if (!controller.mounted || controller.jobId !== jobId) return
  try {
    const job = await controller.options.api.getEmptyJob(jobId)
    if (!controller.mounted || controller.jobId !== jobId) return
    await applySnapshot(controller, job)
  } catch (error) {
    console.error('[Files] 获取回收站清理进度失败:', error instanceof Error ? error.message : String(error))
  }
}

async function applySnapshot(controller: PurgeController, job: TrashPurgeJob) {
  if (controller.finishedJobId === job.id) return
  acceptJob(controller, job)
  // HTTP 返回前事件可能已到达；登记任务后立即消费，避免丢失快速任务终态。
  await applyProgressEvent(controller, controller.latestEvent)
  if (controller.finishedJobId === job.id) return
  if (job.status === 'completed' || job.status === 'failed') await finish(controller, job)
}

async function applyProgressEvent(controller: PurgeController, event: ReturnType<typeof useLiveStore>['trashPurgeEvent']) {
  if (!event) return
  controller.latestEvent = event
  if (event.task_id !== controller.jobId) return
  const job: TrashPurgeJob = {
    id: event.task_id,
    status: event.status,
    progressCurrent: event.progress_current,
    progressTotal: event.progress_total,
    failedCount: event.failed_count,
  }
  acceptJob(controller, job)
  if (job.status === 'running') refreshTrashList(controller, job.progressCurrent)
  if (job.status === 'completed' || job.status === 'failed') {
    await finish(controller, job)
  }
}

async function resume(controller: PurgeController) {
  const version = controller.requestVersion
  try {
    const job = await controller.options.api.activeEmpty()
    if (!job || !controller.mounted || version !== controller.requestVersion) return
    if (controller.jobId !== null && controller.jobId !== job.id) return
    await applySnapshot(controller, job)
    if (controller.jobId !== null) void syncJob(controller, job.id)
  } catch (error) {
    console.error('[Files] 恢复回收站清理进度失败:', error instanceof Error ? error.message : String(error))
  }
}

async function empty(controller: PurgeController) {
  if (!await confirmDialog({
    title: i18n.global.t('filesViewUi.emptyTrashTitle'),
    message: i18n.global.t('filesViewUi.emptyTrashMessage'),
    tone: 'danger',
    confirmText: i18n.global.t('filesViewUi.permanentDelete'),
  })) return
  try {
    ++controller.requestVersion
    const job = await controller.options.api.startEmpty()
    if (!controller.mounted) return
    await applySnapshot(controller, job)
    if (controller.jobId !== null) void syncJob(controller, job.id)
  } catch (error) {
    console.error('[Files] 清空回收站失败:', error instanceof Error ? error.message : String(error))
    showAppError(i18n.global.t('filesViewUi.emptyTrashFailed'))
  }
}

export function useFileLibraryTrashPurge(options: TrashPurgeOptions) {
  const live = useLiveStore()
  const controller: PurgeController = {
    options,
    busy: ref(false),
    progress: ref(null),
    mounted: false,
    jobId: null,
    finishedJobId: null,
    latestEvent: null,
    requestVersion: 0,
    lastRefreshedProgress: -1,
    lastListRefreshAt: 0,
    listRefreshTimer: null,
  }
  watch(() => live.trashPurgeEvent, event => applyProgressEvent(controller, event), { immediate: true, flush: 'sync' })
  watch(() => live.connected, (connected, wasConnected) => {
    if (connected && !wasConnected && controller.jobId !== null) {
      void syncJob(controller, controller.jobId)
    }
  })
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && controller.jobId !== null) {
      void syncJob(controller, controller.jobId)
    }
  }
  onMounted(() => {
    controller.mounted = true
    document.addEventListener('visibilitychange', onVisibilityChange)
    void resume(controller)
  })
  onBeforeUnmount(() => {
    controller.mounted = false
    clearListRefreshTimer(controller)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  return {
    empty: () => empty(controller),
    busy: controller.busy,
    progress: controller.progress,
  }
}
