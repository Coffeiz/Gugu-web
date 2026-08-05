import { computed, ref, type Ref } from 'vue'
import { useFilesCacheStore } from '@/stores/filesCache'
import type { ConflictDecision, ConflictItem } from '@/components/common/UploadConflictDialog.vue'
import { useFileUpload } from './useFileUpload'

export interface ProjectFileUploadOptions {
  projectId: Ref<number | null> | (() => number | null)
  baseFolderId: Ref<number | null> | (() => number | null)
  fileCacheStore: ReturnType<typeof useFilesCacheStore>
  showConflicts: (items: ConflictItem[]) => Promise<Map<string, ConflictDecision>>
}

function resolve(value: Ref<number | null> | (() => number | null)) {
  return typeof value === 'function' ? value() : value.value
}

/** 项目文件只负责固定 project 目标；上传生命周期由 useFileUpload 统一处理。 */
export function useProjectFileUpload(options: ProjectFileUploadOptions) {
  const upload = useFileUpload({
    fileCacheStore: options.fileCacheStore,
    showConflicts: options.showConflicts,
    resolveContext: () => ({
      space: 'project',
      projectId: resolve(options.projectId),
      folderId: resolve(options.baseFolderId),
    }),
    onUploadError: error => console.error('[ProjectModal] 上传失败:', error instanceof Error ? error.message : String(error)),
  })
  const dragging = ref(false)

  return {
    ...upload,
    dragging,
    isDragging: computed(() => upload.isDragging.value),
    handleFileDrop: upload.handleDrop,
    onDrop: upload.handleDrop,
  }
}

