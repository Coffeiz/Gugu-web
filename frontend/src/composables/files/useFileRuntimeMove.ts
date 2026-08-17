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

    const folders = parsed.filter(item => item.isFolder)
    const files = parsed.filter(item => !item.isFolder)
    // 文件与文件夹分别进入各自的 optimisticMutation；intent 也必须分开，否则同一组拖拽里
    // “文件请求成功、文件夹请求失败”会错误地把另一类对象的 rollback chain 一并清掉。
    const folderWork = folders.length > 0
      ? withOptimisticIntent(
          beginOptimisticIntent(folders.map(item => item.objectId)),
          () => options.moveFolders(folders.map(item => item.id), targetFolderId),
        )
      : Promise.resolve()
    const fileWork = files.length > 0
      ? withOptimisticIntent(
          beginOptimisticIntent(files.map(item => item.objectId)),
          () => options.moveFiles(files.map(item => item.id), targetFolderId, dropInfo),
        )
      : Promise.resolve()
    await Promise.all([folderWork, fileWork])
    options.clearSelection()
  }

  return { handleAction }
}
