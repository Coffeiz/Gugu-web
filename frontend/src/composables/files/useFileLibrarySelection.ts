import { computed, ref, type Ref } from 'vue'
import type { FileMeta } from '@/stores/filesCache'
import type { TrashFolderMeta } from '@/services/api'
import type { FolderCard as FolderCardMeta } from '@/utils/filesNav'
import { useBoxSelection } from '@/composables/useBoxSelection'
import { useSelectionState, selectRange, resolveSelectionAnchor, type SelectableItem } from './useSelectionState'

export interface FileLibrarySelectionOptions {
  containerRef: Ref<HTMLElement | null>
  currentType: Ref<string>
  getFolders: () => Array<{ id: number | string }>
  getFiles: () => FileMeta[]
  getTrashFolders: () => TrashFolderMeta[]
  enterFolder: (folder: FolderCardMeta) => void
  openPreview: (file: FileMeta) => void
  isPreviewable: (ext: string) => boolean
}

/** 文件库页面的统一选择协调器；批量副作用仍由 action composable 负责。 */
export function useFileLibrarySelection(options: FileLibrarySelectionOptions) {
  const selectedTrashFolderIds = ref<Set<number>>(new Set())
  const selectModeForced = ref(false)
  const lastAnchorIndex = ref(-1)
  const box = useBoxSelection(options.containerRef, {
    fileAttr: 'data-file-id', folderAttr: 'data-folder-key', extraFolderAttrs: ['data-trash-folder-id'],
    excludeSelector: 'button, .fc-card, .folder-card, .fub, .list-row',
    onBoxSelect: ({ fileIds, folderIds }, event) => {
      const normal = new Set([...folderIds].filter(id => !String(id).startsWith('trash:')))
      const trash = new Set([...folderIds].filter(id => String(id).startsWith('trash:')).map(id => Number(String(id).slice(6))))
      if (event.shiftKey) {
        box.selectedFileIds.value = new Set([...box.selectedFileIds.value, ...fileIds])
        box.selectedFolderIds.value = new Set([...box.selectedFolderIds.value, ...normal])
        selectedTrashFolderIds.value = new Set([...selectedTrashFolderIds.value, ...trash])
      } else {
        box.selectedFileIds.value = fileIds
        box.selectedFolderIds.value = normal
        selectedTrashFolderIds.value = trash
      }
      if (fileIds.size || folderIds.size) selectModeForced.value = true
    },
    onClear: () => { selectedTrashFolderIds.value = new Set() },
  })
  const state = useSelectionState({ fileIds: box.selectedFileIds, folderIds: box.selectedFolderIds })
  const flatSelectableItems = computed<SelectableItem<number | string>[]>(() => [
    ...(options.currentType.value === 'trash' ? options.getTrashFolders() : options.getFolders()).map(folder => ({ type: 'folder' as const, id: folder.id })),
    ...options.getFiles().map(file => ({ type: 'file' as const, id: file.id })),
  ])
  const inSelectionMode = computed(() => selectModeForced.value || box.selectedFileIds.value.size > 0 || box.selectedFolderIds.value.size > 0 || selectedTrashFolderIds.value.size > 0)
  function anchor(type: 'file' | 'folder', id: number | string) { lastAnchorIndex.value = flatSelectableItems.value.findIndex(item => item.type === type && item.id === id) }
  function range(type: 'file' | 'folder', id: number | string) {
    const target = flatSelectableItems.value.findIndex(item => item.type === type && item.id === id)
    return target >= 0 && lastAnchorIndex.value >= 0 && state.selectRangeIn(flatSelectableItems.value, lastAnchorIndex.value, target)
  }
  function clearSelection() { state.clearSelection(); box.clearSelection(); selectedTrashFolderIds.value = new Set(); selectModeForced.value = false; lastAnchorIndex.value = -1 }
  function handleFolderClick(folder: { id: number | string }, event: MouseEvent) {
    if (event.shiftKey) {
      const hadAnchor = lastAnchorIndex.value >= 0
      if (!range('folder', folder.id)) state.selectOnlyFolder(folder.id)
      lastAnchorIndex.value = resolveSelectionAnchor(lastAnchorIndex.value, flatSelectableItems.value.findIndex(item => item.type === 'folder' && item.id === folder.id), hadAnchor)
      return
    }
    if (event.ctrlKey || event.metaKey || inSelectionMode.value) { state.toggleFolder(folder.id); selectModeForced.value = true; anchor('folder', folder.id); return }
    options.enterFolder(folder as FolderCardMeta)
  }
  function handleFileClick(file: FileMeta, event: MouseEvent) {
    if (event.shiftKey) {
      const hadAnchor = lastAnchorIndex.value >= 0
      if (!range('file', file.id)) state.selectOnlyFile(file.id)
      lastAnchorIndex.value = resolveSelectionAnchor(lastAnchorIndex.value, flatSelectableItems.value.findIndex(item => item.type === 'file' && item.id === file.id), hadAnchor)
      return
    }
    if (event.ctrlKey || event.metaKey || inSelectionMode.value) { state.toggleFile(file.id); selectModeForced.value = true; anchor('file', file.id); return }
    if (options.isPreviewable(file.ext)) options.openPreview(file); else state.toggleExclusiveFile(file.id)
    anchor('file', file.id)
  }
  function handleTrashFileClick(file: FileMeta, event: MouseEvent) {
    if ((event.target as HTMLElement).closest('button')) return
    const target = flatSelectableItems.value.findIndex(item => item.type === 'file' && item.id === file.id)
    if (event.shiftKey && lastAnchorIndex.value >= 0 && target >= 0) {
      const selected = selectRange(flatSelectableItems.value, lastAnchorIndex.value, target)
      if (selected) {
        box.selectedFileIds.value = selected.fileIds
        selectedTrashFolderIds.value = new Set([...selected.folderIds].map(id => Number(id)))
        box.selectedFolderIds.value = new Set()
        selectModeForced.value = true
        return
      }
    }
    const ids = new Set(box.selectedFileIds.value)
    if (ids.has(file.id)) ids.delete(file.id); else ids.add(file.id)
    box.selectedFileIds.value = ids
    selectModeForced.value = true
    lastAnchorIndex.value = target
  }
  function handleTrashFolderClick(folder: TrashFolderMeta, event: MouseEvent) {
    if ((event.target as HTMLElement).closest('button')) return
    const target = flatSelectableItems.value.findIndex(item => item.type === 'folder' && item.id === folder.id)
    if (event.shiftKey && lastAnchorIndex.value >= 0 && target >= 0) {
      const selected = selectRange(flatSelectableItems.value, lastAnchorIndex.value, target)
      if (selected) {
        box.selectedFileIds.value = selected.fileIds
        selectedTrashFolderIds.value = new Set([...selected.folderIds].map(id => Number(id)))
        box.selectedFolderIds.value = new Set()
        selectModeForced.value = true
        return
      }
    }
    const next = new Set(selectedTrashFolderIds.value); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id)
    selectedTrashFolderIds.value = next; selectModeForced.value = true; lastAnchorIndex.value = target
  }
  const allTrashSelected = computed(() => {
    const files = options.getFiles(); const folders = options.getTrashFolders()
    return files.length + folders.length > 0 && files.every(file => box.selectedFileIds.value.has(file.id)) && folders.every(folder => selectedTrashFolderIds.value.has(folder.id))
  })
  function toggleSelectAllTrash() { if (allTrashSelected.value) return clearSelection(); selectModeForced.value = true; box.selectedFileIds.value = new Set(options.getFiles().map(file => file.id)); selectedTrashFolderIds.value = new Set(options.getTrashFolders().map(folder => folder.id)) }
  function toggleSelectMode() { if (inSelectionMode.value) clearSelection(); else selectModeForced.value = true }
  return { ...box, selectedIds: box.selectedFileIds, selectedFolderKeys: box.selectedFolderIds, selectedTrashFolderIds, previewFolderKeys: box.previewFolderIds, clearSelection, flatSelectableItems, inSelectionMode, selectModeForced, toggleSelectMode, toggleSelectAllTrash, allTrashSelected, handleFolderClick, handleFileClick, handleTrashFileClick, handleTrashFolderClick }
}
