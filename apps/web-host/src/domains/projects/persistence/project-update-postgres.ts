import type { Fields, ProjectRecord } from '@gugu/core'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import { projectTimestamp, readProjectFileCount } from './projects.js'
import type {
  ProjectUpdatedEvent,
  ProjectUpdateRuntime,
  ProjectUpdateTransaction,
  ProjectUpdateUndoRecord,
} from '../application/project-update.js'

type EventPublisher = (event: ProjectUpdatedEvent) => Promise<void>
type DirectoryRenamer = (ownerId: string, oldPrefix: string, newPrefix: string) => Promise<void>

const columns = `id, user_id::text AS user_id, name, summary, contact_name AS client, status,
  start_date, deadline, color, progress, stages_json, current_stage, priority, version, archived,
  done_at::text AS done_at, created_at::text AS created_at, updated_at::text AS updated_at,
  deleted_at::text AS deleted_at`

function project(row: Record<string, unknown>): ProjectRecord {
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
    version: Number(row.version),
    archived: Boolean(row.archived),
    done_at: projectTimestamp(row.done_at),
    created_at: projectTimestamp(row.created_at) ?? '',
    updated_at: projectTimestamp(row.updated_at) ?? '',
    deleted_at: projectTimestamp(row.deleted_at),
  }
}

const fieldColumns: Record<string, string> = {
  name: 'name',
  client: 'contact_name',
  status: 'status',
  start_date: 'start_date',
  deadline: 'deadline',
  color: 'color',
  progress: 'progress',
  stages_json: 'stages_json',
  current_stage: 'current_stage',
  archived: 'archived',
  priority: 'priority',
}

function transactionAdapter(client: PoolClient): ProjectUpdateTransaction {
  return {
    async getOwned(ownerId, projectId) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${columns} FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [projectId, ownerId],
      )
      return result.rows[0] ? project(result.rows[0]) : null
    },

    async updateIfVersion(ownerId, projectId, version, fields: Fields) {
      const assignments: string[] = []
      const values: unknown[] = [projectId, ownerId, version]
      for (const [field, column] of Object.entries(fieldColumns)) {
        if (!(field in fields)) continue
        values.push(fields[field])
        assignments.push(`${column} = $${values.length}`)
      }
      if ('status' in fields) {
        assignments.push(fields.status === 'done'
          ? 'done_at = COALESCE(done_at, CURRENT_TIMESTAMP)'
          : 'done_at = NULL')
      }
      if (assignments.length === 0) return null
      assignments.push('version = version + 1', 'updated_at = CURRENT_TIMESTAMP')
      const result = await client.query<Record<string, unknown>>(
        `UPDATE projects SET ${assignments.join(', ')}
         WHERE id = $1 AND user_id = $2 AND version = $3 AND deleted_at IS NULL
         RETURNING ${columns}`,
        values,
      )
      return result.rows[0] ? project(result.rows[0]) : null
    },

    async updateFileStoragePrefixes(ownerId, projectId, oldPrefix, newPrefix) {
      await client.query(
        `UPDATE files
         SET storage_key = $4 || substring(storage_key FROM char_length($3) + 1)
         WHERE user_id = $1 AND project_id = $2
           AND left(storage_key, char_length($3)) = $3`,
        [ownerId, projectId, oldPrefix, newPrefix],
      )
    },

    async recordUndo(record: ProjectUpdateUndoRecord) {
      const context = record.contextId.trim().slice(0, 128)
      if (!context) return
      await recordForwardUndoOperation(client, { ...record, contextId: context })
    },
  }
}

/** PostgreSQL update adapter. Project, file-key and Undo writes share one transaction. */
export function createPostgresProjectUpdateRuntime(
  pool: Pool,
  renameProjectDirectory: DirectoryRenamer,
  publishProjectUpdated: EventPublisher,
): ProjectUpdateRuntime {
  return {
    async transaction<T>(work: (tx: ProjectUpdateTransaction) => Promise<T>): Promise<T> {
      return withPostgresTransaction(pool, (client) => work(transactionAdapter(client)))
    },
    renameProjectDirectory,
    async getFileCount(ownerId, projectId) {
      return readProjectFileCount(pool, ownerId, projectId)
    },
    publishProjectUpdated,
  }
}
