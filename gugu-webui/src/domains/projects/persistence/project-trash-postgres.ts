import type { ProjectRecord } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import { projectTimestamp, readProjectFileCount } from './projects.js'
import type {
  ProjectTrashEvent,
  ProjectTrashFile,
  ProjectTrashFolder,
  ProjectTrashResourceChangedEvent,
  ProjectTrashRuntime,
  ProjectTrashTask,
  ProjectTrashTransaction,
  ProjectTrashUndoRecord,
} from '../application/project-trash.js'

type EventPublisher = (event: ProjectTrashResourceChangedEvent) => Promise<void>

const projectColumns = `id, user_id::text AS user_id, name, summary,
  contact_name AS client, status, start_date, deadline, color, progress,
  stages_json, current_stage, priority, version, archived, done_at::text AS done_at,
  created_at::text AS created_at, updated_at::text AS updated_at,
  deleted_at::text AS deleted_at`

function recordProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: Number(row.id),
    user_id: String(row.user_id),
    name: String(row.name),
    summary: row.summary == null ? null : String(row.summary),
    client: row.client == null ? null : String(row.client),
    status: String(row.status),
    start_date: row.start_date == null ? null : String(row.start_date),
    deadline: row.deadline == null ? null : String(row.deadline),
    color: String(row.color),
    progress: Number(row.progress),
    stages_json: String(row.stages_json),
    current_stage: row.current_stage == null ? null : String(row.current_stage),
    priority: row.priority == null ? null : String(row.priority),
    version: Number(row.version || 1),
    archived: Boolean(row.archived),
    done_at: projectTimestamp(row.done_at),
    created_at: projectTimestamp(row.created_at) ?? '',
    updated_at: projectTimestamp(row.updated_at) ?? '',
    deleted_at: projectTimestamp(row.deleted_at),
  }
}

function id(value: unknown) { return Number(value) }

function fileRow(row: Record<string, unknown>): ProjectTrashFile {
  return {
    id: id(row.id), user_id: String(row.user_id), display_name: String(row.display_name),
    ext: String(row.ext), space: String(row.space), project_id: row.project_id == null ? null : id(row.project_id),
    folder_id: row.folder_id == null ? null : id(row.folder_id),
    workspace_directory_id: row.workspace_directory_id == null ? null : id(row.workspace_directory_id),
    stage_name: row.stage_name == null ? null : String(row.stage_name),
    mind_map_id: row.mind_map_id == null ? null : id(row.mind_map_id),
    storage_key: String(row.storage_key), version: Number(row.version || 1),
    size: String(row.size ?? ''), size_bytes: Number(row.size_bytes ?? 0),
    mime_type: row.mime_type == null ? null : String(row.mime_type),
    img_width: row.img_width == null ? null : Number(row.img_width),
    img_height: row.img_height == null ? null : Number(row.img_height),
    deleted_at: projectTimestamp(row.deleted_at),
  }
}

function folderRow(row: Record<string, unknown>): ProjectTrashFolder {
  return {
    id: id(row.id), user_id: String(row.user_id), project_id: row.project_id == null ? null : id(row.project_id),
    workspace_directory_id: row.workspace_directory_id == null ? null : id(row.workspace_directory_id),
    parent_id: row.parent_id == null ? null : id(row.parent_id), name: String(row.name),
    version: Number(row.version || 1), deleted_at: projectTimestamp(row.deleted_at),
  }
}

function eventRow(row: Record<string, unknown>): ProjectTrashEvent {
  return {
    id: id(row.id), user_id: String(row.user_id), title: String(row.title), date: String(row.date),
    time: row.time == null ? null : String(row.time), end_time: row.end_time == null ? null : String(row.end_time),
    type: String(row.type), client: row.client == null ? null : String(row.client),
    project_id: row.project_id == null ? null : id(row.project_id),
    description: row.description == null ? null : String(row.description),
    version: Number(row.version || 1), deleted_at: projectTimestamp(row.deleted_at),
  }
}

function taskRow(row: Record<string, unknown>): ProjectTrashTask {
  return {
    id: id(row.id), user_id: row.user_id == null ? null : String(row.user_id),
    event_id: row.event_id == null ? null : id(row.event_id), enabled: Boolean(row.enabled),
    name: String(row.name), payload: String(row.payload ?? ''), cron: String(row.cron),
    schedule_kind: String(row.schedule_kind ?? 'cron'), start_at: projectTimestamp(row.start_at),
    reminder_lead_minutes: row.reminder_lead_minutes == null ? null : id(row.reminder_lead_minutes),
    channels: String(row.channels ?? ''), delivery_targets: row.delivery_targets ?? null,
  }
}

