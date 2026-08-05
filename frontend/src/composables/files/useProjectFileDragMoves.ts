import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useFilesCacheStore } from '@/stores/filesCache'
import type { useFileActions } from './useFileActions'
import { optimisticMutation } from '@/utils/optimisticMutation'

export interface ProjectFileDragMovesOptions {
  fileActions: ReturnType<typeof useFileActions>
  fileCacheStore: ReturnType<typeof useFilesCacheStore>
  projectId: () => number | null
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 项目文件区拖拽移动的缓存乐观更新和回滚适配层。 */
export function useProjectFileDragMoves(options: ProjectFileDragMovesOptions) {
  async function moveFolders(
    folderIds: (number | string)[],
    targetFolderId: number | string | null,
  ) {
    const projectId = options.projectId()
    const targetId = targetFolderId == null ? null : Number(targetFolderId)
    const ids = folderIds.map(Number)
    const backups = ids.map(id => options.fileCacheStore.getFolder(id)).filter((folder): folder is FolderMeta => folder != null)
    let results: FolderMeta[] = []
    await optimisticMutation({
      apply: () => ids.forEach(id => options.fileCacheStore.updateFolder(id, { parentId: targetId, projectId })),
      afterMutate: () => {},
      work: () => Promise.all(ids.map(id =>
        options.fileActions.moveFolder(id, targetId, options.fileCacheStore.getFolder(id)?.version ?? 1, projectId),
      )).then(value => { results = value }),
      rollback: () => backups.forEach(folder => options.fileCacheStore.updateFolder(folder.id, {
        parentId: folder.parentId,
        projectId: folder.projectId,
      })),
      onCommit: () => results.forEach(folder => options.fileCacheStore.updateFolder(folder.id, { version: folder.version })),
      onError: error => console.error('[ProjectModal] 移动文件夹失败:', errorMessage(error)),
    })
  }

  async function moveFiles(
    fileIds: (number | string)[],
    targetFolderId: number | string | null,
    _dropInfo: { droppedOn: 'folder' | 'breadcrumb' },
  ) {
    const projectId = options.projectId()
    const folderId = targetFolderId == null ? null : Number(targetFolderId)
    const ids = fileIds.map(Number)
    const backups = ids.map(id => options.fileCacheStore.getFile(id)).filter((file): file is FileMeta => file != null)
    await optimisticMutation({
      apply: () => ids.forEach(id => options.fileCacheStore.updateFile(id, { folderId, projectId })),
      afterMutate: () => {},
      work: () => Promise.all(ids.map(id => options.fileActions.moveFile(id, folderId, projectId))),
      rollback: () => backups.forEach(file => options.fileCacheStore.updateFile(file.id, {
        folderId: file.folderId,
        projectId: file.projectId,
      })),
      onError: error => console.error('[ProjectModal] 移动失败:', errorMessage(error)),
    })
  }

  return { moveFolders, moveFiles }
}
