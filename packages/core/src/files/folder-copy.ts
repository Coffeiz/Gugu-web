export interface FolderCopyTreeNode {
  id: number
  parentId: number | null
  name: string
}

export interface FolderCopyPlanNode {
  sourceId: number
  parentSourceId: number | null
  targetParentId: number | null
  name: string
}

/** 按 Python FileService 的层级顺序构造副本计划，并固定同层 ID 顺序。 */
export function planFolderCopyTree(
  sourceRootId: number,
  source: readonly FolderCopyTreeNode[],
  targetParentId: number | null,
): FolderCopyPlanNode[] {
  const byId = new Map<number, FolderCopyTreeNode>()
  const children = new Map<number, FolderCopyTreeNode[]>()
  for (const folder of source) {
    if (!Number.isSafeInteger(folder.id) || folder.id <= 0 || byId.has(folder.id))
      throw new TypeError('文件夹子树包含无效或重复 ID')
    byId.set(folder.id, folder)
  }
  const root = byId.get(sourceRootId)
  if (!root) throw new TypeError('源文件夹不存在')
  for (const folder of source) {
    if (folder.id === sourceRootId) continue
    if (folder.parentId === null || !byId.has(folder.parentId))
      throw new TypeError('文件夹子树结构无效')
    const siblings = children.get(folder.parentId) ?? []
    siblings.push(folder)
    children.set(folder.parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.id - right.id)
  if (targetParentId !== null && byId.has(targetParentId))
    throw new TypeError('不能复制到自身或其子文件夹中')

  const plan: FolderCopyPlanNode[] = []
  const visited = new Set<number>()
  const queue: Array<{ folder: FolderCopyTreeNode; parentSourceId: number | null }> = [{ folder: root, parentSourceId: null }]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { folder, parentSourceId } = queue[cursor]!
    if (visited.has(folder.id)) throw new TypeError('文件夹子树存在循环')
    visited.add(folder.id)
    plan.push({
      sourceId: folder.id,
      parentSourceId,
      targetParentId: parentSourceId === null ? targetParentId : null,
      name: folder.name,
    })
    for (const child of children.get(folder.id) ?? []) queue.push({ folder: child, parentSourceId: folder.id })
  }
  if (visited.size !== source.length) throw new TypeError('文件夹子树结构无效')
  return plan
}

/** 与 Python 的 name(1)、name(2) 冲突重命名规则一致。 */
export function nextFolderCopyName(name: string, isOccupied: (candidate: string) => boolean): string {
  if (!isOccupied(name)) return name
  for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${name}(${suffix})`
    if (!isOccupied(candidate)) return candidate
  }
  throw new Error('无法为副本分配文件夹名称')
}
