import {
  CoreError,
  DEFAULT_PROJECT_COLOR,
  normalizeProjectStages,
  projectColorValue,
} from '@gugu/core'
import type { Fields, Stage } from '@gugu/core'
import { createProjectCreator } from '../../projects/application/project-create.js'
import type { ProjectCreateRuntime } from '../../projects/application/project-create.js'

export interface AgentProjectDispatch {
  sessionId: number | null
  toolCallId: string | null
}

export interface AgentProjectArgs extends Record<string, unknown> {
  project_name: string
  start_date: string
  deadline: string
}

export interface AgentProjectToolResult {
  success: boolean
  project_id?: number
  name?: string
  stages?: string[]
  stage_details?: Array<{ key: string; label: string; todo_count: number }>
  current_stage?: string | null
  idempotent_replay?: boolean
  error?: string
  error_code?: string
}

const DEFAULT_STAGES: Stage[] = [
  { key: 's0', label: '计划', todos: [] },
  { key: 's1', label: '执行', todos: [] },
  { key: 's2', label: '交付', todos: [] },
]

function dispatchKey(dispatch: AgentProjectDispatch): string | null {
  if (dispatch.sessionId === null || !dispatch.toolCallId) return null
  return `agent:${dispatch.sessionId}:create_project:${dispatch.toolCallId}`
}

function projectFields(args: AgentProjectArgs): Fields {
  const stages = args.stages === undefined
    ? DEFAULT_STAGES.map(stage => ({ ...stage, todos: [] }))
    : normalizeProjectStages(args.stages)
  const priority = typeof args.priority === 'string' ? args.priority.trim().toLowerCase() : ''
  const color = typeof args.color === 'string' ? projectColorValue(args.color) : null
  return {
    name: args.project_name,
    summary: args.summary === undefined ? null : args.summary,
    client: args.client === undefined ? null : args.client,
    status: args.status === undefined ? 'pending' : args.status,
    start_date: args.start_date,
    deadline: args.deadline,
    color: color ?? DEFAULT_PROJECT_COLOR,
    priority: ['high', 'medium', 'low'].includes(priority) ? priority : null,
    stages,
    current_stage: stages[0]!.key,
  }
}

/** Agent 项目创建 wrapper：复用 Core 创建事务，但不写 Web Undo 或发 Web 事件。 */
export function createAgentProjectTool(runtime: ProjectCreateRuntime) {
  const createProject = createProjectCreator(runtime)
  return async function createAgentProject(
    authenticatedOwnerId: string,
    args: AgentProjectArgs,
    dispatch: AgentProjectDispatch,
  ): Promise<AgentProjectToolResult> {
    let fields: Fields
    try {
      fields = projectFields(args)
    } catch (error) {
      if (error instanceof CoreError)
        return { success: false, error: error.message, error_code: error.code }
      throw error
    }

    try {
      const result = await createProject(authenticatedOwnerId, fields, {
        idempotencyKey: dispatchKey(dispatch),
        fingerprintPayload: args,
        includeAgentFields: true,
        publishEvent: false,
      })
      const stages = JSON.parse(result.project.stages_json) as Stage[]
      return {
        success: true,
        project_id: result.project.id,
        name: result.project.name,
        stages: stages.map(stage => stage.label),
        stage_details: stages.map(stage => ({
          key: stage.key,
          label: stage.label,
          todo_count: stage.todos?.length ?? 0,
        })),
        current_stage: result.project.current_stage,
        ...(result.created ? {} : { idempotent_replay: true }),
      }
    } catch (error) {
      if (error instanceof CoreError)
        return { success: false, error: error.message, error_code: error.code }
      throw error
    }
  }
}
