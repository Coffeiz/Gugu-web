import { computed, ref, type Ref } from 'vue'
import { useFilesCacheStore, type FolderMeta } from '@/stores/filesCache'
import { uploadWithProgress } from '@/services/api'
import { clearThumbCache } from '@/composables/useThumbCache'
import { filesToItems, readDroppedEntries, type UploadItem } from '@/composables/useFileUpload'
import { useUploadQueue } from '@/composables/useUploadQueue'
import { executeUploadLifecycle, prepareUploadBatch } from './useFileUploadController'
import type { ConflictDecision, ConflictItem } from '@/components/common/UploadConflictDialog.vue'

export interface ProjectFileUploadOptions {
  projectId: Ref<number | null> | (() => number | null)
  baseFolderId: Ref<number | null> | (() => number | null)
  fileCacheStore: ReturnType<typeof useFilesCacheStore>
  showConflicts: (items: ConflictItem[]) => Promise<Map<string, ConflictDecision>>
}

function resolve(value: Ref<number | null> | (() => number | null)) {
  return typeof value === 'function' ? value() : value.value
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 项目文件上传的场景适配层；冲突决策和 ghost 生命周期由共享上传 composable 负责。 */
export function useProjectFileUpload(options: ProjectFileUploadOptions) {
  const {
    uploadingItems,
    createGhost,
    updateGhostProgress,
    removeGhost,
    failGhost,
    createFolderGhost,
    bumpFolderGhost,
  } = useUploadQueue()
  const dragging = ref(false)
  const dragCounter = ref(0)
  const isDragging = computed(() => dragCounter.value > 0)

  async function uploadFiles(items: UploadItem[]) {
    const projectId = resolve(options.projectId)
    if (!items.length || projectId == null) return
    const baseFolderId = resolve(options.baseFolderId)
    const prepared = await prepareUploadBatch(
      items,
      { space: 'project', projectId, folderId: baseFolderId },
      options.showConflicts,
    )
    if (!prepared.items.length) return

    const pendingTopFolders = new Map<string, FolderMeta>()
    await executeUploadLifecycle(prepared.items, {
      projectId,
      baseFolderId,
      folderGroups: prepared.folderGroups,
      decisions: prepared.decisions,
      createGhost,
      updateGhostProgress,
      removeGhost,
      failGhost,
      createFolderGhost,
      bumpFolderGhost,
      onFolderCreated: (created, isTopLevel) => {
        if (isTopLevel) pendingTopFolders.set(created.name, created as FolderMeta)
        else options.fileCacheStore.addFolder(created as FolderMeta)
      },
      onTopFolderReady: name => {
        const folder = pendingTopFolders.get(name)
        if (!folder) return
        options.fileCacheStore.addFolder(folder)
        pendingTopFolders.delete(name)
      },
      uploadOne: async (file, resolvedFolderId, _relativePath, decision, onProgress) => {
        const form = new FormData()
        form.append('file', file)
        form.append('space', 'project')
        form.append('project_id', String(projectId))
        if (resolvedFolderId) form.append('folder_id', String(resolvedFolderId))
        const overwriteId = decision?.action === 'overwrite' ? decision.existingFileId : null
        if (overwriteId) {
          form.append('on_conflict', 'overwrite')
          form.append('overwrite_file_id', String(overwriteId))
        }
        const created = await uploadWithProgress('/files', form, onProgress)
        if (overwriteId) {
          if (created) options.fileCacheStore.updateFile(overwriteId, created)
          clearThumbCache(overwriteId)
        } else if (created) {
          options.fileCacheStore.addFile(created)
        }
      },
      onUploadError: error => console.error('[ProjectModal] 上传失败:', errorMessage(error)),
    })
  }

  async function handleFileInput(event: Event) {
    const target = event.target as HTMLInputElement
    await uploadFiles(filesToItems(target.files ?? []))
    target.value = ''
  }

  async function handleFileDrop(event: DragEvent) {
    dragging.value = false
    if (!event.dataTransfer) return
    await uploadFiles(await readDroppedEntries(event.dataTransfer))
  }

  function onDragEnter(event: DragEvent) {
    if (event.dataTransfer?.types?.includes('Files')) dragCounter.value++
  }

  function onDragLeave() {
    dragCounter.value = Math.max(0, dragCounter.value - 1)
  }

  async function onDrop(event: DragEvent) {
    dragCounter.value = 0
    if (!event.dataTransfer) return
    const items = await readDroppedEntries(event.dataTransfer)
    if (items.length) await uploadFiles(items)
  }

  return {
    uploadingItems,
    dragging,
    isDragging,
    uploadFiles,
    handleFileInput,
    handleFileDrop,
    onDragEnter,
    onDragLeave,
    onDrop,
  }
}
