import { CoreError, dataContext, type ProjectRecord } from '../contracts/index.js'
import { projectResponse } from './project-projection.js'
import { calendarEventSnapshot } from '../calendar/event-projection.js'
import { scheduledTaskUndoSnapshot } from '../calendar/undo-snapshot.js'

/** 项目级文件资源以规范路径为唯一身份；其他关联元数据仍来自文件记录。 */
export interface ProjectTrashFile extends Record<string, unknown> {
  user_id: string
  display_name: string
  ext: string
  space: string
  project_id: number | null
  workspace_directory_id: number | null
  stage_name: string | null
  mind_map_id: number | null
  path: string
  version: number
  size: string
  size_bytes: number
  mime_type: string | null
  img_width: number | null
  img_height: number | null
  deleted_at: string | null
}

export interface ProjectTrashEvent extends Record<string, unknown> {
  id: number
  user_id: string
  title: string
  date: string
  time: string | null
  end_time: string | null
  type: string
  client: string | null
  project_id: number | null
  description: string | null
  version: number
  deleted_at: string | null
}

export interface ProjectTrashTask extends Record<string, unknown> {
  id: number
  user_id: string | null
  event_id: number | null
  enabled: boolean
  name: string
  payload: string
  cron: string
  schedule_kind: string
  start_at: string | null
  reminder_lead_minutes: number | null
  channels: string
  delivery_targets: unknown
}

export interface ProjectTrashResources {
  files: ProjectTrashFile[]
  events: ProjectTrashEvent[]
  tasks: ProjectTrashTask[]
}

export interface ProjectTrashUndoRecord {
  userId: string
  contextId: string
  resource: 'projects'
  action: 'delete'
  targetRefs: Array<{ kind: string; id: number } | { kind: 'file'; path: string }>
  beforeState: { items: Record<string, Record<string, unknown>> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, { version: number }>
}

export interface ProjectTrashTransaction {
  getOwnedProject(ownerId: string, projectId: number): Promise<ProjectRecord | null>
  listProjectResources(ownerId: string, projectId: number, deletedAt?: string): Promise<ProjectTrashResources>
  updateProject(ownerId: string, projectId: number, fields: { deleted_at: string | null; version: number }): Promise<ProjectRecord>
  updateFile(ownerId: string, file: ProjectTrashFile): Promise<void>
  updateEvent(ownerId: string, event: ProjectTrashEvent): Promise<void>
  updateTask(ownerId: string, task: ProjectTrashTask): Promise<void>
  recordUndo(record: ProjectTrashUndoRecord): Promise<void>
}

export interface ProjectTrashResourceChangedEvent {
  userId: string
  resource: 'projects' | 'files' | 'calendar' | 'scheduled_tasks'
  origin: string | null
  operation: 'delete' | 'create' | 'update'
  entityId?: number | string
  entityIds?: Array<number | string>
  payload?: Record<string, unknown>
}

export interface ProjectTrashRuntime {
  transaction<T>(work: (tx: ProjectTrashTransaction) => Promise<T>): Promise<T>
  getProjectFileCount(ownerId: string, projectId: number): Promise<number>
  publishResourceChanged(event: ProjectTrashResourceChangedEvent): Promise<void>
}

/** Host 注入授权范围内的路径能力，不得把旧资源 ID 当作物理文件身份。 */
export interface ProjectTrashStorage {
  moveProjectDirectory?(ownerId: string, project: Pick<ProjectRecord, 'id' | 'name' | 'start_date' | 'created_at'>,
    deleted: boolean, beforeMove?: (from: string, to: string) => Promise<void>): Promise<(() => Promise<void>) | undefined>
  moveToTrash(ownerId: string, file: ProjectTrashFile, beforeMove?: (from: string, to: string) => Promise<void>): Promise<{
    storageKey: string
    rollback?: () => Promise<void>
  }>
  restoreFromTrash(
    ownerId: string,
    file: ProjectTrashFile,
    project: ProjectRecord,
    beforeMove?: (from: string, to: string) => Promise<void>,
  ): Promise<{ storageKey: string; displayName: string; rollback?: () => Promise<void> }>
}

export class ProjectTrashStoragePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectTrashStoragePathError'
  }
}

export interface ProjectTrashMetadata {
  undoContextId?: string | null
  clientId?: string | null
}

