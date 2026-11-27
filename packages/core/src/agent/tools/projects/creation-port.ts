import { createHash } from 'node:crypto'
import { CoreError } from '../../../contracts/index.js'
import type { Fields, Stage } from '../../../contracts/index.js'
import { createDeferredProjectCreator, ProjectCreateIdempotencyConflictError, ProjectCreateValidationError, validateProjectCreateFields } from '../../../projects/project-create.js'
import type { ProjectCreateRuntime } from '../../../projects/project-create.js'
import { DEFAULT_PROJECT_COLOR, projectColorValue } from '../../../projects/colors.js'
import { normalizeProjectStages } from '../../../projects/domain.js'
import type { RunIdentity } from '../../models.js'
import type { CreateProjectToolResult, ProjectCreatePort } from './tools.js'

const defaultStages: readonly Stage[] = [
  { key: 's0', label: '计划', todos: [] },
  { key: 's1', label: '执行', todos: [] },
  { key: 's2', label: '交付', todos: [] },
]

export interface ProjectCreationPortOptions {
  readonly runtime: ProjectCreateRuntime
  /** Host 保持平台既有键编码；只由可信调用身份派生，不能根据业务名称猜重复。 */
  keyForCall(scope: { readonly identity: RunIdentity; readonly roundId: string; readonly toolCallId: string }): Promise<string> | string
}

export interface AgentProjectCreationArguments extends Record<string, unknown> {
  project_name: string
  start_date: string
  deadline: string
}

function fields(args: AgentProjectCreationArguments): Fields {
  const stages = args.stages === undefined ? defaultStages.map(stage => ({ ...stage, todos: [] })) : normalizeProjectStages(args.stages)
  const priority = typeof args.priority === 'string' ? args.priority.trim().toLowerCase() : ''
  const color = typeof args.color === 'string' ? projectColorValue(args.color) : null
  return {
    name: args.project_name, client: args.client ?? null, summary: args.summary ?? null,
    start_date: args.start_date, deadline: args.deadline, status: args.status === undefined ? 'pending' : args.status,
    color: color ?? DEFAULT_PROJECT_COLOR,
    priority: ['high', 'medium', 'low'].includes(priority) ? priority : null, stages, current_stage: stages[0]!.key,
  }
}

/** 旧直接调用与 Harness 工具共用的业务映射；平台只负责身份和幂等键编码。 */
export function createAgentProjectCreator(runtime: ProjectCreateRuntime) {
  return async (ownerId: string, args: AgentProjectCreationArguments, options: {
    idempotencyKey: string | null
    signal?: AbortSignal
    includeModelFailure?: boolean
  }): Promise<CreateProjectToolResult> => {
    options.signal?.throwIfAborted()
    let transactionError: unknown
    const create = createDeferredProjectCreator({
      async transaction(work) {
        let callbackError: unknown
        try {
          return await runtime.transaction(async tx => {
            try { return await work(tx) } catch (error) { callbackError = error; throw error }
          })
        } catch (error) {
          if (error !== callbackError) transactionError = error
          throw error
        }
      },
      publishProjectCreated: event => runtime.publishProjectCreated(event),
      isUniqueViolation: error => runtime.isUniqueViolation(error),
    })
    try {
      const result = await create(ownerId, () => validateProjectCreateFields(() => fields(args)), {
        idempotencyKey: options.idempotencyKey, fingerprintPayload: args, includeAgentFields: true,
        selectUnusedColor: args.color === undefined, publishEvent: false, signal: options.signal,
      })
      // 提交后的取消不能把真实创建伪装成未执行。
      const stages = JSON.parse(result.project.stages_json) as Stage[]
      return {
        success: true, project_id: result.project.id, name: result.project.name,
        stages: stages.map(stage => stage.label),
        stage_details: stages.map(stage => ({ key: stage.key, label: stage.label, todo_count: stage.todos?.length ?? 0 })),
        current_stage: result.project.current_stage,
        ...(result.created ? {} : { idempotent_replay: true }),
      }
    } catch (error) {
      if (error !== transactionError && error instanceof CoreError) return { success: false, error: error.message, error_code: error.code,
        ...(options.includeModelFailure && error instanceof ProjectCreateValidationError ? { modelFailure: 'validation' as const }
          : options.includeModelFailure && error instanceof ProjectCreateIdempotencyConflictError ? { modelFailure: 'idempotency_conflict' as const } : {}) }
      // COMMIT 自身即使抛领域同名错误也不能证明未提交，交由 registry 标为 unknown。
      throw error
    }
  }
}

/** 正式工具路径必须具有完整调用身份；弱身份旧入口不能通过该端口绕过。 */
export function createProjectCreationPort(options: ProjectCreationPortOptions): ProjectCreatePort {
  const create = createAgentProjectCreator(options.runtime)
  return {
    async create(request) {
      request.signal.throwIfAborted()
      if (!request.identity.runId || !request.identity.sessionId || !request.roundId || !request.toolCallId)
        return { success: false, error: '工具运行身份无效' }
      let key: string
      try {
        key = await options.keyForCall({ identity: request.identity, roundId: request.roundId, toolCallId: request.toolCallId })
      } catch (error) {
        if (error instanceof CoreError) return { success: false, error: error.message, error_code: error.code }
        throw error
      }
      request.signal.throwIfAborted()
      if (typeof key !== 'string' || !key.trim()) return { success: false, error: '工具幂等标识无效' }
      return create(request.identity.ownerId, request.args, { idempotencyKey: key, signal: request.signal, includeModelFailure: true })
    },
  }
}

export interface AgentProjectDispatch {
  sessionId: number | `scheduled-task:${number}` | null
  toolCallId: string | null
  runId?: string
  roundId?: string
}

export function agentProjectDispatchKey(dispatch: AgentProjectDispatch): string | null {
  if (dispatch.runId !== undefined || dispatch.roundId !== undefined) {
    if (!dispatch.sessionId || !dispatch.toolCallId || !dispatch.runId || !dispatch.roundId)
      throw new CoreError('invalid_request', '工具运行身份无效')
    const tuple = JSON.stringify([dispatch.sessionId, dispatch.runId, dispatch.roundId, dispatch.toolCallId])
    return `agent:v2:${createHash('sha256').update(tuple).digest('hex')}`
  }
  if (dispatch.sessionId === null || typeof dispatch.sessionId !== 'number' || !dispatch.toolCallId) return null
  return `agent:${dispatch.sessionId}:create_project:${dispatch.toolCallId}`
}
