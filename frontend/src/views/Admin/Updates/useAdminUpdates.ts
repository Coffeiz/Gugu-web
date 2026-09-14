import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  adminUpdateService,
  type RollbackPreflight,
  type UpdateCheck,
  type UpdatePreflight,
  type UpdateStatus,
} from '@/services/adminUpdate'

const activeStatuses = new Set(['pending', 'prechecking', 'backing_up', 'pulling', 'migrating', 'recreating', 'health_checking', 'rolling_back'])

export function useAdminUpdates() {
  const status = ref<UpdateStatus | null>(null)
  const checkResult = ref<UpdateCheck | null>(null)
  const preflight = ref<UpdatePreflight | null>(null)
  const rollbackPreflight = ref<RollbackPreflight | null>(null)
  const loading = ref(false)
  const checking = ref(false)
  const preflighting = ref(false)
  const action = ref<'update' | 'rollback' | ''>('')
  const error = ref('')
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const taskActive = computed(() => !!status.value?.task && activeStatuses.has(status.value.task.status))
  const hasUpdate = computed(() => checkResult.value?.has_update ?? status.value?.has_update ?? false)

  async function loadStatus() {
    if (loading.value) return
    loading.value = true
    try {
      status.value = await adminUpdateService.status()
      error.value = ''
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
      schedulePoll()
    }
  }

  async function checkForUpdates() {
    checking.value = true
    error.value = ''
    preflight.value = null
    try {
      checkResult.value = await adminUpdateService.check()
      await loadStatus()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      checking.value = false
    }
  }

  async function runPreflight() {
    preflighting.value = true
    error.value = ''
    try {
      preflight.value = await adminUpdateService.preflight()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      preflight.value = null
    } finally {
      preflighting.value = false
    }
  }

  async function startUpdate() {
    if (!preflight.value?.challenge || !preflight.value.candidate) throw new Error('更新确认已失效，请重新预检')
    action.value = 'update'
    error.value = ''
    try {
      await adminUpdateService.start(preflight.value.challenge, preflight.value.candidate.manifest_sha256)
      preflight.value = null
      await loadStatus()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      action.value = ''
    }
  }

  async function prepareRollback() {
    error.value = ''
    try {
      rollbackPreflight.value = await adminUpdateService.rollbackPreflight()
      if (!rollbackPreflight.value.ready) error.value = rollbackPreflight.value.detail
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      rollbackPreflight.value = null
    }
  }

  async function startRollback() {
    if (!rollbackPreflight.value?.challenge) throw new Error('回滚确认已失效，请重新检查')
    action.value = 'rollback'
    error.value = ''
    try {
      await adminUpdateService.rollback(rollbackPreflight.value.challenge)
      rollbackPreflight.value = null
      await loadStatus()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      throw cause
    } finally {
      action.value = ''
    }
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer)
    if (disposed) return
    const delay = taskActive.value ? 2500 : 30_000
    pollTimer = setTimeout(() => { void loadStatus() }, delay)
  }

  onMounted(() => { disposed = false; void loadStatus() })
  onUnmounted(() => { disposed = true; if (pollTimer) clearTimeout(pollTimer) })

  return {
    status, checkResult, preflight, rollbackPreflight, loading, checking, preflighting,
    action, error, taskActive, hasUpdate, loadStatus, checkForUpdates,
    runPreflight, startUpdate, prepareRollback, startRollback,
  }
}
