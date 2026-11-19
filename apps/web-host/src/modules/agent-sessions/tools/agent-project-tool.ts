import { CoreError } from '@gugu/core'
import { createAgentProjectCreator } from '@gugu/core/tools'
import { createHash } from 'node:crypto'
import type { ProjectCreateRuntime } from '@gugu/core/project-create'

export interface AgentProjectDispatch {
  sessionId: number | null
  toolCallId: string | null
  runId?: string
  roundId?: string
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

export function agentProjectDispatchKey(dispatch: AgentProjectDispatch): string | null {
  if (dispatch.runId !== undefined || dispatch.roundId !== undefined) {
    if (!dispatch.sessionId || !dispatch.toolCallId || !dispatch.runId || !dispatch.roundId)
      throw new CoreError('invalid_request', '工具运行身份无效')
    const tuple = JSON.stringify([dispatch.sessionId, dispatch.runId, dispatch.roundId, dispatch.toolCallId])
    return `agent:v2:${createHash('sha256').update(tuple).digest('hex')}`
  }
  if (dispatch.sessionId === null || !dispatch.toolCallId) return null
  return `agent:${dispatch.sessionId}:create_project:${dispatch.toolCallId}`
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
