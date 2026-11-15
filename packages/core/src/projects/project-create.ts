import { createHash, randomInt } from 'node:crypto'
import { CoreError, dataContext } from '../contracts/index.js'
import type { Fields, ProjectRecord } from '../contracts/index.js'
import { prepareProjectCreate } from './domain.js'
import { DEFAULT_PROJECT_COLOR, PROJECT_COLOR_PRESETS } from './colors.js'
import { projectResponse } from './project-projection.js'

/** 只标记项目字段业务校验，保留原有 invalid_request 与消息。 */
export class ProjectCreateValidationError extends CoreError {
  constructor(message: string) {
    super('invalid_request', message)
    this.name = 'ProjectCreateValidationError'
  }
}

/** 仅表示同一幂等键对应的创建内容不同。 */
export class ProjectCreateIdempotencyConflictError extends CoreError {
  constructor() {
    super('conflict', '该 Idempotency-Key 已用于不同的创建内容')
    this.name = 'ProjectCreateIdempotencyConflictError'
  }
}

/** 可供调用方包裹创建前的字段归一化，不得用于身份、幂等或事务错误。 */
export function validateProjectCreateFields<T>(work: () => T): T {
  try { return work() }
  catch (error) {
    if (error instanceof ProjectCreateValidationError) throw error
    if (error instanceof CoreError && error.code === 'invalid_request')
      throw new ProjectCreateValidationError(error.message)
    throw error
  }
}

export interface ProjectCreateRecord extends ProjectRecord {
  idempotency_fingerprint: string | null
}

export interface ProjectCreateUndoRecord {
  userId: string
  contextId: string
  resource: 'projects'
  action: 'create'
  targetRefs: Array<{ kind: 'project'; id: number }>
  beforeState: { items: Record<string, never> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, { version: 0 }>
}

export interface ProjectCreatedEvent {
  userId: string
  resource: 'projects'
  origin: string | null
  operation: 'create'
  entityId: number
  payload: Record<string, unknown>
}

export interface ProjectCreateTransaction {
  findIdempotent(ownerId: string, keyHash: string): Promise<ProjectCreateRecord | null>
  listActiveColors?(ownerId: string): Promise<string[]>
  insertProject(
    ownerId: string,
    fields: Fields,
    idempotency: { keyHash: string; fingerprint: string } | null,
  ): Promise<ProjectCreateRecord>
  recordUndo(record: ProjectCreateUndoRecord): Promise<void>
}

/** Host adapter: the transaction must map to one database transaction including Undo. */
export interface ProjectCreateRuntime {
  transaction<T>(work: (tx: ProjectCreateTransaction) => Promise<T>): Promise<T>
  publishProjectCreated(event: ProjectCreatedEvent): Promise<void>
  isUniqueViolation(error: unknown): boolean
}

export interface ProjectCreateOptions {
  signal?: AbortSignal
  idempotencyKey?: string | null
  undoContextId?: string | null
  clientId?: string | null
  /** Agent 创建按 Python 原始工具参数计算 fingerprint，不采用归一化后的数据库字段。 */
  fingerprintPayload?: unknown
  /** Agent 工具写入摘要与优先级；默认保持现有 Web 创建字段映射。 */
  includeAgentFields?: boolean
  /** 默认发送 Web 项目事件；Agent 工具显式关闭以保持其 Python 行为。 */
  publishEvent?: boolean
  /** Agent 未指定有效颜色时，在事务中选择用户尚未使用的预设。 */
  selectUnusedColor?: boolean
}

export interface ProjectCreateResult {
  project: ProjectCreateRecord
  created: boolean
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function idempotencyValues(key: string | null | undefined, payload: unknown) {
  if (key == null) return null
  const normalized = String(key).trim()
  if (!normalized || normalized.length > 256)
    throw new CoreError('invalid_request', 'Idempotency-Key 必须为 1 至 256 个字符')
  return { keyHash: digest(normalized), fingerprint: digest(canonical(payload)) }
}

function createPayload(input: Fields, includeAgentFields: boolean): Fields {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new CoreError('invalid_request', '请求内容必须是对象')
  // HTTP callers send Python's CamelModel aliases; internal callers still use snake_case.
  // Prefer the public camelCase property if both spellings are supplied, including explicit null.
  const startDate = input.startDate === undefined ? input.start_date : input.startDate
  const currentStage = input.currentStage === undefined ? input.current_stage : input.currentStage
  const payload: Fields = {
    name: input.name,
    client: input.client === undefined ? null : input.client,
    status: input.status === undefined ? 'pending' : input.status,
    start_date: startDate === undefined ? null : startDate,
    deadline: input.deadline === undefined ? null : input.deadline,
    color: input.color === undefined ? DEFAULT_PROJECT_COLOR : input.color,
    stages: input.stages === undefined ? [] : input.stages,
    current_stage: currentStage === undefined ? null : currentStage,
    progress: input.progress === undefined ? 0 : input.progress,
  }
  if (includeAgentFields) {
    payload.summary = input.summary === undefined ? null : input.summary
    payload.priority = input.priority === undefined ? null : input.priority
  }
  return payload
}

function projectSnapshot(project: ProjectRecord): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    client: project.client,
    status: project.status,
    start_date: project.start_date,
    deadline: project.deadline,
    color: project.color,
    progress: project.progress,
    stages: JSON.parse(project.stages_json),
    current_stage: project.current_stage,
    priority: project.priority,
    archived: false,
    done_at: project.done_at,
    version: Number(project.version || 1),
    deleted_at: project.deleted_at,
  }
}

