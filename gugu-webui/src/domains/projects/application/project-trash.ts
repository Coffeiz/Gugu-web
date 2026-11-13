import { CoreError, dataContext, type ProjectRecord } from '@gugu/core'
import { projectResponse } from '../persistence/projects.js'

export interface ProjectTrashFile extends Record<string, unknown> {
  id: number
  user_id: string
  display_name: string
  ext: string
  space: string
  project_id: number | null
  folder_id: number | null
  workspace_directory_id: number | null
  stage_name: string | null
  mind_map_id: number | null
  storage_key: string
  version: number
  size: string
  size_bytes: number
  mime_type: string | null
  img_width: number | null
  img_height: number | null
  deleted_at: string | null
}

export interface ProjectTrashFolder extends Record<string, unknown> {
  id: number
  user_id: string
  project_id: number | null
  workspace_directory_id: number | null
  parent_id: number | null
  name: string
  version: number
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
  folders: ProjectTrashFolder[]
  events: ProjectTrashEvent[]
  tasks: ProjectTrashTask[]
}

export interface ProjectTrashUndoRecord {
  userId: string
  contextId: string
  resource: 'projects'
  action: 'delete'
  targetRefs: Array<{ kind: string; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, { version: number }>
}

export interface ProjectTrashTransaction {
  getOwnedProject(ownerId: string, projectId: number): Promise<ProjectRecord | null>
  listProjectResources(ownerId: string, projectId: number, deletedAt?: string): Promise<ProjectTrashResources>
  updateProject(ownerId: string, projectId: number, fields: { deleted_at: string | null; version: number }): Promise<ProjectRecord>
  updateFile(ownerId: string, file: ProjectTrashFile): Promise<void>
  updateFolder(ownerId: string, folder: ProjectTrashFolder): Promise<void>
  updateEvent(ownerId: string, event: ProjectTrashEvent): Promise<void>
  updateTask(ownerId: string, task: ProjectTrashTask): Promise<void>
  recordUndo(record: ProjectTrashUndoRecord): Promise<void>
}

export interface ProjectTrashResourceChangedEvent {
  userId: string
  resource: 'projects' | 'files' | 'calendar' | 'scheduled_tasks'
  origin: string | null
  operation: 'delete' | 'create' | 'update'
  entityId?: number
  entityIds?: number[]
  payload?: Record<string, unknown>
}

export interface ProjectTrashRuntime {
  transaction<T>(work: (tx: ProjectTrashTransaction) => Promise<T>): Promise<T>
  getProjectFileCount(ownerId: string, projectId: number): Promise<number>
  publishResourceChanged(event: ProjectTrashResourceChangedEvent): Promise<void>
}

export interface ProjectTrashStorage {
  moveToTrash(ownerId: string, file: ProjectTrashFile): Promise<{ storageKey: string }>
  restoreFromTrash(
    ownerId: string,
    file: ProjectTrashFile,
    project: ProjectRecord,
    folders: ProjectTrashFolder[],
  ): Promise<{ storageKey: string; displayName: string }>
}

export interface ProjectTrashMetadata {
  undoContextId?: string | null
  clientId?: string | null
}

/** Restore expiry uses the same UTC 30-day boundary as Python project_trash_cutoff. */
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
    id: file.id,
    display_name: file.display_name,
    ext: file.ext,
    space: file.space,
    project_id: file.project_id,
    folder_id: file.folder_id,
    workspace_directory_id: file.workspace_directory_id,
    stage_name: file.stage_name,
    mind_map_id: file.mind_map_id,
    storage_key: file.storage_key,
    version: Number(file.version || 1),
    size: file.size,
    size_bytes: file.size_bytes,
    mime_type: file.mime_type,
    img_width: file.img_width,
    img_height: file.img_height,
    deleted_at: nullableDate(file.deleted_at),
  }
}

function folderSnapshot(folder: ProjectTrashFolder): Record<string, unknown> {
  return {
    id: folder.id,
    name: folder.name,
    project_id: folder.project_id,
    workspace_directory_id: folder.workspace_directory_id,
    parent_id: folder.parent_id,
    version: Number(folder.version || 1),
    deleted_at: nullableDate(folder.deleted_at),
  }
}

function eventSnapshot(event: ProjectTrashEvent): Record<string, unknown> {
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    end_time: event.end_time,
    type: event.type,
    client: event.client,
    project_id: event.project_id,
    description: event.description,
    version: Number(event.version || 1),
    deleted_at: nullableDate(event.deleted_at),
  }
}

function taskSnapshot(task: ProjectTrashTask): Record<string, unknown> {
  return {
    id: task.id,
    enabled: Boolean(task.enabled),
    name: task.name,
    payload: task.payload,
    cron: task.cron,
    schedule_kind: task.schedule_kind,
    start_at: nullableDate(task.start_at),
    reminder_lead_minutes: task.reminder_lead_minutes,
    channels: task.channels,
    delivery_targets: task.delivery_targets,
  }
}

function state(items: Record<string, Record<string, unknown>>) { return { items } }

function refs(resources: ProjectTrashResources, projectId: number) {
  const result: Record<string, Record<string, unknown>> = { [`project:${projectId}`]: {} }
  for (const file of resources.files) result[`file:${file.id}`] = fileSnapshot(file)
  for (const folder of resources.folders) result[`folder:${folder.id}`] = folderSnapshot(folder)
  for (const event of resources.events) result[`event:${event.id}`] = eventSnapshot(event)
  for (const task of resources.tasks) result[`task:${task.id}`] = taskSnapshot(task)
  return result
}

function targetRefs(items: Record<string, Record<string, unknown>>) {
  return Object.keys(items).map((ref) => {
    const [kind, id] = ref.split(':')
    return { kind, id: Number(id) }
  })
}

