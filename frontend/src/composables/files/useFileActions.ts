import { filesApi, foldersApi } from '@/services/api'
import type { FileMeta, FolderMeta } from '@/stores/filesCache'

type FolderTarget = Pick<FolderMeta, 'id' | 'name'> | { folderId?: number; displayName: string }

/** 文件浏览层共用的 API 动作。缓存、乐观更新和页面提示由宿主继续负责。 */
export function useFileActions() {
  function downloadFile(file: Pick<FileMeta, 'id' | 'displayName' | 'ext'>) {
    return filesApi.download(file.id, `${file.displayName}.${file.ext.toLowerCase()}`)
  }

  function downloadFolder(folder: FolderTarget) {
    const id = 'displayName' in folder ? folder.folderId : folder.id
    const name = 'displayName' in folder ? folder.displayName : folder.name
    if (id == null) return Promise.resolve(null)
    return foldersApi.download(id, name)
  }

  function renameFile(id: number, displayName: string) {
    return filesApi.update(id, { displayName })
  }

  function renameFolder(id: number, name: string, version: number) {
    return foldersApi.rename(id, name, version)
  }

  function deleteFile(id: number) {
    return filesApi.delete(id)
  }

  function deleteFolder(id: number) {
    return foldersApi.delete(id)
  }

  function moveFile(id: number, folderId: number | null, projectId: number | null = null) {
    return filesApi.update(id, { folderId, projectId })
  }

  function moveFolder(id: number, parentId: number | null, version: number, projectId: number | null = null) {
    return foldersApi.move(id, parentId, version, projectId)
  }

  function copyFile(id: number, folderId: number | null, projectId: number | null = null) {
    return filesApi.copy(id, { folderId, projectId })
  }

  function copyFolder(id: number, parentId: number | null, projectId: number | null = null) {
    return foldersApi.copy(id, parentId, projectId)
  }

  function batchDownload(fileIds: number[], folderIds: number[], filename?: string) {
    return filesApi.batchDownload(fileIds, folderIds, filename)
  }

  function batchDelete(fileIds: number[]) {
    return filesApi.batchDelete(fileIds)
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
    batchDownload,
    batchDelete,
  }
}
