import {
  parseBreadcrumbSurfaceId,
  parseFolderSurfaceId,
} from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'
import { beginOptimisticIntent, withOptimisticIntent } from '@/utils/optimisticIntent'

type DropInfo = { droppedOn: 'folder' | 'breadcrumb' }

export interface FileRuntimeMoveOptions {
  scope: string
  browserSurfaceId: string
  resolveBreadcrumbTarget: (index: number) => { folderId: number | null; droppedOn: DropInfo['droppedOn'] } | null
  moveFolders: (ids: number[], targetFolderId: number | null) => Promise<void>
  moveFiles: (ids: number[], targetFolderId: number | null, dropInfo: DropInfo) => Promise<void>
  clearSelection: () => void
}

type ParsedObject = { id: number; isFolder: boolean; objectId: string }

/**
 * 文件域的 Runtime Action 适配层。
 *
 * Runtime 只提供对象 ID 和目标 Surface；文件 API、权限、乐观更新和回滚仍由调用方注入。
 * 文件库和项目文件区因此共享同一套 ID/Surface 解析，不再各自复制一份 Action handler。
 *
 * regrab 可能在上一笔持久化结束前再次产生 Action。这里仅登记“哪一笔是最新意图”，
 * optimisticMutation 据此阻止旧请求失败时覆盖新落点；实际缓存变更仍由调用方同步 apply。
 */
export function useFileRuntimeMove(options: FileRuntimeMoveOptions) {
  function parseObjects(objectIds: readonly string[]): ParsedObject[] {
    return objectIds.flatMap(objectId => {
      const folderPrefix = `${options.scope}:folder:`
      const filePrefix = `${options.scope}:file:`
      const isFolder = objectId.startsWith(folderPrefix)
      const isFile = objectId.startsWith(filePrefix)
      if (!isFolder && !isFile) return []
      const id = Number(objectId.slice(objectId.lastIndexOf(':') + 1))
      return Number.isNaN(id) ? [] : [{ id, isFolder, objectId }]
    })
  }

  async function handleAction(objectIds: readonly string[], toSurfaceId: string): Promise<void> {
    const parsed = parseObjects(objectIds)
    if (parsed.length === 0 || toSurfaceId === options.browserSurfaceId) return

    let targetFolderId: number | null
    let dropInfo: DropInfo
    const folderTarget = parseFolderSurfaceId(options.scope, toSurfaceId)
    if (folderTarget !== null) {
      targetFolderId = Number(folderTarget)
      if (Number.isNaN(targetFolderId)) return
      if (parsed.some(item => item.isFolder && targetFolderId === item.id)) return
      dropInfo = { droppedOn: 'folder' }
    } else {
      const breadcrumbIndex = parseBreadcrumbSurfaceId(options.scope, toSurfaceId)
      if (breadcrumbIndex === null) return
      const breadcrumbTarget = options.resolveBreadcrumbTarget(breadcrumbIndex)
      if (!breadcrumbTarget) return
      targetFolderId = breadcrumbTarget.folderId
      dropInfo = { droppedOn: breadcrumbTarget.droppedOn }
    }

    const folderIds = parsed.filter(item => item.isFolder).map(item => item.id)
    const fileIds = parsed.filter(item => !item.isFolder).map(item => item.id)
    const intent = beginOptimisticIntent(parsed.map(item => item.objectId))
    // moveFolders/moveFiles 都会在返回 Promise 前同步进入 optimisticMutation.apply()，因此只需
    // 把这一段同步调用栈标记为当前 intent；异步期间不保留可变全局上下文。
    const work = withOptimisticIntent(intent, () => Promise.all([
      folderIds.length > 0 ? options.moveFolders(folderIds, targetFolderId) : Promise.resolve(),
      fileIds.length > 0 ? options.moveFiles(fileIds, targetFolderId, dropInfo) : Promise.resolve(),
    ]))
    await work
    options.clearSelection()
  }

  return { handleAction }
}