function makeUndoRecord(ownerId: string, context: string, project: ProjectRecord): ProjectCreateUndoRecord {
  const ref = `project:${project.id}`
  return {
    userId: ownerId,
    contextId: context.slice(0, 128),
    resource: 'projects',
    action: 'create',
    targetRefs: [{ kind: 'project', id: project.id }],
    beforeState: { items: {} },
    afterState: { items: { [ref]: projectSnapshot(project) } },
    baseVersions: { [ref]: { version: 0 } },
  }
}

function projectCreator(runtime: ProjectCreateRuntime, deferred: boolean) {
  return async function createProject(
    authenticatedOwnerId: string,
    input: Fields | (() => Fields),
    options: ProjectCreateOptions = {},
  ): Promise<ProjectCreateResult> {
    let ownerId: string
    try { ownerId = dataContext(authenticatedOwnerId).ownerId }
    catch (error) {
      if (error instanceof CoreError) throw error
      throw new CoreError('invalid_request', error instanceof Error ? error.message : '用户标识无效')
    }
    if (deferred && options.fingerprintPayload === undefined)
      throw new CoreError('invalid_request', '延迟创建必须提供原始幂等内容')
    const prepare = () => validateProjectCreateFields(() => prepareProjectCreate(createPayload(
      typeof input === 'function' ? input() : input, options.includeAgentFields === true,
    )))
    const fields = deferred ? undefined : prepare()
    const idem = idempotencyValues(options.idempotencyKey, deferred ? options.fingerprintPayload : options.fingerprintPayload ?? fields)
    const checkCancelled = () => {
      if (options.signal?.aborted) throw new CoreError('cancelled', '项目创建已取消')
    }

    let result: ProjectCreateResult
    try {
      result = await runtime.transaction(async (tx) => {
        checkCancelled()
        if (idem) {
          const existing = await tx.findIdempotent(ownerId, idem.keyHash)
          checkCancelled()
          if (existing) {
            if (existing.idempotency_fingerprint !== idem.fingerprint)
              throw new ProjectCreateIdempotencyConflictError()
            return { project: existing, created: false }
          }
        }
        checkCancelled()
        let insertFields = fields ?? prepare()
        checkCancelled()
        if (options.selectUnusedColor) {
          if (!tx.listActiveColors) throw new Error('项目颜色查询未配置')
          const used = new Set(await tx.listActiveColors(ownerId))
          checkCancelled()
          const unused = PROJECT_COLOR_PRESETS.filter(color => !used.has(color))
          const pool = unused.length ? unused : PROJECT_COLOR_PRESETS
          insertFields = { ...insertFields, color: pool[randomInt(pool.length)]! }
        }
        checkCancelled()
        const project = await tx.insertProject(ownerId, insertFields, idem)
        const context = options.undoContextId?.trim()
        if (context) await tx.recordUndo(makeUndoRecord(ownerId, context, project))
        checkCancelled()
        return { project, created: true }
      })
    } catch (error) {
      if (!idem || !runtime.isUniqueViolation(error)) throw error
      // A competing transaction won the unique (owner, key) insert. Read it after rollback.
      const winner = await runtime.transaction(async (tx) => {
        checkCancelled()
        const project = await tx.findIdempotent(ownerId, idem.keyHash)
        checkCancelled()
        return project
      })
      if (!winner) throw error
      if (winner.idempotency_fingerprint !== idem.fingerprint)
        throw new ProjectCreateIdempotencyConflictError()
      result = { project: winner, created: false }
    }

    if (result.created && options.publishEvent !== false) {
      await runtime.publishProjectCreated({
        userId: ownerId,
        resource: 'projects',
        origin: options.clientId?.trim() || null,
        operation: 'create',
        entityId: result.project.id,
        payload: projectResponse(result.project, 0),
      }).catch(() => undefined)
    }
    return result
  }
}

/** Web 创建保持原有事务前字段验证与规范化 fingerprint。 */
export function createProjectCreator(runtime: ProjectCreateRuntime) {
  const create = projectCreator(runtime, false)
  return (owner: string, input: Fields, options: ProjectCreateOptions = {}) => create(owner, input, options)
}

/** 可信 Agent 显式传入原始 fingerprint 与键；null 表示无幂等收据。 */
export function createDeferredProjectCreator(runtime: ProjectCreateRuntime) {
  const create = projectCreator(runtime, true)
  return async (owner: string, prepareFields: () => Fields, options: ProjectCreateOptions & { fingerprintPayload: unknown; idempotencyKey: string | null }) => {
    if (!options || options.idempotencyKey === undefined)
      throw new CoreError('invalid_request', '延迟创建必须显式提供幂等键或空值')
    return create(owner, prepareFields, options)
  }
}
