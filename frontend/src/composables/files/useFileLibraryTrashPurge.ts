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
  refreshCache: () => void | Promise<void>
  fetchStorage: () => void | Promise<void>
}

interface PurgeController {
  options: TrashPurgeOptions
  busy: Ref<boolean>
  progress: Ref<EmptyTrashProgress | null>
  mounted: boolean
  jobId: number | null
  finishedJobId: number | null
  recoveryTimer: ReturnType<typeof setTimeout> | null
}

const RECOVERY_SYNC_MS = 30_000

function stopRecoverySync(controller: PurgeController) {
  if (controller.recoveryTimer !== null) clearTimeout(controller.recoveryTimer)
  controller.recoveryTimer = null
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
  controller.finishedJobId = job.id
  controller.jobId = null
  stopRecoverySync(controller)
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
    acceptJob(controller, job)
    if (job.status === 'completed' || job.status === 'failed') {
      await finish(controller, job)
      return
    }
  } catch (error) {
    console.error('[Files] 获取回收站清理进度失败:', error instanceof Error ? error.message : String(error))
  }
  scheduleRecoverySync(controller)
}

function scheduleRecoverySync(controller: PurgeController) {
  stopRecoverySync(controller)
  if (!controller.mounted || controller.jobId === null) return
  controller.recoveryTimer = setTimeout(
    () => void syncJob(controller, controller.jobId!), RECOVERY_SYNC_MS,
  )
}

function applyProgressEvent(controller: PurgeController, event: ReturnType<typeof useLiveStore>['trashPurgeEvent']) {
  if (!event || event.task_id !== controller.jobId) return
  const job: TrashPurgeJob = {
    id: event.task_id,
    status: event.status,
    progressCurrent: event.progress_current,
    progressTotal: event.progress_total,
    failedCount: event.failed_count,
  }
  acceptJob(controller, job)
  if (job.status === 'completed' || job.status === 'failed') {
    void finish(controller, job)
  } else {
    scheduleRecoverySync(controller)
  }
}

async function resume(controller: PurgeController) {
  try {
    const job = await controller.options.api.activeEmpty()
    if (!job || !controller.mounted) return
    acceptJob(controller, job)
    if (controller.jobId !== null) void syncJob(controller, job.id)
    else if (job.status === 'completed' || job.status === 'failed') await finish(controller, job)
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
    const job = await controller.options.api.startEmpty()
    acceptJob(controller, job)
    if (job.status === 'completed' || job.status === 'failed') await finish(controller, job)
    else void syncJob(controller, job.id)
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
    recoveryTimer: null,
  }
  watch(() => live.trashPurgeEvent, event => applyProgressEvent(controller, event), { immediate: true })
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
    document.removeEventListener('visibilitychange', onVisibilityChange)
    stopRecoverySync(controller)
  })

  return {
    empty: () => empty(controller),
    busy: controller.busy,
    progress: controller.progress,
  }
}
