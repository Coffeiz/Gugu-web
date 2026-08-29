import type { Ref } from 'vue'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import type { FileActionScope } from './useFileActions'

/** 当前文件能力宿主的目录和权限边界。页面只提供上下文，核心逻辑不读取页面状态。 */
export interface FileOperationContext {
  scope: FileActionScope
  projectId: number | null
  folderId: number | null
  canUpload?: boolean
  allowCrossProject?: boolean
  allowTrashActions?: boolean
}

/** 选择核心需要的最小集合；回收站可通过自定义 folder 类型扩展。 */
export interface FileSelectionContext<FolderId = number> {
  selectedFileIds: Ref<Set<number>>
  selectedFolderIds: Ref<Set<FolderId>>
  clearSelection: () => void
  getFiles: () => FileMeta[]
  getFolders: () => FolderMeta[]
}

/** 上传核心的目标与副作用边界，Ghost、缓存和刷新由场景适配器提供。 */
export interface FileUploadContext {
  operation: FileOperationContext
  showConflicts: (items: unknown[]) => Promise<Map<string, unknown>>
  onContentsChanged?: () => void | Promise<void>
  onUploadError?: (error: unknown) => void
}

/** 批量命令只依赖选择集合、目标解析和变更通知，不依赖具体页面。 */
export interface FileBatchContext<FolderId = number> extends FileSelectionContext<FolderId> {
  operation: FileOperationContext
  resolveDestination: () => { folderId: number | null; projectId: number | null }
  onContentsChanged?: () => void | Promise<void>
}

/** 拖拽引擎使用的目标解析契约；文件库和项目文件区分别实现规则。 */
export interface FileDropTargetResolver<TTarget = unknown> {
  resolveTarget: (event: DragEvent) => TTarget | null
  canDrop?: (target: TTarget) => boolean
  commitDrop?: (target: TTarget) => void | Promise<void>
}

