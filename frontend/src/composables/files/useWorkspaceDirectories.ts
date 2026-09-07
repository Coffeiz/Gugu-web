import { computed, ref } from 'vue'
import { workspaceDirectoriesApi, type WorkspaceDirectory } from '@/services/api'

export function useWorkspaceDirectories() {
  const items = ref<WorkspaceDirectory[]>([])
  // 首帧直接进入加载态，避免空列表先闪成“暂无 Workspace”再被请求状态覆盖。
  const loading = ref(true)
  const error = ref<string | null>(null)

  const sortedItems = computed(() => [...items.value].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  }))

  async function refresh() {
    loading.value = true
    error.value = null
    try {
      items.value = await workspaceDirectoriesApi.list()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading.value = false
    }
  }

  async function create(name: string) {
    const created = await workspaceDirectoriesApi.create(name)
    items.value = [...items.value, created]
    return created
  }

  async function rename(item: WorkspaceDirectory, name: string) {
    const updated = await workspaceDirectoriesApi.update(item.id, name)
    items.value = items.value.map(current => current.id === updated.id ? updated : current)
    return updated
  }

  async function remove(item: WorkspaceDirectory) {
    await workspaceDirectoriesApi.delete(item.id)
    items.value = items.value.filter(current => current.id !== item.id)
  }

  return { items, sortedItems, loading, error, refresh, create, rename, remove }
}