/** 恢复过期判断沿用 Python project_trash_cutoff 的 UTC 30 天边界。 */
export class ProjectTrashExpiredError extends Error {
  readonly statusCode = 410

  constructor() {
    super('项目已超过 30 天保留期')
    this.name = 'ProjectTrashExpiredError'
  }
}

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function nullableDate(value: string | Date | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return String(value).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
}

function projectSnapshot(project: ProjectRecord): Record<string, unknown> {
  let stages: unknown[] = []
  try { stages = JSON.parse(project.stages_json) as unknown[] } catch { /* 保持 Python 快照对坏数据的空列表兼容 */ }
  return {
    id: project.id,
    name: project.name,
    client: project.client,
    status: project.status,
    start_date: project.start_date,
    deadline: project.deadline,
    color: project.color,
    progress: project.progress,
    stages,
    current_stage: project.current_stage,
    priority: project.priority,
    archived: project.archived,
    done_at: nullableDate(project.done_at),
    version: Number(project.version || 1),
    deleted_at: nullableDate(project.deleted_at),
  }
}

function fileSnapshot(file: ProjectTrashFile): Record<string, unknown> {
  return {
    display_name: file.display_name,
    ext: file.ext,
    space: file.space,
    project_id: file.project_id,
    workspace_directory_id: file.workspace_directory_id,
    stage_name: file.stage_name,
    mind_map_id: file.mind_map_id,
    path: file.path,
    version: Number(file.version || 1),
    size: file.size,
    size_bytes: file.size_bytes,
    mime_type: file.mime_type,
    img_width: file.img_width,
    img_height: file.img_height,
    deleted_at: nullableDate(file.deleted_at),
  }
}

function state(items: Record<string, Record<string, unknown>>) { return { items } }

function refs(resources: ProjectTrashResources, projectId: number) {
  const result: Record<string, Record<string, unknown>> = { [`project:${projectId}`]: {} }
  for (const file of resources.files) result[`file:${file.path}`] = fileSnapshot(file)
  for (const event of resources.events)
    result[`event:${event.id}`] = calendarEventSnapshot(event, nullableDate)
  for (const task of resources.tasks) result[`task:${task.id}`] = scheduledTaskUndoSnapshot(task, nullableDate)
  return result
}

function targetRefs(items: Record<string, Record<string, unknown>>): Array<{ kind: string; id: number } | { kind: 'file'; path: string }> {
  return Object.keys(items).map((ref) => {
    const [kind, ...rest] = ref.split(':')
    if (kind === 'file') return { kind: 'file', path: rest.join(':') }
    return { kind: kind!, id: Number(rest[0]) }
  })
}

async function publishBestEffort(runtime: ProjectTrashRuntime, events: ProjectTrashResourceChangedEvent[]) {
  for (const event of events) await runtime.publishResourceChanged(event).catch(() => undefined)
}

async function rollbackStorageMoves(moves: Array<() => Promise<void>>, originalError: unknown): Promise<never> {
  let rollbackFailed = false
  for (const rollback of moves.reverse()) {
    try { await rollback() } catch { rollbackFailed = true }
  }
  if (rollbackFailed) throw new CoreError('busy', '项目文件恢复失败，请稍后重试')
  throw originalError
}

export interface ProjectTrashTarget {
  project: ProjectRecord
  resources: ProjectTrashResources
}

/** 锁定的项目与级联清单由同一领域事务读取，后续执行使用这份清单。 */
export async function readProjectTrashTargets(tx: ProjectTrashTransaction, ownerId: string, ids: readonly number[]): Promise<ProjectTrashTarget[]> {
  const projects: ProjectRecord[] = []
  for (const id of [...ids].sort((a, b) => a - b)) {
    if (!Number.isSafeInteger(id)) throw new CoreError('not_found', '项目不存在')
    const project = await tx.getOwnedProject(ownerId, id)
    if (!project || project.deleted_at !== null) throw new CoreError('not_found', ids.length === 1 ? '项目不存在' : `项目 ${id} 不存在`)
    projects.push(project)
  }
  const targets: ProjectTrashTarget[] = []
  for (const project of projects) targets.push({ project, resources: await tx.listProjectResources(ownerId, project.id) })
  return targets
}

