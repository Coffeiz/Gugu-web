import { ref, watch } from 'vue'
import { i18n } from '@/i18n'
import { scheduledTasksApi } from '@/services/api'
import { errorMessage, showAppError, showAppNotice } from '@/composables/useAppToast'
import { confirmDialog } from '@/composables/useConfirmDialog'
import { useLiveStore } from '@/stores/live'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { InteractionSyncEventQueue } from '@/interaction/sync/InteractionSyncEventQueue'
import type { LiveEventPayload } from '@/types/live-events'

export type ScheduledTask = Record<string, any>

export function useScheduledTasks() {
  const t = i18n.global.t
  const tasks = ref<ScheduledTask[]>([])
  const loading = ref(true)
  const busy = ref(false)

  async function load() {
    loading.value = true
    try {
      const data = await scheduledTasksApi.list()
      tasks.value = data.tasks || []
    } finally {
      loading.value = false
    }
  }

  async function save(taskId: number | null, data: ScheduledTask) {
    busy.value = true
    try {
      if (taskId != null) await scheduledTasksApi.update(taskId, data)
      else await scheduledTasksApi.create(data)
      await load()
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
        request: mutation => scheduledTasksApi.update(task.id, { enabled: task.enabled }, { mutationId: mutation.mutationId }),
        onCommit: () => { void load() },
      })
    } catch (error) {
      showAppError(t('schedules.updateFailed', { message: errorMessage(error) }))
    }
  }

  async function runNow(task: ScheduledTask) {
    busy.value = true
    try {
      const result = await scheduledTasksApi.run(task.id)
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
      await scheduledTasksApi.delete(task.id)
      await load()
    } catch (error) {
      showAppError(t('schedules.deleteFailed', { message: errorMessage(error) }))
    }
  }

  const live = useLiveStore()
  const eventQueue = new InteractionSyncEventQueue()
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

  return { tasks, loading, busy, load, save, toggle, runNow, remove }
}
