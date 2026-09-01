import {
  parseBreadcrumbSurfaceId,
  parseFolderSurfaceId,
} from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'

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
 * regrab 可能在上一笔持久化结束前再次产生 Action。最新意图与失败回滚由
 * InteractionSync adapter 统一登记，这里只负责 Runtime Action 到领域动作的路由。
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
    // 拖拽落点已经确定后立即退出选择模式，避免持久化请求尚未返回时用户的
    // 下一次点击仍被选择协调器吞掉，尤其是紧接着点击目标文件夹导航的场景。
    options.clearSelection()
    const folderWork = folders.length > 0
      ? options.moveFolders(folders.map(item => item.id), targetFolderId)
      : Promise.resolve()
    const fileWork = files.length > 0
      ? options.moveFiles(files.map(item => item.id), targetFolderId, dropInfo)
      : Promise.resolve()
    await Promise.all([folderWork, fileWork])
  }

  return { handleAction }
}
