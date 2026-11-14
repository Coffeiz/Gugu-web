/**
 * 把「项目数组」聚合成文件库里的分组文件夹卡——纯函数，从 Files/index.vue 的 loadContents
 * 抽出（P2④ 子步 c 的安全子集：只抽纯计算，不碰 store 编排 / contents 写入 / 派发器主循环）。
 *
 * 三种分组，行为逐字保持：
 *   - statusFolders：按状态计数 → 状态卡（空组不显示，顺序随 kanbanColumns）
 *   - yearFolders：已完成项目按完成年份计数 → 年卡（年份降序）
 *   - monthFolders：某年的已完成项目按完成月份计数 → 月卡（月份升序）
 */
import { doneYear, doneMonth } from './fileParse'
import type { FolderCard } from './filesNav'

type StatusProject = { status: string }
type DoneProject = { status: string; doneAt?: string | null; startDate?: string | null; createdAt?: string | null }

export function statusFolders(
  projects: StatusProject[],
  kanbanColumns: Array<{ key: string; label: string }>,
): FolderCard[] {
  const cnt: Record<string, number> = {}
  for (const p of projects) cnt[p.status] = (cnt[p.status] || 0) + 1
  return kanbanColumns
    .filter(c => (cnt[c.key] || 0) > 0)
    .map(c => ({ id: `st:${c.key}`, type: 'status', status: c.key, displayName: c.label, count: cnt[c.key] }))
}

export function yearFolders(projects: DoneProject[]): FolderCard[] {
  const yearMap: Record<string, number> = {}
  for (const p of projects) {
    if (p.status !== 'done') continue
    const y = doneYear(p)
    yearMap[y] = (yearMap[y] || 0) + 1
  }
  return Object.keys(yearMap)
    .sort((a, b) => b.localeCompare(a))
    .map(y => ({ id: `y:${y}`, type: 'year', displayName: y + ' 年', year: y, count: yearMap[y] }))
}

export function monthFolders(projects: DoneProject[], year: string | number): FolderCard[] {
  const monthMap: Record<string, number> = {}
  for (const p of projects) {
    if (p.status !== 'done' || doneYear(p) !== year) continue
    const m = doneMonth(p)
    monthMap[m] = (monthMap[m] || 0) + 1
  }
  return Object.keys(monthMap)
    .sort()
    .map(m => ({ id: `m:${year}-${m}`, type: 'month', displayName: parseInt(m) + ' 月', year, month: m, count: monthMap[m] }))
}