function transactionAdapter(client: PoolClient): ProjectTrashTransaction {
  return {
    async getOwnedProject(ownerId, projectId) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${projectColumns} FROM projects WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [projectId, ownerId],
      )
      return result.rows[0] ? recordProject(result.rows[0]) : null
    },

    async listProjectResources(ownerId, projectId, deletedAt) {
      const folderResult = await client.query<Record<string, unknown>>(
        `SELECT id, user_id::text AS user_id, project_id, workspace_directory_id, parent_id,
                name, version, deleted_at::text AS deleted_at
         FROM folders WHERE user_id = $1 AND project_id = $2
           AND ${deletedAt === undefined ? 'deleted_at IS NULL' : 'deleted_at = $3::timestamptz'}`,
        deletedAt === undefined ? [ownerId, projectId] : [ownerId, projectId, deletedAt],
      )
      const folders = folderResult.rows.map(folderRow)
      const folderIds = folders.map((row) => row.id)
      const fileParams: unknown[] = [ownerId, projectId, folderIds]
      const fileDelete = deletedAt === undefined ? 'deleted_at IS NULL' : 'deleted_at = $4::timestamptz'
      if (deletedAt !== undefined) fileParams.push(deletedAt)
      const filesResult = await client.query<Record<string, unknown>>(
        `SELECT id, user_id::text AS user_id, display_name, ext, space, project_id,
                folder_id, workspace_directory_id, stage_name, mind_map_id, storage_key,
                version, size, size_bytes, mime_type, img_width, img_height,
                deleted_at::text AS deleted_at
         FROM files WHERE user_id = $1 AND ${fileDelete}
           AND (project_id = $2 OR folder_id = ANY($3::integer[]))`,
        fileParams,
      )
      const eventParams: unknown[] = [ownerId, projectId]
      const eventDelete = deletedAt === undefined ? 'deleted_at IS NULL' : 'deleted_at = $3::timestamptz'
      if (deletedAt !== undefined) eventParams.push(deletedAt)
      const eventsResult = await client.query<Record<string, unknown>>(
        `SELECT id, user_id::text AS user_id, title, date, time, end_time, type,
                contact_name AS client, project_id, description, version,
                deleted_at::text AS deleted_at
         FROM calendar_events WHERE user_id = $1 AND project_id = $2 AND ${eventDelete}`,
        eventParams,
      )
      const events = eventsResult.rows.map(eventRow)
      const eventIds = events.map((row) => row.id)
      const tasksResult = eventIds.length === 0
        ? { rows: [] as Record<string, unknown>[] }
        : await client.query<Record<string, unknown>>(
          `SELECT id, user_id::text AS user_id, event_id, enabled, name, payload, cron,
                  schedule_kind, start_at::text AS start_at, reminder_lead_minutes,
                  channels, delivery_targets
           FROM scheduled_tasks WHERE user_id = $1 AND event_id = ANY($2::integer[])`,
          [ownerId, eventIds],
        )
      return { files: filesResult.rows.map(fileRow), folders, events, tasks: tasksResult.rows.map(taskRow) }
    },

    async updateProject(ownerId, projectId, fields) {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE projects SET deleted_at = $3::timestamptz, version = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2 RETURNING ${projectColumns}`,
        [projectId, ownerId, fields.deleted_at, fields.version],
      )
      if (!result.rows[0]) throw new Error('项目删除状态更新失败')
      return recordProject(result.rows[0])
    },

    async updateFile(ownerId, file) {
      await client.query(
        `UPDATE files SET storage_key = $3, display_name = $4, deleted_at = $5::timestamptz, version = $6
         WHERE id = $1 AND user_id = $2`,
        [file.id, ownerId, file.storage_key, file.display_name, file.deleted_at, file.version],
      )
    },

    async updateFolder(ownerId, folder) {
      await client.query(
        `UPDATE folders SET deleted_at = $3::timestamptz, version = $4
         WHERE id = $1 AND user_id = $2`,
        [folder.id, ownerId, folder.deleted_at, folder.version],
      )
    },

    async updateEvent(ownerId, event) {
      await client.query(
        `UPDATE calendar_events SET deleted_at = $3::timestamptz, version = $4
         WHERE id = $1 AND user_id = $2`,
        [event.id, ownerId, event.deleted_at, event.version],
      )
    },

    async updateTask(ownerId, task) {
      await client.query(
        'UPDATE scheduled_tasks SET enabled = $3 WHERE id = $1 AND user_id = $2',
        [task.id, ownerId, task.enabled],
      )
    },

    async recordUndo(record: ProjectTrashUndoRecord) {
      const context = record.contextId.trim().slice(0, 128)
      if (!context) return
      await recordForwardUndoOperation(client, {
        userId: record.userId,
        contextId: context,
        resource: 'projects',
        action: 'delete',
        targetRefs: record.targetRefs,
        beforeState: record.beforeState,
        afterState: record.afterState,
        baseVersions: record.baseVersions,
      })
    },
  }
}

/** PostgreSQL 项目软删/恢复与 Undo 共用单一事务；事件仅由 application 在提交后发布。 */
export function createPostgresProjectTrashRuntime(pool: Pool, publish: EventPublisher): ProjectTrashRuntime {
  return {
    async transaction<T>(work: (tx: ProjectTrashTransaction) => Promise<T>): Promise<T> {
      return withPostgresTransaction(pool, (client) => work(transactionAdapter(client)))
    },
    async getProjectFileCount(ownerId, projectId) {
      return readProjectFileCount(pool, ownerId, projectId)
    },
    publishResourceChanged: publish,
  }
}
