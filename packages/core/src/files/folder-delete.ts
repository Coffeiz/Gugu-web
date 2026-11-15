import { CoreError, dataContext } from '../contracts/index.js'

export interface FolderDeleteFolderRow {
  id: number | string
  user_id: string
  parent_id: number | string | null
  deleted_at: unknown
}

export interface FolderDeleteFileRow {
  id: number | string
  user_id: string
  folder_id: number | string | null
  deleted_at: unknown
}

/** Match Python FolderTree.descendants + FileOps.delete semantics for a soft-deleted subtree. */
export function planFolderSoftDelete(
  rawOwnerId: string,
  rootId: number,
  folders: readonly FolderDeleteFolderRow[],
  files: readonly FolderDeleteFileRow[],
): { folderIds: number[]; fileIds: number[] } {
  const ownerId = dataContext(rawOwnerId).ownerId
  if (!Number.isSafeInteger(rootId) || rootId < 1) throw new CoreError('invalid_request', '文件夹 ID 无效')
  const owned = folders.filter(row => row.user_id.toLowerCase() === ownerId && row.deleted_at == null)
  const root = owned.find(row => Number(row.id) === rootId)
  if (!root) throw new CoreError('not_found', '文件夹不存在')

  const children = new Map<number, number[]>()
  for (const row of owned) {
    if (row.parent_id == null) continue
    const parentId = Number(row.parent_id), id = Number(row.id)
    const values = children.get(parentId) ?? []
    values.push(id)
    children.set(parentId, values)
  }
  const folderIds: number[] = [], visited = new Set<number>(), pending = [rootId]
  while (pending.length) {
    const id = pending.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    folderIds.push(id)
    pending.push(...(children.get(id) ?? []))
  }
  const subtree = new Set(folderIds)
  const fileIds = files.filter(row => row.user_id.toLowerCase() === ownerId && row.deleted_at == null
    && row.folder_id != null && subtree.has(Number(row.folder_id))).map(row => Number(row.id))
  return { folderIds, fileIds }
}
