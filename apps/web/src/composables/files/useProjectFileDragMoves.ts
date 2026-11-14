import type { FileMeta, FolderMeta } from '@/stores/filesCache'
import { useFilesCacheStore } from '@/stores/filesCache'
import type { useFileActions } from './useFileActions'
import { InteractionSync } from '@/interaction/sync/InteractionSync'

export interface ProjectFileDragMovesOptions {
  fileActions: ReturnType<typeof useFileActions>
  fileCacheStore: ReturnType<typeof useFilesCacheStore>
  projectId: () => number | null
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 项目文件区拖拽移动的 InteractionSync adapter。 */
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
    await InteractionSync.execute({
      scope: 'folder.move', entityKey: `folder-move:${ids.join(',')}`,
      apply: () => ids.forEach(id => options.fileCacheStore.updateFolder(id, { parentId: targetId, projectId })),
      rollback: () => backups.forEach(folder => options.fileCacheStore.updateFolder(folder.id, {
        parentId: folder.parentId,
        projectId: folder.projectId,
      })),
      request: mutation => Promise.all(ids.map(id =>
        options.fileActions.moveFolder(id, targetId, options.fileCacheStore.getFolder(id)?.version ?? 1, projectId, { mutationId: mutation.mutationId }),
      )).then(value => { results = value; return value }),
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
    await InteractionSync.execute({
      scope: 'file.move', entityKey: `file-move:${ids.join(',')}`,
      apply: () => ids.forEach(id => options.fileCacheStore.updateFile(id, { folderId, projectId })),
      rollback: () => backups.forEach(file => options.fileCacheStore.updateFile(file.id, {
        folderId: file.folderId,
        projectId: file.projectId,
      })),
      request: mutation => Promise.all(ids.map(id => options.fileActions.moveFile(id, folderId, projectId, { mutationId: mutation.mutationId }))),
      onError: error => console.error('[ProjectModal] 移动失败:', errorMessage(error)),
    })
  }

  return { moveFolders, moveFiles }
}
