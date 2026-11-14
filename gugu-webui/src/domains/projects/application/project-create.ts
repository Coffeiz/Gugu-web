import { createHash } from 'node:crypto'
import { CoreError, dataContext, DEFAULT_PROJECT_COLOR, prepareProjectCreate } from '@gugu/core'
import type { Fields, ProjectRecord } from '@gugu/core'
import { isPostgresUniqueViolation } from '../../../adapters/postgres-errors.js'

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
}

export interface ProjectCreateOptions {
  idempotencyKey?: string | null
  undoContextId?: string | null
  clientId?: string | null
  /** Agent 创建按 Python 原始工具参数计算 fingerprint，不采用归一化后的数据库字段。 */
  fingerprintPayload?: unknown
  /** Agent 工具写入摘要与优先级；默认保持现有 Web 创建字段映射。 */
  includeAgentFields?: boolean
  /** 默认发送 Web 项目事件；Agent 工具显式关闭以保持其 Python 行为。 */
  publishEvent?: boolean
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
    priority: null,
    archived: false,
    done_at: project.done_at,
    version: Number(project.version || 1),
    deleted_at: project.deleted_at,
  }
}

function projectResponse(project: ProjectRecord): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    client: project.client,
    status: project.status,
    startDate: project.start_date,
    deadline: project.deadline,
    color: project.color,
    progress: project.progress,
    stages: JSON.parse(project.stages_json),
    currentStage: project.current_stage,
    archived: project.archived,
    priority: null,
    version: Number(project.version || 1),
    doneAt: project.done_at,
    updatedAt: project.updated_at,
    deletedAt: project.deleted_at,
    createdAt: project.created_at.slice(0, 10),
    fileCount: 0,
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

export function createProjectCreator(runtime: ProjectCreateRuntime) {
  return async function createProject(
    authenticatedOwnerId: string,
    input: Fields,
    options: ProjectCreateOptions = {},
  ): Promise<ProjectCreateResult> {
    let ownerId: string
    let fields: Fields
    try {
      ownerId = dataContext(authenticatedOwnerId).ownerId
      fields = prepareProjectCreate(createPayload(input, options.includeAgentFields === true))
    } catch (error) {
      if (error instanceof CoreError) throw error
      throw new CoreError('invalid_request', error instanceof Error ? error.message : '项目字段无效')
    }
    const idem = idempotencyValues(options.idempotencyKey, options.fingerprintPayload ?? fields)

    let result: ProjectCreateResult
    try {
      result = await runtime.transaction(async (tx) => {
        if (idem) {
          const existing = await tx.findIdempotent(ownerId, idem.keyHash)
          if (existing) {
            if (existing.idempotency_fingerprint !== idem.fingerprint)
              throw new CoreError('conflict', '该 Idempotency-Key 已用于不同的创建内容')
            return { project: existing, created: false }
          }
        }
        const project = await tx.insertProject(ownerId, fields, idem)
        const context = options.undoContextId?.trim()
        if (context) await tx.recordUndo(makeUndoRecord(ownerId, context, project))
        return { project, created: true }
      })
    } catch (error) {
      if (!idem || !isPostgresUniqueViolation(error)) throw error
      // A competing transaction won the unique (owner, key) insert. Read it after rollback.
      const winner = await runtime.transaction((tx) => tx.findIdempotent(ownerId, idem.keyHash))
      if (!winner) throw error
      if (winner.idempotency_fingerprint !== idem.fingerprint)
        throw new CoreError('conflict', '该 Idempotency-Key 已用于不同的创建内容')
      result = { project: winner, created: false }
    }

    if (result.created && options.publishEvent !== false) {
      await runtime.publishProjectCreated({
        userId: ownerId,
        resource: 'projects',
        origin: options.clientId?.trim() || null,
        operation: 'create',
        entityId: result.project.id,
        payload: projectResponse(result.project),
      }).catch(() => undefined)
    }
    return result
  }
}