async function publishBestEffort(runtime: ProjectTrashRuntime, events: ProjectTrashResourceChangedEvent[]) {
  for (const event of events) await runtime.publishResourceChanged(event).catch(() => undefined)
}

export function createProjectTrashService(runtime: ProjectTrashRuntime, storage: ProjectTrashStorage) {
  return {
    async deleteProject(owner: string, id: number, metadata: ProjectTrashMetadata = {}): Promise<void> {
      const ownerId = dataContext(owner).ownerId
      if (!Number.isSafeInteger(id)) throw new CoreError('not_found', '项目不存在')
      const result = await runtime.transaction(async (tx) => {
        const project = await tx.getOwnedProject(ownerId, id)
        if (!project || project.deleted_at !== null) throw new CoreError('not_found', '项目不存在')
        const related = await tx.listProjectResources(ownerId, id)
        const before = refs(related, id)
        before[`project:${id}`] = projectSnapshot(project)
        const stamp = new Date().toISOString()

        for (const file of related.files) {
          try {
            const moved = await storage.moveToTrash(ownerId, file)
            file.storage_key = moved.storageKey
          } catch { /* Python 的回收站移动失败不阻止数据库软删 */ }
          file.deleted_at = stamp
          file.version = Number(file.version || 1) + 1
          await tx.updateFile(ownerId, file)
        }
        for (const folder of related.folders) {
          folder.deleted_at = stamp
          folder.version = Number(folder.version || 1) + 1
          await tx.updateFolder(ownerId, folder)
        }
        for (const event of related.events) {
          event.deleted_at = stamp
          event.version = Number(event.version || 1) + 1
          await tx.updateEvent(ownerId, event)
        }
        for (const task of related.tasks) {
          task.enabled = false
          await tx.updateTask(ownerId, task)
        }
        const updated = await tx.updateProject(ownerId, id, {
          deleted_at: stamp,
          version: Number(project.version || 1) + 1,
        })

        const afterResources = { ...related, files: related.files, folders: related.folders, events: related.events, tasks: related.tasks }
        const after = refs(afterResources, id)
        after[`project:${id}`] = projectSnapshot(updated)
        const contextId = metadata.undoContextId?.trim().slice(0, 128)
        if (contextId) {
          await tx.recordUndo({
            userId: ownerId,
            contextId,
            resource: 'projects',
            action: 'delete',
            targetRefs: targetRefs(after),
            beforeState: state(before),
            afterState: state(after),
            baseVersions: Object.fromEntries(Object.entries(before).map(([ref, snapshot]) => [ref, { version: Number(snapshot.version ?? 0) }])),
          })
        }
        return { project: updated, resources: related }
      })

      const origin = metadata.clientId?.trim() || null
      const events: ProjectTrashResourceChangedEvent[] = [{
        userId: ownerId, resource: 'projects', origin, operation: 'delete', entityId: id,
      }]
      if (result.resources.files.length || result.resources.folders.length) events.push({
        userId: ownerId, resource: 'files', origin, operation: 'delete',
        entityIds: [...result.resources.files.map((row) => row.id), ...result.resources.folders.map((row) => row.id)],
      })
      if (result.resources.events.length) events.push({
        userId: ownerId, resource: 'calendar', origin, operation: 'delete',
        entityIds: result.resources.events.map((row) => row.id),
      })
      if (result.resources.tasks.length) events.push({
        userId: ownerId, resource: 'scheduled_tasks', origin, operation: 'update',
        entityIds: result.resources.tasks.map((row) => row.id),
      })
      await publishBestEffort(runtime, events)
    },

    async restoreProject(owner: string, id: number, metadata: ProjectTrashMetadata = {}): Promise<Record<string, unknown>> {
      const ownerId = dataContext(owner).ownerId
      if (!Number.isSafeInteger(id)) throw new CoreError('not_found', '项目不在回收站中')
      const result = await runtime.transaction(async (tx) => {
        const project = await tx.getOwnedProject(ownerId, id)
        const deletedAt = asDate(project?.deleted_at)
        if (!project || !deletedAt) throw new CoreError('not_found', '项目不在回收站中')
        if (deletedAt.getTime() <= Date.now() - 30 * 24 * 60 * 60 * 1000) throw new ProjectTrashExpiredError()
        // Keep the database's original timestamptz precision for exact same-delete-batch lookup.
        const related = await tx.listProjectResources(ownerId, id, project.deleted_at!)

        const updatedProject = await tx.updateProject(ownerId, id, {
          deleted_at: null,
          version: Number(project.version || 1) + 1,
        })
        for (const folder of related.folders) {
          folder.deleted_at = null
          folder.version = Number(folder.version || 1) + 1
          await tx.updateFolder(ownerId, folder)
        }
        for (const file of related.files) {
          // Storage adapters swallow physical move errors and return Python's expected key;
          // resolution/security errors still abort the transaction instead of hiding corruption.
          const restored = await storage.restoreFromTrash(ownerId, file, updatedProject, related.folders)
          file.storage_key = restored.storageKey
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

      const response = projectResponse(result.project, await runtime.getProjectFileCount(ownerId, id))
      const origin = metadata.clientId?.trim() || null
      const events: ProjectTrashResourceChangedEvent[] = [{
        userId: ownerId, resource: 'projects', origin, operation: 'create', entityId: id, payload: response,
      }]
      if (result.resources.files.length || result.resources.folders.length) events.push({
        userId: ownerId, resource: 'files', origin, operation: 'create',
        entityIds: [...result.resources.files.map((row) => row.id), ...result.resources.folders.map((row) => row.id)],
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
