import { CoreError, dataContext, prepareProjectUpdate } from '@gugu/core'
import type { Fields, ProjectRecord } from '@gugu/core'
import { projectResponse } from '../persistence/projects.js'

export interface ProjectUpdateUndoRecord {
  userId: string
  contextId: string
  resource: 'projects'
  action: 'update'
  targetRefs: Array<{ kind: 'project'; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, { version: number }>
}

export interface ProjectUpdatedEvent {
  userId: string
  resource: 'projects'
  origin: string | null
  operation: 'update'
  entityId: number
  payload: Record<string, unknown>
}

export interface ProjectUpdateTransaction {
  getOwned(ownerId: string, projectId: number): Promise<ProjectRecord | null>
  updateIfVersion(ownerId: string, projectId: number, version: number, fields: Fields): Promise<ProjectRecord | null>
  updateFileStoragePrefixes(ownerId: string, projectId: number, oldPrefix: string, newPrefix: string): Promise<void>
  recordUndo(record: ProjectUpdateUndoRecord): Promise<void>
}

/** Host boundary for database work, storage rename and best-effort event delivery. */
export interface ProjectUpdateRuntime {
  transaction<T>(work: (tx: ProjectUpdateTransaction) => Promise<T>): Promise<T>
  renameProjectDirectory(ownerId: string, oldPrefix: string, newPrefix: string): Promise<void>
  getFileCount(ownerId: string, projectId: number): Promise<number>
  publishProjectUpdated(event: ProjectUpdatedEvent): Promise<void>
}

export interface ProjectUpdateMetadata {
  undoContextId?: string | null
  clientId?: string | null
}

const publicFields: Record<string, string> = {
  name: 'name',
  client: 'client',
  status: 'status',
  startDate: 'start_date',
  start_date: 'start_date',
  deadline: 'deadline',
  color: 'color',
  progress: 'progress',
  stages: 'stages',
  currentStage: 'current_stage',
  current_stage: 'current_stage',
  archived: 'archived',
  priority: 'priority',
}

function updatePayload(input: unknown): { version: number; fields: Fields } {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new CoreError('invalid_request', '请求内容必须是对象')
  const source = input as Record<string, unknown>
  const version = source.version
  if (!Number.isSafeInteger(version) || Number(version) < 1)
    throw new CoreError('invalid_request', '更新项目必须提供 version')

  const fields: Fields = {}
  for (const [external, internal] of Object.entries(publicFields)) {
    if (source[external] === undefined) continue
    if (external === 'start_date' && source.startDate !== undefined) continue
    if (external === 'current_stage' && source.currentStage !== undefined) continue
    fields[internal] = internal === 'name' && typeof source[external] === 'string'
      ? source[external].trim()
      : source[external]
  }
  return { version: Number(version), fields }
}

function validateFields(fields: Fields, existing: ProjectRecord): Fields {
  try {
    return prepareProjectUpdate(fields, existing)
  } catch (error) {
    if (error instanceof CoreError) throw error
    throw new CoreError('invalid_request', error instanceof Error ? error.message : '项目字段无效')
  }
}

function snapshot(project: ProjectRecord): Record<string, unknown> {
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
    archived: project.archived,
    done_at: project.done_at,
    version: Number(project.version || 1),
    deleted_at: project.deleted_at,
  }
}

function prefix(project: ProjectRecord, name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, '_')
  const date = project.start_date || project.created_at
  return `${project.user_id}/项目文件/${date.slice(0, 4)}/${date.slice(5, 7)}/${safe} #${project.id}`
}

function makeUndo(ownerId: string, context: string, before: ProjectRecord, after: ProjectRecord): ProjectUpdateUndoRecord {
  const ref = `project:${before.id}`
  return {
    userId: ownerId,
    contextId: context.slice(0, 128),
    resource: 'projects',
    action: 'update',
    targetRefs: [{ kind: 'project', id: before.id }],
    beforeState: { items: { [ref]: snapshot(before) } },
    afterState: { items: { [ref]: snapshot(after) } },
    baseVersions: { [ref]: { version: Number(before.version || 1) } },
  }
}

export function createProjectUpdater(runtime: ProjectUpdateRuntime) {
  return async function updateProject(
    authenticatedOwnerId: string,
    projectId: number,
    input: unknown,
    metadata: ProjectUpdateMetadata = {},
  ): Promise<Record<string, unknown>> {
    let ownerId: string
    let parsed: ReturnType<typeof updatePayload>
    try {
      ownerId = dataContext(authenticatedOwnerId).ownerId
      parsed = updatePayload(input)
    } catch (error) {
      if (error instanceof CoreError) throw error
      throw new CoreError('invalid_request', error instanceof Error ? error.message : '项目字段无效')
    }

    const result = await runtime.transaction(async (tx) => {
      const current = await tx.getOwned(ownerId, projectId)
      if (!current) throw new CoreError('not_found', '项目不存在')
      if (Object.keys(parsed.fields).length === 0) return { project: current, changed: false }
      const fields = validateFields(parsed.fields, current)
      if (Number(current.version || 1) !== parsed.version)
        throw new CoreError('conflict', '数据已被其他用户修改，请刷新后重试')

      const newName = fields.name
      if (typeof newName === 'string' && newName !== current.name) {
        const oldPrefix = prefix(current, current.name)
        const newPrefix = prefix(current, newName)
        await runtime.renameProjectDirectory(ownerId, oldPrefix, newPrefix)
        await tx.updateFileStoragePrefixes(ownerId, projectId, oldPrefix, newPrefix)
      }

      const updated = await tx.updateIfVersion(ownerId, projectId, parsed.version, fields)
      if (!updated) throw new CoreError('conflict', '数据已被其他用户修改，请刷新后重试')
      const context = metadata.undoContextId?.trim()
      if (context) await tx.recordUndo(makeUndo(ownerId, context, current, updated))
      return { project: updated, changed: true }
    })

    const fileCount = await runtime.getFileCount(ownerId, projectId)
    const response = projectResponse(result.project, fileCount)
    if (result.changed) {
      await runtime.publishProjectUpdated({
        userId: ownerId,
        resource: 'projects',
        origin: metadata.clientId?.trim() || null,
        operation: 'update',
        entityId: projectId,
        payload: response,
      }).catch(() => undefined)
    }
    return response
  }
}
