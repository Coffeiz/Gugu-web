import { ref } from 'vue'
import { scheduledTasksApi } from '@/services/api'
import { errorMessage, showAppError, showAppNotice } from '@/composables/useAppToast'
import { useLiveRefresh } from '@/composables/useLiveRefresh'

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
    if (!confirm(`删除「${task.name}」？`)) return
    try {
      await scheduledTasksApi.delete(task.id)
      await load()
    } catch (error) {
      showAppError(`删除任务失败：${errorMessage(error)}`)
    }
  }

  useLiveRefresh('scheduled_tasks', load)

  return { tasks, loading, busy, load, save, toggle, runNow, remove }
}
