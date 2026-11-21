import { ref, watch } from 'vue'
import { pathFilesApi, workspaceDirectoriesApi, type WorkspaceDirectory } from '@/services/api'
import { accountBoundaryEpoch, getAccountBoundaryEpoch } from '@/utils/accountBoundary'

const items = ref<WorkspaceDirectory[]>([])
const loading = ref(true)
const loaded = ref(false)
const error = ref<string | null>(null)
const defaultCount = ref<{ id: number; files: number; folders: number } | null>(null)
let pending: Promise<void> | undefined
let revision = 0

watch(accountBoundaryEpoch, () => {
  items.value = []
  defaultCount.value = null
  error.value = null
  loading.value = true
  loaded.value = false
  pending = undefined
}, { flush: 'sync' })

function refresh() {
  if (pending) return pending
  const epoch = getAccountBoundaryEpoch()
  const version = revision
  const isCurrent = () => epoch === getAccountBoundaryEpoch()
  loading.value = true
  error.value = null
  pending = (async () => {
    try {
      const list = await workspaceDirectoriesApi.list()
      if (!isCurrent()) return
      if (version === revision) items.value = list
      loaded.value = true
    } catch (cause) {
      if (isCurrent()) error.value = cause instanceof Error ? cause.message : String(cause)
      return
    } finally {
      if (isCurrent()) loading.value = false
    }
    if (!isCurrent()) return
    const workspace = items.value.find(item => item.isDefault)
    if (!workspace) return
    try {
      const entries = await pathFilesApi.entries(workspace.id)
      if (!isCurrent()) return
      const folders = entries.filter(entry => entry.kind === 'directory').length
      defaultCount.value = { id: workspace.id, files: entries.length - folders, folders }
    } catch { /* 数量暂时不可用，继续显示上次读取的数量。 */ }
  })().finally(() => {
    if (isCurrent()) pending = undefined
  })
  return pending
}

async function create(name: string) {
  const epoch = getAccountBoundaryEpoch()
  const created = await workspaceDirectoriesApi.create(name)
  if (epoch === getAccountBoundaryEpoch()) {
    revision++
    items.value = [...items.value.filter(item => item.id !== created.id), created]
  }
  return created
}

async function rename(item: WorkspaceDirectory, name: string) {
  const epoch = getAccountBoundaryEpoch()
  const updated = await workspaceDirectoriesApi.update(item.id, name)
  if (epoch === getAccountBoundaryEpoch()) {
    revision++
    items.value = items.value.map(current => current.id === updated.id ? updated : current)
  }
  return updated
}

async function remove(item: WorkspaceDirectory) {
  const epoch = getAccountBoundaryEpoch()
  await workspaceDirectoriesApi.delete(item.id)
  if (epoch === getAccountBoundaryEpoch()) {
    revision++
    items.value = items.value.filter(current => current.id !== item.id)
  }
}

export function useWorkspaceDirectories() {
  return { items, loading, loaded, error, defaultCount, refresh, create, rename, remove }
}
