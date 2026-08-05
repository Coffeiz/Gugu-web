import { computed, ref, type Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import type { ConflictDecision, ConflictItem } from '@/components/common/UploadConflictDialog.vue'
import { useFileUpload } from './useFileUpload'

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

/** 文件库只负责解析当前目录；上传生命周期由 useFileUpload 统一处理。 */
export function useFileLibraryUpload(options: FileLibraryUploadOptions) {
  const upload = useFileUpload({
    canUpload: options.canUpload,
    fileCacheStore: options.fileCacheStore,
    showConflicts: options.showConflicts,
    resolveContext: () => {
      const segment = options.currentSeg.value
      let space = 'personal'
      let projectId: number | null = null
      let folderId: number | null = null
      if (options.currentType.value === 'project' && segment) {
        space = 'project'
        projectId = segment.id ?? null
      } else if (options.currentType.value === 'folder' && segment) {
        folderId = segment.folderId ?? null
        if (segment.projectId != null) {
          space = 'project'
          projectId = segment.projectId
        }
      }
      return { space, projectId, folderId }
    },
    refreshAfterUpload: async () => {
      options.loadContents()
      await options.fetchStorage()
    },
    onUploadError: error => console.error('[Files] 上传失败:', error instanceof Error ? error.message : String(error)),
  })

  return {
    ...upload,
    dragging: ref(false),
    isDragging: computed(() => upload.isDragging.value),
  }
}

