import { CoreError } from '@gugu/core'
import { agentProjectDispatchKey, createAgentProjectCreator, type AgentProjectDispatch } from '@gugu/core/tools'
export { agentProjectDispatchKey, type AgentProjectDispatch } from '@gugu/core/tools'
import type { ProjectCreateRuntime } from '@gugu/core/project-create'

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

/** 保留既有调用身份编码；项目创建规则由 Core 共用。 */
export function createAgentProjectTool(runtime: ProjectCreateRuntime) {
  const createProject = createAgentProjectCreator(runtime)
  return async function createAgentProject(
    authenticatedOwnerId: string,
    args: AgentProjectArgs,
    dispatch: AgentProjectDispatch,
  ): Promise<AgentProjectToolResult> {
    let idempotencyKey: string | null
    try {
      idempotencyKey = agentProjectDispatchKey(dispatch)
    } catch (error) {
      if (error instanceof CoreError)
        return { success: false, error: error.message, error_code: error.code }
      throw error
    }
    return createProject(authenticatedOwnerId, args, { idempotencyKey })
  }
}
