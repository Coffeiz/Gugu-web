import {
  CoreError,
  dataContext,
  prepareProjectUpdate,
  PROJECT_COLOR_PRESETS,
  validateStages,
} from '@gugu/core'
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

function invalidProjectUpdate(message: string): never {
  throw new CoreError('invalid_request', message)
}

function integerValue(value: unknown, field: string): number {
  let number: number
  if (typeof value === 'boolean') number = Number(value)
  else if (typeof value === 'number') number = value
  else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) number = Number(value.trim())
  else return invalidProjectUpdate(`${field} 必须是整数`)
  if (!Number.isSafeInteger(number)) return invalidProjectUpdate(`${field} 必须是整数`)
  return number
}

function booleanValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return Boolean(value)
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'on', 't', 'true', 'y', 'yes'].includes(normalized)) return true
    if (['0', 'off', 'f', 'false', 'n', 'no'].includes(normalized)) return false
  }
  return invalidProjectUpdate('archived 必须是布尔值')
}

function validateUpdateText(source: Record<string, unknown>): void {
  for (const field of ['name', 'client', 'startDate', 'deadline', 'color', 'currentStage']) {
    const value = source[field]
    if (value !== undefined && value !== null && typeof value !== 'string')
      invalidProjectUpdate(`${field} 必须是文本或空值`)
  }
  for (const [camel, snake] of [['startDate', 'start_date'], ['currentStage', 'current_stage']]) {
    const value = source[camel] === undefined ? source[snake] : undefined
    if (value !== undefined && value !== null && typeof value !== 'string')
      invalidProjectUpdate(`${camel} 必须是文本或空值`)
  }
  if (typeof source.name === 'string') {
    const name = source.name.trim()
    if (!name) invalidProjectUpdate('名称不能为空')
    if (/[\\/:*?"<>|]/.test(name)) invalidProjectUpdate('名称包含不支持的字符')
  }
}

function validateUpdateEnums(source: Record<string, unknown>): void {
  if (source.status !== undefined && source.status !== null
    && !['pending', 'active', 'done'].includes(source.status as string))
    invalidProjectUpdate('项目状态无效')
  if (source.priority !== undefined && source.priority !== null
    && !['high', 'medium', 'low'].includes(source.priority as string))
    invalidProjectUpdate('项目优先级无效')
  if (source.color !== undefined && source.color !== null
    && !PROJECT_COLOR_PRESETS.some((preset) => preset === source.color))
    invalidProjectUpdate('颜色必须是预设色板中的值')
}

function validProjectDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return year >= 1 && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validateUpdateDates(source: Record<string, unknown>): void {
  const startDate = source.startDate === undefined ? source.start_date : source.startDate
  if (typeof startDate === 'string' && !validProjectDate(startDate))
    invalidProjectUpdate('startDate 日期无效')
  if (typeof source.deadline === 'string' && !validProjectDate(source.deadline))
    invalidProjectUpdate('deadline 日期无效')
  if (typeof startDate === 'string' && startDate && typeof source.deadline === 'string'
    && source.deadline && startDate > source.deadline)
    invalidProjectUpdate('开始日期不能晚于截止日期')
}

function validateUpdateStages(source: Record<string, unknown>): void {
  if (source.stages === undefined || source.stages === null) return
  try {
    validateStages(source.stages)
  } catch (error) {
    if (error instanceof CoreError) throw error
    invalidProjectUpdate('项目阶段无效')
  }
  const currentStage = source.currentStage === undefined ? source.current_stage : source.currentStage
  if (typeof currentStage === 'string'
    && !(source.stages as Array<{ key: string }>).some((stage) => stage.key === currentStage))
    invalidProjectUpdate('当前阶段必须属于阶段列表')
}

function validateUpdateScalars(source: Record<string, unknown>): void {
  if (source.progress !== undefined && source.progress !== null) {
    const progress = integerValue(source.progress, 'progress')
    if (progress < 0 || progress > 100) invalidProjectUpdate('progress 超出范围')
  }
  if (source.archived !== undefined && source.archived !== null) booleanValue(source.archived)
  if (source.version !== undefined && source.version !== null && integerValue(source.version, 'version') < 1)
    invalidProjectUpdate('version 必须大于等于 1')
}

function validateProjectUpdateSchema(source: Record<string, unknown>): void {
  validateUpdateText(source)
  validateUpdateEnums(source)
  validateUpdateDates(source)
  validateUpdateStages(source)
  validateUpdateScalars(source)
}

function normalizeFieldValue(field: string, value: unknown): unknown {
  if (field === 'name' && typeof value === 'string') return value.trim()
  if (field === 'progress' && value !== null) return integerValue(value, 'progress')
  if (field === 'archived' && value !== null) return booleanValue(value)
  return value
}

function updatePayload(input: unknown): { version: number | null; fields: Fields } {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new CoreError('invalid_request', '请求内容必须是对象')
  const source = input as Record<string, unknown>
  validateProjectUpdateSchema(source)
  const rawVersion = source.version
  const version = rawVersion === undefined || rawVersion === null ? null : integerValue(rawVersion, 'version')

  const fields: Fields = {}
  for (const [external, internal] of Object.entries(publicFields)) {
    if (source[external] === undefined) continue
    if (external === 'start_date' && source.startDate !== undefined) continue
    if (external === 'current_stage' && source.currentStage !== undefined) continue
    fields[internal] = normalizeFieldValue(internal, source[external])
  }
  return { version, fields }
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

    const directoryRename: { value: { oldPrefix: string; newPrefix: string } | null } = { value: null }
    let result: { project: ProjectRecord; changed: boolean }
    try {
      result = await runtime.transaction((tx) => updateProjectInTransaction(
        runtime, tx, ownerId, projectId, parsed, metadata,
        (oldPrefix, newPrefix) => { directoryRename.value = { oldPrefix, newPrefix } },
      ))
    } catch (error) {
      if (directoryRename.value) {
        try {
          await runtime.renameProjectDirectory(ownerId, directoryRename.value.newPrefix, directoryRename.value.oldPrefix)
        } catch {
          throw new CoreError('busy', '项目目录恢复失败，请稍后重试')
        }
      }
      throw error
    }

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

async function updateProjectInTransaction(
  runtime: ProjectUpdateRuntime,
  tx: ProjectUpdateTransaction,
  ownerId: string,
  projectId: number,
  parsed: ReturnType<typeof updatePayload>,
  metadata: ProjectUpdateMetadata,
  onDirectoryRename: (oldPrefix: string, newPrefix: string) => void,
): Promise<{ project: ProjectRecord; changed: boolean }> {
  const current = await tx.getOwned(ownerId, projectId)
  if (!current) throw new CoreError('not_found', '项目不存在')
  if (parsed.version === null)
    throw new CoreError('invalid_request', '更新项目必须提供 version')
  if (Object.keys(parsed.fields).length === 0) return { project: current, changed: false }
  const fields = validateFields(parsed.fields, current)
  if (Number(current.version || 1) !== parsed.version)
    throw new CoreError('conflict', '数据已被其他用户修改，请刷新后重试')

  const newName = fields.name
  if (typeof newName === 'string' && newName !== current.name) {
    const oldPrefix = prefix(current, current.name)
    const newPrefix = prefix(current, newName)
    onDirectoryRename(oldPrefix, newPrefix)
    await runtime.renameProjectDirectory(ownerId, oldPrefix, newPrefix)
    await tx.updateFileStoragePrefixes(ownerId, projectId, oldPrefix, newPrefix)
  }

  const updated = await tx.updateIfVersion(ownerId, projectId, parsed.version, fields)
  if (!updated) throw new CoreError('conflict', '数据已被其他用户修改，请刷新后重试')
  const context = metadata.undoContextId?.trim()
  if (context) await tx.recordUndo(makeUndo(ownerId, context, current, updated))
  return { project: updated, changed: true }
}
