/**
 * 文件库导航「路径投影规则」——纯函数：从点中的文件夹卡片 + 当前面包屑，算出新面包屑。
 *
 * 从 Files/index.vue 的 enterFolder 抽出（P2④ 子步 a），**只搬路径构建**：不含选择清理 /
 * saveNav / loadContents / 历史栈 等副作用编排（那些留在 enterFolder 壳里）。行为逐字等价——
 * String()/非空断言仅为在 strict 下编译，运行时与原 loose 实现完全一致（含「month 取 year 段」
 * 的 yearSeg 缺失潜伏 bug，本刀不修，异常路径的防御另开一刀）。
 */

export interface NavSeg {
  type: string
  name: string
  color?: string | null
  id?: number | null
  status?: string | null
  year?: string | number | null
  month?: string | number | null
  folderId?: number | null
  projectId?: number | null
  space?: string
}

// 文件夹「卡片视图模型」——loadContents 投影出的 6 种卡（personal/projects/trash/folder/
// status/year/month/project）的并集：公共字段必填，各变体字段可选。非 FolderMeta（那是库存原型）。
export interface FolderCard {
  id: string
  type: string
  displayName: string
  count: number | null
  folderId?: number
  color?: string | null
  space?: string
  projectId?: number | null
  status?: string
  year?: string | number
  month?: string
}

/**
 * 点某张文件夹卡 → 新面包屑。依据卡片 type 与当前路径（用于保留上下文，如 month 需当前 year 段、
 * project 保留 status/year/month、folder-in-folder 追加）。未知 type 原样返回当前路径（原实现无 else，
 * navPath 不变）。
 */
export function navPathFor(folder: FolderCard, currentPath: NavSeg[]): NavSeg[] {
  if (folder.type === 'personal') {
    return [{ type: 'personal', name: '个人文件', color: null }]
  }
  if (folder.type === 'projects') {
    return [{ type: 'projects', name: '项目文件', color: null }]
  }
  if (folder.type === 'trash') {
    return [{ type: 'trash', name: '回收站', color: null }]
  }
  if (folder.type === 'status') {
    return [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: folder.status, name: folder.displayName, color: null },
    ]
  }
  if (folder.type === 'year') {
    return [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year', name: String(folder.year) + ' 年', year: folder.year, color: null },
    ]
  }
  if (folder.type === 'month') {
    const yearSeg = currentPath.find(s => s.type === 'year')
    return [
      { type: 'projects', name: '项目文件', color: null },
      { type: 'status', status: 'done', name: '已完成', color: null },
      { type: 'year', name: String(yearSeg!.year) + ' 年', year: yearSeg!.year, color: null },
      { type: 'month', name: parseInt(String(folder.month)) + ' 月', year: folder.year, month: folder.month, color: null },
    ]
  }
  if (folder.type === 'project') {
    // 保留 状态 + 年月 上下文
    const path: NavSeg[] = [{ type: 'projects', name: '项目文件', color: null }]
    const statusSeg = currentPath.find(s => s.type === 'status')
    const yearSeg = currentPath.find(s => s.type === 'year')
    const monthSeg = currentPath.find(s => s.type === 'month')
    if (statusSeg) path.push({ ...statusSeg })
    if (yearSeg) path.push({ ...yearSeg })
    if (monthSeg) path.push({ ...monthSeg })
    path.push({ type: 'project', id: folder.projectId, name: folder.displayName, color: folder.color })
    return path
  }
  if (folder.type === 'folder') {
    const seg = currentPath[currentPath.length - 1] ?? null
    if (seg?.type === 'personal') {
      return [
        { type: 'personal', name: '个人文件', color: null },
        { type: 'folder', folderId: folder.folderId, name: folder.displayName, color: null, space: 'personal' },
      ]
    }
    if (seg?.type === 'folder') {
      // 已在某个文件夹内，直接追加子文件夹
      return [
        ...currentPath,
        { type: 'folder', folderId: folder.folderId, name: folder.displayName,
          projectId: folder.projectId ?? seg.projectId, color: folder.color ?? seg.color },
      ]
    }
    // 保留到 project 层，追加 folder
    const projIdx = currentPath.findIndex(s => s.type === 'project')
    const projectSeg = currentPath.find(s => s.type === 'project') ?? null
    const basePath: NavSeg[] = projIdx >= 0
      ? currentPath.slice(0, projIdx + 1)
      : [{ type: 'projects', name: '项目文件', color: null },
         { type: 'project', id: folder.projectId, name: projectSeg?.name ?? '', color: folder.color }]
    return [
      ...basePath,
      { type: 'folder', folderId: folder.folderId, name: folder.displayName, projectId: folder.projectId, color: folder.color },
    ]
  }
  return currentPath
}
