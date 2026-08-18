import { computed, ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useBoxSelection } from '@/composables/useBoxSelection'
import { useSelectionState, selectRange, type SelectableItem, type SelectionState } from './useSelectionState'

export { selectRange }
export type { SelectableItem }

export interface FileSelectionOptions {
  getFolders: () => FolderMeta[]
  getFiles: () => FileMeta[]
  openPreview: (file: FileMeta) => void
  isPreviewable: (ext: string) => boolean
  enterFolder: (folder: FolderMeta) => void
  fileAttr?: string
  folderAttr?: string
}

export type FileSelectionState<F = number> = SelectionState<F>

/** 文件库通用选择协调器：组合基础集合选择和框选，不包含下载、删除等副作用。 */
export function useFileSelection<F = number>(state: FileSelectionState<F>): ReturnType<typeof useSelectionState<F>>
export function useFileSelection(options: FileSelectionOptions): ReturnType<typeof createFileSelectionCoordinator>
export function useFileSelection(options: FileSelectionOptions | FileSelectionState<any>) {
  if ('fileIds' in options && 'folderIds' in options) return useSelectionState(options)
  return createFileSelectionCoordinator(options)
}

function createFileSelectionCoordinator(options: FileSelectionOptions) {
  const gridRef = ref<HTMLElement | null>(null)
  const lastAnchorIndex = ref(-1)
  const selectionModeForced = ref(false)
  const box = useBoxSelection(gridRef, {
    fileAttr: options.fileAttr ?? 'data-pm-file-id',
    folderAttr: options.folderAttr ?? 'data-pm-folder-id',
    excludeSelector: 'button, input, .folder-card, .fc-card, .list-row, label',
    parseFolderId: Number,
  })
  const fileSelection = useSelectionState({ fileIds: box.selectedFileIds, folderIds: box.selectedFolderIds })
  const flatSelectableItems = computed<SelectableItem[]>(() => [
    ...options.getFolders().map(folder => ({ type: 'folder' as const, id: folder.id })),
    ...options.getFiles().map(file => ({ type: 'file' as const, id: file.id })),
  ])
  const inSelectionMode = computed(() => selectionModeForced.value || box.selectedFileIds.value.size > 0 || box.selectedFolderIds.value.size > 0)

  function selectRange(type: 'file' | 'folder', id: number) {
    const index = flatSelectableItems.value.findIndex(item => item.type === type && item.id === id)
    if (index < 0 || lastAnchorIndex.value < 0) return false
    return fileSelection.selectRangeIn(flatSelectableItems.value, lastAnchorIndex.value, index)
  }
  function clearSelection() {
    fileSelection.clearSelection(); box.clearSelection(); selectionModeForced.value = false; lastAnchorIndex.value = -1
  }
  function toggleSelectionMode() { if (inSelectionMode.value) clearSelection(); else selectionModeForced.value = true }
  function onContentClick() { if (inSelectionMode.value) clearSelection() }
  function toggleFolderSelect(folder: FolderMeta) { fileSelection.toggleFolder(folder.id) }
  function onFileClick(file: FileMeta, event: MouseEvent) {
    if (event.shiftKey) { if (!selectRange('file', file.id)) fileSelection.selectOnlyFile(file.id) }
    else if (event.ctrlKey || event.metaKey || inSelectionMode.value) fileSelection.toggleFile(file.id)
    else fileSelection.toggleExclusiveFile(file.id)
    lastAnchorIndex.value = flatSelectableItems.value.findIndex(item => item.type === 'file' && item.id === file.id)
  }
  function onFolderClick(folder: FolderMeta, event: MouseEvent) {
    if (event.shiftKey) { if (!selectRange('folder', folder.id)) fileSelection.selectOnlyFolder(folder.id) }
    else if (event.ctrlKey || event.metaKey || inSelectionMode.value) fileSelection.toggleFolder(folder.id)
    else return options.enterFolder(folder)
    lastAnchorIndex.value = flatSelectableItems.value.findIndex(item => item.type === 'folder' && item.id === folder.id)
  }
  function handleFileClick(file: FileMeta, event: MouseEvent) {
    if (event.shiftKey || event.ctrlKey || event.metaKey || inSelectionMode.value) onFileClick(file, event)
    else if (options.isPreviewable(file.ext)) options.openPreview(file)
    else onFileClick(file, event)
  }
  return {
    gridRef,
    selectedFileIds: box.selectedFileIds,
    selectedFolderIds: box.selectedFolderIds,
    previewFileIds: box.previewFileIds,
    previewFolderIds: box.previewFolderIds,
    selectionRect: box.selectionRect,
    inSelectionMode,
    selectionModeForced,
    flatSelectableItems,
    onContainerMouseDown: box.onContainerMouseDown,
    cancelDrag: box.cancelDrag,
    clearSelection,
    onContentClick,
    toggleFolderSelect,
    toggleSelectionMode,
    handleFileClick,
    onFileClick,
    onFolderClick,
  }
}
