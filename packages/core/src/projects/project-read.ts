import { CoreError, dataContext } from '../contracts/index.js'
import type { SqlDataRuntime } from '../data/runtime.js'
import { projectResponse } from './project-projection.js'
export { projectResponse } from './project-projection.js'

export interface ProjectReadOptions { readonly signal?: AbortSignal }
export interface ProjectFileCountPort {
  forProjects(ownerId: string, projectIds: readonly number[], signal?: AbortSignal): Promise<ReadonlyMap<number, number>>
  list(ownerId: string, signal?: AbortSignal): Promise<readonly { projectId: number; fileCount: number }[]>
}
function owner(raw: string): string {
  try { return dataContext(raw).ownerId }
  catch { throw new CoreError('invalid_request', '用户 ID 无效') }
}
export function createProjectListing(core: SqlDataRuntime, counts: ProjectFileCountPort, now: () => number = Date.now) {
  return async (rawOwner: string, archived = false, deleted = false, options: ProjectReadOptions = {}) => {
    const signal = options.signal
    signal?.throwIfAborted()
    const ownerId = owner(rawOwner)
    if (typeof archived !== 'boolean' || typeof deleted !== 'boolean') throw new CoreError('invalid_request', '查询参数必须是 true 或 false')
    if (archived && deleted) throw new CoreError('invalid_request', 'archived 和 deleted 不能同时为 true')
    const projects = await core.transaction(dataContext(ownerId), data => deleted
      ? data.projects.listDeleted(new Date(now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      : data.projects.list(archived), { signal }).finally(() => signal?.throwIfAborted())
    signal?.throwIfAborted()
    if (projects.length === 0) return []
    const files = await counts.forProjects(ownerId, projects.map(project => project.id), signal)
      .finally(() => signal?.throwIfAborted())
    return projects.map(project => projectResponse(project, files.get(project.id) ?? 0))
  }
}
export function createProjectGetter(core: SqlDataRuntime, counts: ProjectFileCountPort) {
  return async (rawOwner: string, projectId: number, options: ProjectReadOptions = {}) => {
    const signal = options.signal
    signal?.throwIfAborted()
    const ownerId = owner(rawOwner)
    if (!Number.isSafeInteger(projectId)) throw new CoreError('invalid_request', '项目标识无效')
    const project = await core.transaction(dataContext(ownerId), data => data.projects.get(projectId), { signal })
      .finally(() => signal?.throwIfAborted())
    signal?.throwIfAborted()
    if (!project) return null
    const files = await counts.forProjects(ownerId, [project.id], signal).finally(() => signal?.throwIfAborted())
    return projectResponse(project, files.get(project.id) ?? 0)
  }
}
export function createProjectFileCountListing(counts: ProjectFileCountPort) {
  return async (rawOwner: string, options: ProjectReadOptions = {}) => {
    const signal = options.signal
    signal?.throwIfAborted()
    const ownerId = owner(rawOwner)
    const rows = await counts.list(ownerId, signal).finally(() => signal?.throwIfAborted())
    return rows.map(row => ({ projectId: row.projectId, fileCount: row.fileCount }))
  }
}
