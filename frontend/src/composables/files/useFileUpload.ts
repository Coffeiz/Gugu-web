import { computed, ref, type Ref } from 'vue'
import { uploadWithProgress } from '@/services/api'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { clearThumbCache } from '@/composables/shared/useThumbCache'
import { filesToItems, readDroppedEntries, type UploadItem } from '@/composables/files/useFileUploadCore'
import { useUploadQueue } from '@/composables/shared/useUploadQueue'
import type { ConflictDecision, ConflictItem } from '@/components/common/overlays/UploadConflictDialog.vue'
import { executeUploadLifecycle, prepareUploadBatch, type UploadConflictContext } from './useFileUploadController'

export interface FileUploadCache {
  addFile: (file: FileMeta) => void
  updateFile: (id: number, file: Partial<FileMeta>) => void
  addFolder: (folder: FolderMeta) => void
}

export interface FileUploadOptions {
  resolveContext: () => UploadConflictContext
  canUpload?: Ref<boolean> | (() => boolean)
  fileCacheStore: FileUploadCache
  showConflicts: (items: ConflictItem[]) => Promise<Map<string, ConflictDecision>>
  refreshAfterUpload?: () => void | Promise<void>
  onUploadError?: (error: unknown) => void
}

function canUpload(options: FileUploadOptions) {
  return typeof options.canUpload === 'function' ? options.canUpload() : (options.canUpload?.value ?? true)
}

/**
 * 文件上传共享核心：统一冲突决策、文件夹/Ghost 生命周期和缓存写入。
 * 文件库与项目编辑卡只负责解析目标目录和提供刷新策略。
 */
export function useFileUpload(options: FileUploadOptions) {
  const queue = useUploadQueue()
  const dragCounter = ref(0)
  const isDragging = computed(() => dragCounter.value > 0)

  async function uploadFiles(items: UploadItem[]) {
    if (!items.length || !canUpload(options)) return
    const context = options.resolveContext()
    const prepared = await prepareUploadBatch(items, context, options.showConflicts)
    if (!prepared.items.length) return

    const pendingTopFolders = new Map<string, FolderMeta>()
    await executeUploadLifecycle(prepared.items, {
      projectId: context.projectId,
      baseFolderId: context.folderId,
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
      uploadOne: async (file, resolvedFolderId, _relativePath, decision, onProgress) => {
        const form = new FormData()
        form.append('file', file)
        form.append('space', context.space)
        if (context.projectId != null) form.append('project_id', String(context.projectId))
        if (resolvedFolderId != null) form.append('folder_id', String(resolvedFolderId))
        const overwriteId = decision?.action === 'overwrite' ? decision.existingFileId : null
        if (overwriteId != null) {
          form.append('on_conflict', 'overwrite')
          form.append('overwrite_file_id', String(overwriteId))
        }
        const created = await uploadWithProgress('/files', form, onProgress)
        if (overwriteId != null) {
          options.fileCacheStore.updateFile(overwriteId, { ...created, thumbRevision: Date.now() })
          clearThumbCache(overwriteId)
        } else {
          options.fileCacheStore.addFile(created)
        }
        await options.refreshAfterUpload?.()
      },
      onUploadError: error => {
        options.onUploadError?.(error)
      },
    })
  }

  async function handleFileInput(event: Event) {
    const target = event.target as HTMLInputElement
    await uploadFiles(filesToItems(target.files ?? []))
    target.value = ''
  }

  function onDragEnter(event: DragEvent) {
    if (canUpload(options) && event.dataTransfer?.types?.includes('Files')) dragCounter.value++
  }

  function onDragLeave() {
    dragCounter.value = Math.max(0, dragCounter.value - 1)
  }

  async function handleDrop(event: DragEvent) {
    dragCounter.value = 0
    if (!canUpload(options) || !event.dataTransfer) return
    const items = await readDroppedEntries(event.dataTransfer)
    if (items.length) await uploadFiles(items)
  }

  return {
    uploadingItems: queue.uploadingItems,
    isDragging,
    uploadFiles,
    handleFileInput,
    onDragEnter,
    onDragLeave,
    handleDrop,
  }
}
