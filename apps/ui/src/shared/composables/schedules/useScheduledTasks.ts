import { onScopeDispose, ref, watch } from 'vue'
import { i18n } from '@/i18n'
import { requireScheduleAccess, type ScheduledTask } from '@/services/scheduleAccess'
import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { useLiveStore } from '@/stores/live'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { InteractionSyncEventQueue } from '@/interaction/sync/InteractionSyncEventQueue'
import type { LiveEventPayload } from '@/types/live-events'
import { RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'

export type { ScheduledTask } from '@/services/scheduleAccess'

export function useScheduledTasks() {
  const api = requireScheduleAccess()
  const t = i18n.global.t
  const tasks = ref<ScheduledTask[]>([])
  const loaded = ref(false)
  const loading = ref(true)
  const busy = ref(false)

  async function load() {
    loading.value = true
    try {
      const data = await api.list()
      tasks.value = data.tasks || []
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  async function save(taskId: number | null, data: ScheduledTask) {
    busy.value = true
    try {
      const saved = taskId != null
        ? await api.update(taskId, data)
        : await api.create(data)
      await load()
      return saved
    } finally {
      busy.value = false
    }
  }

  async function toggle(task: ScheduledTask) {
    const previous = task.enabled
    try {
      await InteractionSync.execute({
        scope: 'scheduled-task.toggle',
        entityKey: `scheduled-task:${task.id}`,
        apply: () => { task.enabled = !previous },
        rollback: () => { task.enabled = previous },
        request: mutation => api.update(task.id, { enabled: task.enabled }, { meta: { mutationId: mutation.mutationId } }),
        onCommit: () => { void load() },
      })
    } catch (error) {
      showAppError(t('schedules.updateFailed', { message: errorMessage(error) }))
    }
  }

  async function runNow(task: ScheduledTask) {
    busy.value = true
    try {
      const result = await api.run(task.id)
      showAppNotice(result.msg || t('schedules.ranOnce'))
      await load()
    } catch (error) {
      showAppError(t('schedules.runFailed', { message: errorMessage(error) }))
    } finally {
      busy.value = false
    }
  }

  async function remove(task: ScheduledTask) {
    if (!await confirmDialog({ title: t('schedules.deleteTitle'), message: t('schedules.deleteMessage', { name: task.name }), tone: 'danger', confirmText: t('schedules.delete') })) return
    try {
      await api.delete(task.id)
      await load()
    } catch (error) {
      showAppError(t('schedules.deleteFailed', { message: errorMessage(error) }))
    }
  }

  const live = useLiveStore()
  const eventQueue = new InteractionSyncEventQueue()
  const onScheduledTasksChanged = () => { void load().catch(error => showAppError(errorMessage(error))) }
  const stopScheduleSubscription = api.onChanged?.(onScheduledTasksChanged)
  if (stopScheduleSubscription) onScopeDispose(stopScheduleSubscription)
  if (typeof window !== 'undefined') {
    window.addEventListener(RESOURCE_REFRESH_EVENTS.scheduledTasks, onScheduledTasksChanged)
    onScopeDispose(() => window.removeEventListener(RESOURCE_REFRESH_EVENTS.scheduledTasks, onScheduledTasksChanged))
  }
  let lastTaskEventTick = 0
  function applyScheduledTaskEvent(event: LiveEventPayload): boolean {
    const id = Number(event.entity_id)
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as ScheduledTask : null
    if (!Number.isFinite(id)) return false
    if (event.operation === 'delete') {
      tasks.value = tasks.value.filter(task => Number(task.id) !== id)
      return true
    }
    if (payload) {
      const index = tasks.value.findIndex(task => Number(task.id) === id)
      if (event.operation === 'create' && index === -1) tasks.value = [payload, ...tasks.value]
      else if (index >= 0) tasks.value.splice(index, 1, payload)
      else return false
      return true
    }
    return false
  }
  eventQueue.register('scheduled_tasks', applyScheduledTaskEvent, () => { void load() })
  watch(() => live.resourceEvent, event => {
    if (event?.resource === 'scheduled_tasks') {
      lastTaskEventTick = event._t
      eventQueue.receive(event)
    }
  })
  watch(() => live.rev.scheduled_tasks, () => {
    if (live.resourceEvent?.resource === 'scheduled_tasks' && live.resourceEvent._t === lastTaskEventTick) {
      lastTaskEventTick = 0
      return
    }
    eventQueue.enqueue('scheduled_tasks')
  })

  return { tasks, loaded, loading, busy, load, save, toggle, runNow, remove }
}
