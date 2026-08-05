import type { Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useFileDragDrop } from '@/composables/useFileDragDrop'

export interface ProjectFileDragOptions {
  folderStack: Ref<FolderMeta[]>
  stagesExpanded: Ref<boolean>
  selectedFileIds: Ref<Set<number>>
  selectedFolderIds: Ref<Set<number>>
  cancelBoxDrag: () => void
  clearSelection: () => void
  moveFolders: (ids: (number | string)[], target: number | string | null, info: { droppedOn: 'folder' | 'breadcrumb' }) => Promise<void>
  moveFiles: (ids: (number | string)[], target: number | string | null, info: { droppedOn: 'folder' | 'breadcrumb' }) => Promise<void>
}

/** 项目文件区拖拽目标和卡片抓起适配；物理动画仍由共享 useFileDragDrop 负责。 */
export function useProjectFileDrag(options: ProjectFileDragOptions) {
  const drag = useFileDragDrop({
    fileDataAttr: 'data-pm-file-id',
    folderDataAttr: 'data-pm-folder-id',
    folderSelector: '.folder-card, .folder-list-row',
    bcSelector: '.bc-seg',
    resolveBcTarget(index) {
      if (index === -1) return { targetFolderId: null, acceptsFiles: true, acceptsFolders: true }
      const segment = options.folderStack.value[index]
      return segment ? { targetFolderId: segment.id, acceptsFiles: true, acceptsFolders: true } : null
    },
    cancelBoxDrag: options.cancelBoxDrag,
    clearSelection: options.clearSelection,
    moveFolders: options.moveFolders,
    moveFiles: options.moveFiles,
  })

  function onFolderPointerDown(folder: FolderMeta, event: PointerEvent) {
    drag.onFolderPointerDown(event, {
      itemId: folder.id,
      isSelected: options.selectedFolderIds.value.has(folder.id),
      selectedFileIds: options.selectedFileIds.value,
      selectedFolderIds: options.selectedFolderIds.value,
      extraOpts: options.stagesExpanded.value ? { cloneClass: 'pm-clone-expanded' } : {},
    })
  }

  function onFilePointerDown(file: FileMeta, event: PointerEvent) {
    drag.onFilePointerDown(event, {
      itemId: file.id,
      isSelected: options.selectedFileIds.value.has(file.id),
      selectedFileIds: options.selectedFileIds.value,
      selectedFolderIds: options.selectedFolderIds.value,
      extraOpts: options.stagesExpanded.value ? { cloneClass: 'pm-clone-expanded' } : {},
    })
  }

  return {
    draggingFileIds: drag.draggingFileIds,
    draggingFolderIds: drag.draggingFolderIds,
    dragOverFolderId: drag.dragOverFolderId,
    bcDragOverIdx: drag.bcDragOverIdx,
    onFolderPointerDown,
    onFilePointerDown,
  }
}
