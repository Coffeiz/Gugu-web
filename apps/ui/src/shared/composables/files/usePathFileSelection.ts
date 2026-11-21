import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { confirmFileDeletion } from './useFileDeleteConfirm'
import { useBoxSelection } from '@/composables/shared/useBoxSelection'
import { type PathFileEntry, type PathFileRef } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'

export function usePathFileSelection(options: {
  target: Readonly<Ref<PathFileRef | null>>
  container: Ref<HTMLElement | null>
  getSelectedEntries: () => PathFileEntry[]
  reload: () => void
}) {
  const pathFilesApi = usePathFileAccess()
  const { target, container, getSelectedEntries, reload } = options
  const forced = ref(false)
  const cut = shallowRef<{ directoryId: PathFileRef['directoryId']; entries: PathFileEntry[]; mode: 'cut' | 'copy' } | null>(null)
  const moving = ref(false)
  const box = useBoxSelection<string, string>(container, {
    fileAttr: 'data-path-file',
    folderAttr: 'data-path-folder',
    parseFileId: value => value,
    onBoxSelect: ({ fileIds, folderIds }, event) => {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey
      box.selectedFileIds.value = additive ? new Set([...box.selectedFileIds.value, ...fileIds]) : fileIds
      box.selectedFolderIds.value = additive ? new Set([...box.selectedFolderIds.value, ...folderIds]) : folderIds
    },
    onClear: () => { forced.value = false },
  })
  const selectedPaths = computed(() => new Set([...box.selectedFileIds.value, ...box.selectedFolderIds.value]))
  const previewPaths = computed(() => new Set([...box.previewFileIds.value, ...box.previewFolderIds.value]))
  const selectionMode = computed(() => forced.value || selectedPaths.value.size > 0)
  const cutPaths = computed(() => new Set(cut.value?.mode === 'cut' && cut.value.directoryId === target.value?.directoryId
    ? cut.value?.entries.map(entry => entry.relativePath) : []))
  const pasteCount = computed(() => cut.value?.directoryId === target.value?.directoryId ? cut.value?.entries.length ?? 0 : 0)
  const canPaste = computed(() => pasteCount.value > 0 && !moving.value)

  function clearSelection() {
    box.cancelDrag()
    box.clearSelection()
  }
  function toggleSelection() {
    if (selectionMode.value) clearSelection()
    else forced.value = true
  }
  function select(entry: PathFileEntry) {
    const ids = entry.kind === 'directory' ? box.selectedFolderIds : box.selectedFileIds
    const next = new Set(ids.value)
    if (next.has(entry.relativePath)) next.delete(entry.relativePath)
    else next.add(entry.relativePath)
    ids.value = next
  }
  function clearCut() { cut.value = null }
  function putSelection(mode: 'cut' | 'copy', entry?: PathFileEntry) {
    const location = target.value
    if (!location) return
    const entries = entry && !selectedPaths.value.has(entry.relativePath) ? [entry] : getSelectedEntries()
    if (!entries.length) return
    cut.value = { directoryId: location.directoryId, entries, mode }
    clearSelection()
  }

  async function moveInto(entries: readonly PathFileEntry[], destinationDirectory: string, refresh: () => void | Promise<void> = reload) {
    const location = target.value
    if (!location || moving.value || !entries.length) return
    const epoch = accountBoundaryEpoch.value
    const clipboard = cut.value
    const completed = new Set<string>()
    moving.value = true
    try {
      for (const entry of entries) {
        if (epoch !== accountBoundaryEpoch.value) break
        const destination = [destinationDirectory, entry.name].filter(Boolean).join('/')
        try {
          if (destination !== entry.relativePath)
            await pathFilesApi.move({ directoryId: location.directoryId, relativePath: entry.relativePath }, destination)
          completed.add(entry.relativePath)
        } catch (error) {
          if (epoch === accountBoundaryEpoch.value) showAppError(errorMessage(error))
        }
      }
      if (epoch !== accountBoundaryEpoch.value || !completed.size) return
      if (clipboard?.mode === 'cut' && cut.value === clipboard && clipboard.directoryId === location.directoryId) {
        const remaining = clipboard.entries.filter(entry => !completed.has(entry.relativePath))
        cut.value = remaining.length ? { ...clipboard, entries: remaining } : null
      }
      if (target.value?.directoryId === location.directoryId) {
        box.selectedFileIds.value = new Set([...box.selectedFileIds.value].filter(id => !completed.has(id)))
        box.selectedFolderIds.value = new Set([...box.selectedFolderIds.value].filter(id => !completed.has(id)))
      }
      await refresh()
    } finally {
      moving.value = false
    }
  }
  async function copyInto(entries: readonly PathFileEntry[], destination: PathFileRef) {
    if (moving.value) return
    const epoch = accountBoundaryEpoch.value
    moving.value = true
    try {
      for (const entry of entries) {
        if (epoch !== accountBoundaryEpoch.value) break
        const source = { directoryId: destination.directoryId, relativePath: entry.relativePath }
        let path = [destination.relativePath, entry.name].filter(Boolean).join('/')
        try {
          if (path === source.relativePath) {
            const dot = entry.kind === 'file' ? entry.name.lastIndexOf('.') : -1
            const name = dot > 0 ? entry.name.slice(0, dot) : entry.name
            const extension = dot > 0 ? entry.name.slice(dot) : ''
            const taken = new Set((await pathFilesApi.entries(destination.directoryId, destination.relativePath)).map(value => value.name))
            let i = 2
            while (taken.has(`${name} (${i})${extension}`)) i++
            path = [destination.relativePath, `${name} (${i})${extension}`].filter(Boolean).join('/')
          }
          if (epoch === accountBoundaryEpoch.value) await pathFilesApi.copy(source, path)
        } catch (error) {
          if (epoch === accountBoundaryEpoch.value) showAppError(errorMessage(error))
        }
      }
    } finally {
      if (epoch === accountBoundaryEpoch.value) reload()
      moving.value = false
    }
  }

  function paste() {
    const location = target.value
    if (!location || !cut.value || !canPaste.value) return
    if (cut.value.mode === 'copy') return copyInto(cut.value.entries, location)
    return moveInto(cut.value.entries, location.relativePath)
  }

  async function trashEntries(entries: readonly PathFileEntry[], single?: PathFileEntry) {
    const location = target.value
    if (!location || !entries.length || moving.value) return
    const epoch = accountBoundaryEpoch.value
    const completed = new Set<string>()
    moving.value = true
    try {
      const confirmed = single
        ? await confirmFileDeletion(single.kind === 'directory' ? 'folder' : 'file', { name: single.name })
        : await confirmFileDeletion('selected', { count: entries.length })
      if (!confirmed || epoch !== accountBoundaryEpoch.value || target.value?.directoryId !== location.directoryId
        || target.value.relativePath !== location.relativePath) return
      for (const entry of entries) {
        if (epoch !== accountBoundaryEpoch.value) break
        try {
          await pathFilesApi.moveToTrash({ directoryId: location.directoryId, relativePath: entry.relativePath })
          completed.add(entry.relativePath)
        } catch (error) { if (epoch === accountBoundaryEpoch.value) showAppError(errorMessage(error)) }
      }
      if (epoch !== accountBoundaryEpoch.value) return
      if (cut.value?.directoryId === location.directoryId)
        cut.value = { ...cut.value, entries: cut.value.entries.filter(entry => !completed.has(entry.relativePath)) }
      clearSelection()
      reload()
    } finally {
      moving.value = false
    }
  }

  async function downloadSelected() {
    const location = target.value
    if (!location) return
    try {
      for (const entry of getSelectedEntries()) if (entry.kind === 'file')
        await pathFilesApi.download({ directoryId: location.directoryId, relativePath: entry.relativePath })
    } catch (error) { showAppError(errorMessage(error)) }
  }

  watch([() => target.value?.directoryId, () => target.value?.relativePath, accountBoundaryEpoch], clearSelection, { flush: 'sync' })
  watch(accountBoundaryEpoch, clearCut, { flush: 'sync' })
  onScopeDispose(box.cancelDrag)

  return {
    boxStart: box.boxStart,
    selectionRect: box.selectionRect,
    onContainerMouseDown: box.onContainerMouseDown,
    fileCount: computed(() => box.selectedFileIds.value.size),
    folderCount: computed(() => box.selectedFolderIds.value.size),
    selectionMode, selectedPaths, previewPaths, cutPaths, pasteCount, canPaste,
    select, clearSelection, toggleSelection, clearCut, paste, moveInto, downloadSelected,
    trashSelected: () => trashEntries(getSelectedEntries()),
    trashEntry: (entry: PathFileEntry) => trashEntries([entry], entry),
    cutSelected: (entry?: PathFileEntry) => putSelection('cut', entry),
    copySelected: () => putSelection('copy'),
  }
}