function projectTrashSnapshots(targets: readonly ProjectTrashTarget[]) {
  const snapshots: Record<string, Record<string, unknown>> = {}
  for (const { project, resources } of targets) {
    Object.assign(snapshots, refs(resources, project.id))
    snapshots[`project:${project.id}`] = projectSnapshot(project)
  }
  return snapshots
}

export function projectTrashConfirmationData(targets: readonly ProjectTrashTarget[]) {
  const versions = projectTrashSnapshots(targets)
  const ids: Record<string, number[]> = {}
  for (const target of targetRefs(versions)) if ('id' in target && Number.isSafeInteger(target.id))
    (ids[target.kind + '_id'] ??= []).push(target.id)
  for (const values of Object.values(ids)) values.sort((a, b) => a - b)
  return { ids, versions }
}

/** SQL、Undo 与层外调用收据共用事务。文件补偿和提交后的通知由事务拥有者处理。 */
export async function applyProjectTrashTargets(
  tx: ProjectTrashTransaction,
  storage: Pick<ProjectTrashStorage, 'moveToTrash' | 'moveProjectDirectory'>,
  ownerId: string,
  targets: readonly ProjectTrashTarget[],
  metadata: ProjectTrashMetadata,
  ports: {
    addRollback(rollback: () => Promise<void>): void
    beforeMove?(from: string, to: string): Promise<void>
    signal?: AbortSignal
    now?(): Date
  },
) {
  const before = projectTrashSnapshots(targets)
  const afterTargets: ProjectTrashTarget[] = []
  const stamp = (ports.now?.() ?? new Date()).toISOString()
  const events: ProjectTrashResourceChangedEvent[] = []
  const publishedOrigin = metadata.clientId?.trim() || null
  const visited = new Set<string>()
  const results: Array<{ success: true; deleted_project_id: number; name: string; file_count: number }> = []
  for (const target of targets) {
    ports.signal?.throwIfAborted()
    const { project, resources } = structuredClone(target)
    const projectId = project.id
    const rollbackDirectory = resources.files.length ? undefined : await storage.moveProjectDirectory?.(ownerId, project, true, ports.beforeMove)
    if (rollbackDirectory) ports.addRollback(rollbackDirectory)
    for (const file of resources.files) {
      ports.signal?.throwIfAborted()
      if (visited.has(`file:${file.path}`)) continue
      visited.add(`file:${file.path}`)
      try {
        const moved = await storage.moveToTrash(ownerId, file, ports.beforeMove)
        file.path = moved.storageKey
        if (moved.rollback) ports.addRollback(moved.rollback)
      } catch (error) {
        if (ports.beforeMove || error instanceof ProjectTrashStoragePathError) throw error
        /* 原 Web 路径保持旧版允许普通物理重命名失败时数据库软删的语义。 */
      }
      file.deleted_at = stamp
      file.version = Number(file.version || 1) + 1
      await tx.updateFile(ownerId, file)
    }
    for (const event of resources.events) {
      event.deleted_at = stamp
      event.version = Number(event.version || 1) + 1
      await tx.updateEvent(ownerId, event)
    }
    for (const task of resources.tasks) {
      task.enabled = false
      await tx.updateTask(ownerId, task)
    }
    const updated = await tx.updateProject(ownerId, projectId, {
      deleted_at: stamp, version: Number(project.version || 1) + 1,
    })
    resources.files = resources.files.filter(file => file.deleted_at === stamp)
    afterTargets.push({ project: updated, resources })
    results.push({ success: true, deleted_project_id: projectId, name: project.name, file_count: resources.files.length })
    events.push({ userId: ownerId, resource: 'projects', origin: publishedOrigin, operation: 'delete', entityId: projectId })
    if (resources.files.length) events.push({
      userId: ownerId, resource: 'files', origin: publishedOrigin, operation: 'delete',
      entityIds: resources.files.map(row => row.path),
    })
    if (resources.events.length) events.push({
      userId: ownerId, resource: 'calendar', origin: publishedOrigin, operation: 'delete', entityIds: resources.events.map(row => row.id),
    })
    if (resources.tasks.length) events.push({
      userId: ownerId, resource: 'scheduled_tasks', origin: publishedOrigin, operation: 'update', entityIds: resources.tasks.map(row => row.id),
    })
  }
  const after = Object.fromEntries(afterTargets.flatMap(({ project, resources }) => Object.entries(refs(resources, project.id))))
  const contextId = metadata.undoContextId?.trim().slice(0, 128)
  if (contextId) await tx.recordUndo({
    userId: ownerId, contextId, resource: 'projects', action: 'delete',
    targetRefs: targetRefs(after), beforeState: state(before), afterState: state(after),
    baseVersions: Object.fromEntries(Object.entries(before).map(([ref, value]) => [ref, { version: Number(value.version ?? 0) }])),
  })
  ports.signal?.throwIfAborted()
  return { results, events }
}

