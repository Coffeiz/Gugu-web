import { filesApi, foldersApi } from '@/services/api'
import type { RequestMeta } from '@/services/api'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'

type FolderTarget = Pick<FolderMeta, 'id' | 'name'> | { folderId?: number; displayName: string }

export type FileActionScope = 'personal' | 'project' | 'folder' | 'trash'

export interface FileActionOptions {
  /** 当前动作宿主的目录边界；默认 personal 保持文件库现有行为。 */
  scope?: FileActionScope
  /** project/folder 场景固定的项目 ID，可传 getter 适配项目切换。 */
  projectId?: number | null | (() => number | null)
  /** 是否允许项目场景跨项目移动或复制。 */
  allowCrossProject?: boolean
  /** 是否允许 trash 场景执行普通写操作。 */
  allowTrashActions?: boolean
}

/** 校验跨场景目标；保持纯函数，便于页面接入前做边界回归测试。 */
export function fileActionScopeError(options: FileActionOptions, targetProjectId: number | null): string | null {
  const scope = options.scope ?? 'personal'
  const allowCrossProject = options.allowCrossProject ?? scope !== 'project'
  const allowTrashActions = options.allowTrashActions ?? false
  const configuredProjectId = typeof options.projectId === 'function'
    ? options.projectId()
    : (options.projectId ?? null)

  if (scope === 'project' && !allowCrossProject && targetProjectId !== configuredProjectId) {
    return '项目文件操作不能跨项目'
  }
  if (scope === 'trash' && !allowTrashActions) {
    return '回收站不允许执行此文件操作'
  }
  return null
}

/** 文件浏览层共用的 API 动作；InteractionSync adapter 由动作宿主负责本地 apply/rollback。 */
export function useFileActions(options: FileActionOptions = {}) {
  const scope = options.scope ?? 'personal'
  const allowCrossProject = options.allowCrossProject ?? scope !== 'project'
  const allowTrashActions = options.allowTrashActions ?? false

  function currentProjectId() {
    return typeof options.projectId === 'function' ? options.projectId() : (options.projectId ?? null)
  }

  function assertProjectTarget(targetProjectId: number | null) {
    const message = fileActionScopeError({
      ...options,
      scope,
      allowCrossProject,
      allowTrashActions,
      projectId: currentProjectId,
    }, targetProjectId)
    if (message) throw new Error(message)
  }

  function downloadFile(file: Pick<FileMeta, 'id' | 'displayName' | 'ext'>) {
    return filesApi.download(file.id, `${file.displayName}.${file.ext.toLowerCase()}`)
  }

  function downloadFolder(folder: FolderTarget) {
    const id = 'displayName' in folder ? folder.folderId : folder.id
    const name = 'displayName' in folder ? folder.displayName : folder.name
    if (id == null) return Promise.resolve(null)
    return foldersApi.download(id, name)
  }

  function renameFile(id: number, displayName: string, meta?: RequestMeta) {
    return filesApi.update(id, { displayName }, meta)
  }

  function renameFolder(id: number, name: string, version: number, meta?: RequestMeta) {
    return foldersApi.rename(id, name, version, meta)
  }

  function deleteFile(id: number, meta?: RequestMeta) {
    return filesApi.delete(id, meta)
  }

  function deleteFolder(id: number, meta?: RequestMeta) {
    return foldersApi.delete(id, meta)
  }

  function moveFile(id: number, folderId: number | null, projectId: number | null = null, meta?: RequestMeta) {
    assertProjectTarget(projectId)
    return filesApi.update(id, { folderId, projectId }, meta)
  }

  function moveFolder(id: number, parentId: number | null, version: number, projectId: number | null = null, meta?: RequestMeta) {
    assertProjectTarget(projectId)
    return foldersApi.move(id, parentId, version, projectId, meta)
  }

  function copyFile(id: number, folderId: number | null, projectId: number | null = null,
    conflict?: { onConflict?: 'keep_both' | 'overwrite'; overwriteFileId?: number | null }) {
    assertProjectTarget(projectId)
    return filesApi.copy(id, {
      folderId, projectId,
      onConflict: conflict?.onConflict ?? 'keep_both',
      ...(conflict?.overwriteFileId != null ? { overwriteFileId: conflict.overwriteFileId } : {}),
    })
  }

  function copyFolder(id: number, parentId: number | null, projectId: number | null = null) {
    assertProjectTarget(projectId)
    return foldersApi.copy(id, parentId, projectId)
  }

  function createFolder(projectId: number | null, name: string, parentId: number | null) {
    assertProjectTarget(projectId)
    return foldersApi.create(projectId, name, parentId)
  }

  function batchDownload(fileIds: number[], folderIds: number[], filename?: string) {
    return filesApi.batchDownload(fileIds, folderIds, filename)
  }

  function batchDelete(fileIds: number[], meta?: RequestMeta) {
    return filesApi.batchDelete(fileIds, meta)
  }

  return {
    downloadFile,
    downloadFolder,
    renameFile,
    renameFolder,
    deleteFile,
    deleteFolder,
    moveFile,
    moveFolder,
    copyFile,
    copyFolder,
    createFolder,
    batchDownload,
    batchDelete,
  }
}
