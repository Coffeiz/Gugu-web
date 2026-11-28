import { strip } from '../../../shared/values.js'
import { dataContext } from '../../../contracts/index.js'
import type { ProjectRecord } from '../../../contracts/index.js'
import type { DataServices } from '../../../data/services.js'
import type { SqlDataRuntime } from '../../../data/runtime.js'
import type { RunIdentity } from '../../models.js'

export interface ProjectSelector { project_id?: number; project?: string }
export interface ProjectSelectionError {
  error: string
  candidates?: readonly { id: number; name: string; status: string }[]
  available_projects?: readonly string[]
}

/** 只投影Agent定位语义；精确/模糊匹配由共享owner仓储执行。 */
export async function resolveProject(data: DataServices, args: ProjectSelector): Promise<ProjectRecord | ProjectSelectionError> {
  if (args.project_id && args.project_id < 0) return { error: '项目不存在' }
  if (args.project_id) return await data.projects.get(args.project_id) ?? { error: '项目不存在' }
  if (!args.project) return { error: '需提供 project_id 或项目名 project' }
  const name = strip(args.project)
  const rows = await data.projects.findByName(name)
  if (!rows.length) return { error: `未找到名为「${name}」的项目`,
    available_projects: [...new Set((await data.projects.list(false)).map(project => project.name))].sort().slice(0, 20) }
  const unarchived = rows.filter(project => !project.archived)
  const pool = unarchived.length ? unarchived : rows
  if (pool.length > 1) return { error: `有多个匹配「${name}」的项目，请指明是哪个`,
    candidates: pool.slice(0, 10).map(project => ({ id: project.id, name: project.name, status: project.status })) }
  return pool[0]!
}

/** 可注入查询工具及修改桥接；Host仍负责提供真实共享事务适配器。 */
export function createProjectResolver(core: SqlDataRuntime) {
  return (identity: RunIdentity, selector: ProjectSelector, signal: AbortSignal) =>
    core.transaction(dataContext(identity.ownerId), data => resolveProject(data, selector), { signal })
}
