import { computed, ref, watch, type Ref } from 'vue'
import { showAppError, showAppSuccess, errorMessage } from '@/composables/core/useAppToast'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { i18n } from '@/i18n'
import { diskTrashApi, type DiskTrashEntry } from '@/services/api'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { confirmFileDeletion } from './useFileDeleteConfirm'

export function useDiskTrash(active: Readonly<Ref<boolean>>) {
  const entries = ref<DiskTrashEntry[]>([])
  const loading = ref(false)
  const error = ref('')
  const busy = ref(false)
  const selectionMode = ref(false)
  const selected = ref(new Set<string>())
  const progress = ref<{ done: number; total: number; failed: number } | null>(null)
  const selectedEntries = computed(() => entries.value.filter(entry => selected.value.has(entry.id)))
  const folderCount = computed(() => selectedEntries.value.filter(entry => entry.kind === 'directory').length)
  const fileCount = computed(() => selectedEntries.value.length - folderCount.value)
  const allSelected = computed(() => entries.value.length > 0 && selectedEntries.value.length === entries.value.length)
  let request = 0
  const { t } = i18n.global

  function clearSelection() {
    selectionMode.value = false
    selected.value = new Set()
  }
  function toggleSelection() {
    if (selectionMode.value) clearSelection()
    else selectionMode.value = true
  }
  function toggleAll() {
    if (allSelected.value) clearSelection()
    else {
      selectionMode.value = true
      selected.value = new Set(entries.value.map(entry => entry.id))
    }
  }
  function select(id: string) {
    const next = new Set(selected.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selected.value = next
  }
  async function load() {
    if (!active.value) return
    const version = ++request
    loading.value = true
    error.value = ''
    try {
      const result = await diskTrashApi.list()
      if (version === request) entries.value = result
    } catch (cause) {
      if (version === request) error.value = errorMessage(cause)
    } finally {
      if (version === request) loading.value = false
    }
  }
  watch([active, accountBoundaryEpoch], () => {
    request++
    entries.value = []
    clearSelection()
    void load()
  }, { immediate: true, flush: 'sync' })

  async function mutate(snapshot: readonly DiskTrashEntry[], operation: 'restore' | 'purge', epoch: number, empty = false) {
    if (busy.value || !active.value || epoch !== accountBoundaryEpoch.value || !snapshot.length) return
    busy.value = true
    const status = { done: 0, total: snapshot.length, failed: 0 }
    if (empty) progress.value = { ...status }
    try {
      for (const entry of snapshot) {
        if (epoch !== accountBoundaryEpoch.value) break
        try {
          await diskTrashApi[operation](entry.id)
          if (epoch !== accountBoundaryEpoch.value) break
          entries.value = entries.value.filter(item => item.id !== entry.id)
          selected.value.delete(entry.id)
        } catch (cause) {
          status.failed++
          if (!empty && epoch === accountBoundaryEpoch.value) showAppError(errorMessage(cause))
        }
        status.done++
        if (empty) progress.value = { ...status }
      }
      if (epoch !== accountBoundaryEpoch.value) return
      if (empty && status.failed) showAppError(t('filesViewUi.emptyTrashPartial', { failed: status.failed }))
      else if (empty) showAppSuccess(t('filesViewUi.emptyTrashComplete', { count: status.done }))
      await load()
    } finally {
      progress.value = null
      busy.value = false
    }
  }
  function restore(entry?: DiskTrashEntry) {
    return mutate(entry ? [entry] : selectedEntries.value, 'restore', accountBoundaryEpoch.value)
  }
  async function purge(entry?: DiskTrashEntry) {
    const epoch = accountBoundaryEpoch.value
    const snapshot = entry ? [entry] : selectedEntries.value
    if (busy.value || !snapshot.length) return
    const kind = entry ? entry.kind === 'directory' ? 'permanent-folder' : 'permanent-file' : 'permanent-selected'
    if (await confirmFileDeletion(kind, { name: entry?.name, count: snapshot.length }))
      await mutate(snapshot, 'purge', epoch)
  }
  async function empty() {
    const epoch = accountBoundaryEpoch.value
    const snapshot = entries.value
    if (busy.value || !snapshot.length || !await confirmDialog({
      title: t('filesViewUi.emptyTrashTitle'),
      message: t('filesViewUi.emptyTrashMessage'),
      tone: 'danger',
      confirmText: t('filesViewUi.permanentDelete'),
    })) return
    await mutate(snapshot, 'purge', epoch, true)
  }
  return { entries, loading, error, busy, progress, selectionMode, selected, allSelected, fileCount, folderCount,
    load, clearSelection, toggleSelection, toggleAll, select, restore, purge, empty }
}
