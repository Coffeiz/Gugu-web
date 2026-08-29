import { ref, watch } from 'vue'
import { CLIENT_ID, scheduledTasksApi } from '@/services/api'
import { errorMessage, showAppError, showAppNotice } from '@/composables/useAppToast'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { confirmDialog } from '@/composables/useConfirmDialog'
import { useLiveStore } from '@/stores/live'

export type ScheduledTask = Record<string, any>

export function useScheduledTasks() {
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
    try {
      await scheduledTasksApi.update(task.id, { enabled: !task.enabled })
      await load()
    } catch (error) {
      showAppError(`更新任务失败：${errorMessage(error)}`)
    }
  }

  async function runNow(task: ScheduledTask) {
    busy.value = true
    try {
      const result = await scheduledTasksApi.run(task.id)
      showAppNotice(result.msg || '已执行一次')
      await load()
    } catch (error) {
      showAppError(`执行失败：${errorMessage(error)}`)
    } finally {
      busy.value = false
    }
  }

  async function remove(task: ScheduledTask) {
    if (!await confirmDialog({ title: '删除定时任务', message: `删除「${task.name}」？`, tone: 'danger', confirmText: '删除' })) return
    try {
      await scheduledTasksApi.delete(task.id)
      await load()
    } catch (error) {
      showAppError(`删除任务失败：${errorMessage(error)}`)
    }
  }

  const live = useLiveStore()
  watch(() => live.resourceEvent, (event) => {
    if (!event || event.resource !== 'scheduled_tasks' || event.origin === CLIENT_ID) return
    const id = Number(event.entity_id)
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as ScheduledTask : null
    if (!Number.isFinite(id)) return void load()
    if (event.operation === 'delete') {
      tasks.value = tasks.value.filter(task => Number(task.id) !== id)
    } else if (payload) {
      const index = tasks.value.findIndex(task => Number(task.id) === id)
      if (event.operation === 'create' && index === -1) tasks.value = [payload, ...tasks.value]
      else if (index >= 0) tasks.value.splice(index, 1, payload)
      else void load()
    } else {
      void load()
    }
  })
  // 旧 resources 事件和事件缺口仍走统一 refetch 兼容路径。
  useLiveRefresh('scheduled_tasks', load)

  return { tasks, loading, busy, load, save, toggle, runNow, remove }
}
