import { CoreError, dataContext } from '@gugu/core'
import type { DataServices, Fields, ProjectRecord, Stage } from '@gugu/core'
import type { SqlDataRuntime } from '@gugu/core/data'

export interface AgentProjectUpdateArgs extends Record<string, unknown> {
  project_id?: number
  project?: string
  status?: string
  priority?: string
  deadline?: string | null
  start_date?: string | null
  client?: string | null
  project_name?: string
  summary?: string | null
}

export type AgentProjectUpdateResult =
  | { success: true; project_id: number; name: string; priority: string | null }
  | string

function toolError(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ error: message, ...extra })
}

async function resolveProject(
  data: DataServices,
  args: AgentProjectUpdateArgs,
): Promise<{ project: ProjectRecord | null; error: string | null }> {
  if (args.project_id) {
    const project = await data.projects.get(args.project_id)
    return project
      ? { project, error: null }
      : { project: null, error: toolError('项目不存在') }
  }
  if (args.project) {
    const name = String(args.project).trim()
    const rows = [
      ...await data.projects.list(false),
      ...await data.projects.list(true),
    ]
    const exact = rows.filter(project => project.name === name)
    const matching = exact.length > 0
      ? exact
      : rows.filter(project => project.name.toLocaleLowerCase().includes(name.toLocaleLowerCase()))
    if (matching.length === 0) {
      const activeNames = await data.projects.list(false)
      return {
        project: null,
        error: toolError(`未找到名为「${name}」的项目`, {
          available_projects: [...new Set(activeNames.map(project => project.name))].sort().slice(0, 20),
        }),
      }
    }
    const active = matching.filter(project => !project.archived)
    const pool = active.length > 0 ? active : matching
    if (pool.length > 1)
      return {
        project: null,
        error: toolError(`有多个匹配「${name}」的项目，请指明是哪个`, {
          candidates: pool.slice(0, 10).map(({ id, name: projectName, status }) => ({
            id, name: projectName, status,
          })),
        }),
      }
    return { project: pool[0]!, error: null }
  }
  return { project: null, error: toolError('需提供 project_id 或项目名 project') }
}

function updateFields(project: ProjectRecord, args: AgentProjectUpdateArgs): Fields {
  const fields: Fields = {}
  if ('status' in args) {
    if (args.status === 'done' && project.done_at === null) {
      const stages = JSON.parse(project.stages_json) as Stage[]
      for (const stage of stages) {
        stage.todos = (stage.todos ?? []).map(todo => todo.done
          ? todo
          : { ...todo, _savedDone: false, done: true, autoCompleted: true })
      }
      fields.stages = stages
      if (stages.length > 0) fields.current_stage = stages[stages.length - 1]!.key
      fields.progress = 100
    }
    fields.status = args.status
  }
  if ('priority' in args) {
    const priority = typeof args.priority === 'string' ? args.priority.trim().toLowerCase() : ''
    fields.priority = ['high', 'medium', 'low'].includes(priority) ? priority : null
  }
  for (const field of ['deadline', 'start_date', 'client'] as const)
    if (field in args) fields[field] = args[field]
  if ('project_name' in args) fields.name = args.project_name
  if ('summary' in args) fields.summary = args.summary
  return fields
}

/** Agent 项目更新只经 Core owner-scoped CAS 事务，不附加 Web Undo、确认门或事件。 */
export function createAgentProjectUpdateTool(core: SqlDataRuntime) {
  return async function updateAgentProject(
    authenticatedOwnerId: string,
    args: AgentProjectUpdateArgs,
  ): Promise<AgentProjectUpdateResult> {
    try {
      return await core.transaction(dataContext(authenticatedOwnerId), async data => {
        const resolved = await resolveProject(data, args)
        if (resolved.error) return resolved.error
        const project = resolved.project!
        const fields = updateFields(project, args)
        if (Object.keys(fields).length === 0)
          return toolError('未提供可更新的项目内容')
        const updated = await data.projects.update(project.id, project.version, fields)
        return {
          success: true,
          project_id: updated.id,
          name: updated.name,
          priority: updated.priority,
        }
      })
    } catch (error) {
      if (error instanceof CoreError)
        return toolError(
          error.code === 'conflict' || error.code === 'not_found'
            ? '项目刚被其他端修改，请重试'
            : error.message,
        )
      throw error
    }
  }
}