export function createProjectTrashService(runtime: ProjectTrashRuntime, storage: ProjectTrashStorage) {
  return {
    async deleteProject(owner: string, id: number, metadata: ProjectTrashMetadata = {}): Promise<void> {
      const ownerId = dataContext(owner).ownerId
      const storageMoves: Array<() => Promise<void>> = []
      const result = await runtime.transaction(async tx => applyProjectTrashTargets(
        tx, storage, ownerId, await readProjectTrashTargets(tx, ownerId, [id]), metadata,
        { addRollback: rollback => storageMoves.push(rollback) },
      )).catch(error => rollbackStorageMoves(storageMoves, error))
      await publishBestEffort(runtime, result.events)
    },

    async restoreProject(owner: string, id: number, metadata: ProjectTrashMetadata = {}): Promise<Record<string, unknown>> {
      const ownerId = dataContext(owner).ownerId
      if (!Number.isSafeInteger(id)) throw new CoreError('not_found', '项目不在回收站中')
      const storageMoves: Array<() => Promise<void>> = []
      const result = await (async () => {
        try {
          return await runtime.transaction(async (tx) => {
        const project = await tx.getOwnedProject(ownerId, id)
        const deletedAt = asDate(project?.deleted_at)
        if (!project || !deletedAt) throw new CoreError('not_found', '项目不在回收站中')
        if (deletedAt.getTime() <= Date.now() - 30 * 24 * 60 * 60 * 1000) throw new ProjectTrashExpiredError()
        // 保留数据库时间戳的原始精度，精确选择同一删除批次。
        const related = await tx.listProjectResources(ownerId, id, project.deleted_at!)

        const rollbackDirectory = related.files.length ? undefined : await storage.moveProjectDirectory?.(ownerId, project, false)
        if (rollbackDirectory) storageMoves.push(rollbackDirectory)

        const updatedProject = await tx.updateProject(ownerId, id, {
          deleted_at: null,
          version: Number(project.version || 1) + 1,
        })
        for (const file of related.files) {
          // 存储端口保留 Python 对普通移动故障的预期路径语义；
          // 元数据解析和不安全路径错误必须中止事务。
          const restored = await storage.restoreFromTrash(ownerId, file, updatedProject)
          if (restored.rollback) storageMoves.push(restored.rollback)
          file.path = restored.storageKey
          file.display_name = restored.displayName
          file.deleted_at = null
          file.version = Number(file.version || 1) + 1
          await tx.updateFile(ownerId, file)
        }
        for (const event of related.events) {
          event.deleted_at = null
          event.version = Number(event.version || 1) + 1
          await tx.updateEvent(ownerId, event)
        }
        for (const task of related.tasks) {
          task.enabled = true
          await tx.updateTask(ownerId, task)
        }
            return { project: updatedProject, resources: related }
          })
        } catch (error) {
          return rollbackStorageMoves(storageMoves, error)
        }
      })()

      const response = projectResponse(result.project, await runtime.getProjectFileCount(ownerId, id))
      const origin = metadata.clientId?.trim() || null
      const events: ProjectTrashResourceChangedEvent[] = [{
        userId: ownerId, resource: 'projects', origin, operation: 'create', entityId: id, payload: response,
      }]
      if (result.resources.files.length) events.push({
        userId: ownerId, resource: 'files', origin, operation: 'create',
        entityIds: result.resources.files.map((row) => row.path),
      })
      if (result.resources.events.length) events.push({
        userId: ownerId, resource: 'calendar', origin, operation: 'create',
        entityIds: result.resources.events.map((row) => row.id),
      })
      if (result.resources.tasks.length) events.push({
        userId: ownerId, resource: 'scheduled_tasks', origin, operation: 'update',
        entityIds: result.resources.tasks.map((row) => row.id),
      })
      await publishBestEffort(runtime, events)
      return response
    },
  }
}
