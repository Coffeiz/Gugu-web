import { computed, ref, type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useBoxSelection } from '@/composables/useBoxSelection'
import { useFileSelection } from './useFileSelection'

type SelectableItem = { type: 'folder' | 'file'; id: number }

export interface ProjectFileSelectionOptions {
  getFolders: () => FolderMeta[]
  getFiles: () => FileMeta[]
  openPreview: (file: FileMeta) => void
  isPreviewable: (ext: string) => boolean
  enterFolder: (folder: FolderMeta) => void
}

/** 项目文件区的选择、框选和点击语义；下载/删除等副作用仍由页面动作层负责。 */
export function useProjectFileSelection(options: ProjectFileSelectionOptions) {
  const gridRef = ref<HTMLElement | null>(null)
  const lastAnchorIndex = ref(-1)
  const selectionModeForced = ref(false)

  const {
    selectedFileIds,
    selectedFolderIds,
    previewFileIds,
    previewFolderIds,
    selectionRect,
    onContainerMouseDown,
    cancelDrag,
    clearSelection: clearBoxSelection,
  } = useBoxSelection(gridRef, {
    fileAttr: 'data-pm-file-id',
    folderAttr: 'data-pm-folder-id',
    excludeSelector: 'button, input, .folder-card, .fc-card, label',
    parseFolderId: Number,
    onBoxSelect: ({ fileIds, folderIds }) => {
      selectedFileIds.value = fileIds
      selectedFolderIds.value = folderIds
      if (fileIds.size + folderIds.size > 0) selectionModeForced.value = true
    },
  })

  const fileSelection = useFileSelection({
    fileIds: selectedFileIds,
    folderIds: selectedFolderIds,
  })

  const flatSelectableItems = computed<SelectableItem[]>(() => [
    ...options.getFolders().map(folder => ({ type: 'folder' as const, id: folder.id })),
    ...options.getFiles().map(file => ({ type: 'file' as const, id: file.id })),
  ])

  const inSelectionMode = computed(() =>
    selectionModeForced.value || selectedFileIds.value.size > 0 || selectedFolderIds.value.size > 0,
  )

  function selectRange(type: SelectableItem['type'], id: number) {
    const index = flatSelectableItems.value.findIndex(item => item.type === type && item.id === id)
    if (index < 0) return false
    return fileSelection.selectRangeIn(flatSelectableItems.value, lastAnchorIndex.value, index)
  }

  function clearSelection() {
    fileSelection.clearSelection()
    clearBoxSelection()
    selectionModeForced.value = false
    lastAnchorIndex.value = -1
  }

  function onContentClick() {
    if (inSelectionMode.value) clearSelection()
  }

  function toggleFolderSelect(folder: FolderMeta) {
    fileSelection.toggleFolder(folder.id)
  }

  function toggleSelectionMode() {
    if (inSelectionMode.value) clearSelection()
    else selectionModeForced.value = true
  }

  function onFileClick(file: FileMeta, event: MouseEvent) {
    if (event.shiftKey) {
      if (!selectRange('file', file.id)) {
        selectedFileIds.value = new Set([file.id])
      }
    } else if (event.ctrlKey || event.metaKey || inSelectionMode.value) {
      fileSelection.toggleFile(file.id)
    } else {
      fileSelection.toggleExclusiveFile(file.id)
    }
    lastAnchorIndex.value = flatSelectableItems.value.findIndex(item => item.type === 'file' && item.id === file.id)
  }

  function onFolderClick(folder: FolderMeta, event: MouseEvent) {
    if (event.shiftKey) {
      if (!selectRange('folder', folder.id)) {
        selectedFolderIds.value = new Set([folder.id])
      }
    } else if (event.ctrlKey || event.metaKey) {
      fileSelection.toggleFolder(folder.id)
    } else if (inSelectionMode.value) {
      toggleFolderSelect(folder)
    } else {
      options.enterFolder(folder)
    }
    lastAnchorIndex.value = flatSelectableItems.value.findIndex(item => item.type === 'folder' && item.id === folder.id)
  }

  function handleFileClick(file: FileMeta, event: MouseEvent) {
    if (event.shiftKey || event.ctrlKey || event.metaKey || inSelectionMode.value) {
      onFileClick(file, event)
    } else if (options.isPreviewable(file.ext)) {
      options.openPreview(file)
    } else {
      onFileClick(file, event)
    }
  }

  return {
    gridRef,
    selectedFileIds,
    selectedFolderIds,
    previewFileIds,
    previewFolderIds,
    selectionRect,
    inSelectionMode,
    selectionModeForced,
    flatSelectableItems,
    onContainerMouseDown,
    cancelDrag,
    clearSelection,
    onContentClick,
    toggleFolderSelect,
    toggleSelectionMode,
    handleFileClick,
    onFileClick,
    onFolderClick,
  }
}
