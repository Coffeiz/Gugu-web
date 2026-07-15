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

  return { downloadFile, downloadFolder }
}
