import { computed, ref, type Ref } from 'vue'
import { uploadWithProgress } from '@/services/api'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { clearThumbCache } from '@/composables/useThumbCache'
import { filesToItems, readDroppedEntries, type UploadItem } from '@/composables/useFileUpload'
import { useUploadQueue } from '@/composables/useUploadQueue'
import { executeUploadLifecycle, prepareUploadBatch } from './useFileUploadController'
import type { ConflictDecision, ConflictItem } from '@/components/common/UploadConflictDialog.vue'

export interface FileLibraryUploadOptions {
  currentType: Ref<string>
  currentSeg: Ref<{ type?: string; id?: number | null; projectId?: number | null; folderId?: number | null } | null>
  canUpload: Ref<boolean>
  fileCacheStore: {
    addFile: (file: FileMeta) => void
  updateFile: (id: number, file: Partial<FileMeta>) => void
    addFolder: (folder: FolderMeta) => void
  }
  loadContents: () => void
  fetchStorage: () => void | Promise<void>
  showConflicts: (items: ConflictItem[]) => Promise<Map<string, ConflictDecision>>
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 文件库上传场景适配层；冲突决策和 ghost 生命周期复用共享上传 controller。 */
export function useFileLibraryUpload(options: FileLibraryUploadOptions) {
  const queue = useUploadQueue()
  const dragCounter = ref(0)
  const isDragging = computed(() => dragCounter.value > 0)

  async function uploadFiles(items: UploadItem[]) {
    if (!items.length) return
    const type = options.currentType.value
    const segment = options.currentSeg.value
    let space = 'personal'
    let projectId: number | null = null
    let folderId: number | null = null
    if (type === 'project' && segment) {
      space = 'project'
      projectId = segment.id ?? null
    } else if (type === 'folder' && segment) {
      folderId = segment.folderId ?? null
      if (segment.projectId != null) {
        space = 'project'
        projectId = segment.projectId
      }
    }

    const prepared = await prepareUploadBatch(
      items,
      { space, projectId, folderId },
      options.showConflicts,
    )
    if (!prepared.items.length) return

    const pendingTopFolders = new Map<string, FolderMeta>()
    await executeUploadLifecycle(prepared.items, {
      projectId,
      baseFolderId: folderId,
      folderGroups: prepared.folderGroups,
      decisions: prepared.decisions,
      createGhost: queue.createGhost,
      updateGhostProgress: queue.updateGhostProgress,
      removeGhost: queue.removeGhost,
      failGhost: queue.failGhost,
      createFolderGhost: queue.createFolderGhost,
      bumpFolderGhost: queue.bumpFolderGhost,
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
      uploadOne: async (file, resolvedFolderId, relativePath, decision, onProgress) => {
        const form = new FormData()
        form.append('file', file)
        form.append('space', space)
        if (projectId != null) form.append('project_id', String(projectId))
        if (resolvedFolderId != null) form.append('folder_id', String(resolvedFolderId))
        const overwriteId = decision?.action === 'overwrite' ? decision.existingFileId : null
        if (overwriteId != null) {
          form.append('on_conflict', 'overwrite')
          form.append('overwrite_file_id', String(overwriteId))
        }
        const created = await uploadWithProgress('/files', form, onProgress)
        if (overwriteId != null) {
          options.fileCacheStore.updateFile(overwriteId, created)
          clearThumbCache(overwriteId)
        } else {
          options.fileCacheStore.addFile(created)
        }
        options.loadContents()
        await options.fetchStorage()
        // relativePath is consumed by the shared lifecycle; keep it in the callback signature.
        void relativePath
      },
      onUploadError: error => console.error('[Files] 上传失败:', errorMessage(error)),
    })
  }

  async function handleFileInput(event: Event) {
    const target = event.target as HTMLInputElement
    await uploadFiles(filesToItems(target.files ?? []))
    target.value = ''
  }

  function onDragEnter(event: DragEvent) {
    if (options.canUpload.value && event.dataTransfer?.types?.includes('Files')) dragCounter.value++
  }

  function onDragLeave() {
    dragCounter.value = Math.max(0, dragCounter.value - 1)
  }

  async function handleDrop(event: DragEvent) {
    dragCounter.value = 0
    if (!options.canUpload.value || !event.dataTransfer) return
    const items = await readDroppedEntries(event.dataTransfer)
    if (items.length) await uploadFiles(items)
  }

  return { uploadingItems: queue.uploadingItems, isDragging, uploadFiles, handleFileInput, onDragEnter, onDragLeave, handleDrop }
}
