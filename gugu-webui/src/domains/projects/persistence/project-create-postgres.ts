import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type {
  ProjectCreateRecord,
  ProjectCreateRuntime,
  ProjectCreateTransaction,
  ProjectCreatedEvent,
} from '../application/project-create.js'

type EventPublisher = (event: ProjectCreatedEvent) => Promise<void>

const projectColumns = `id, user_id::text AS user_id, name, summary,
  contact_name AS client, status, start_date, deadline, color, progress,
  stages_json, current_stage, priority, version, archived, done_at::text AS done_at,
  created_at::text AS created_at, updated_at::text AS updated_at,
  deleted_at::text AS deleted_at, idempotency_fingerprint`

function rowAsProject(row: Record<string, unknown>): ProjectCreateRecord {
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
    done_at: timestamp(row.done_at),
    created_at: timestamp(row.created_at) ?? '',
    updated_at: timestamp(row.updated_at) ?? '',
    deleted_at: timestamp(row.deleted_at),
    idempotency_fingerprint: row.idempotency_fingerprint == null
      ? null
      : String(row.idempotency_fingerprint),
  }
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Undo 状态无法序列化')
  return encoded
}

function timestamp(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
    .replace(' ', 'T')
    .replace(/\.(\d+)(?=[+-]\d{2}$)/, (_match, fraction: string) =>
      fraction.split('').every((digit) => digit === '0') ? '' : `.${fraction}`,
    )
    .replace(/([+-]\d{2})$/, '$1:00')
}

function newUndoId(prefix: 'op' | 'group'): string {
  return `${prefix}-${randomUUID().replaceAll('-', '')}`
}

function transactionAdapter(client: PoolClient): ProjectCreateTransaction {
  return {
    async findIdempotent(ownerId, keyHash) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${projectColumns} FROM projects
         WHERE user_id = $1 AND idempotency_key = $2`,
        [ownerId, keyHash],
      )
      const row = result.rows[0]
      return row ? rowAsProject(row) : null
    },

    async insertProject(ownerId, fields, idempotency) {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO projects (
           user_id, name, summary, contact_name, status, start_date, deadline,
           color, progress, stages_json, current_stage, priority, version, archived,
           done_at, created_at, updated_at, deleted_at, idempotency_key,
           idempotency_fingerprint
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, FALSE,
           NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, $13, $14
         )
         RETURNING ${projectColumns}`,
        [
          ownerId,
          fields.name,
          fields.summary ?? null,
          fields.client,
          fields.status,
          fields.start_date,
          fields.deadline,
          fields.color,
          fields.progress,
          fields.stages_json,
          fields.current_stage,
          fields.priority ?? null,
          idempotency?.keyHash ?? null,
          idempotency?.fingerprint ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('项目插入后未返回记录')
      return rowAsProject(row)
    },

    async recordUndo(record) {
      const contextId = record.contextId.trim().slice(0, 128)
      if (!contextId) return

      // 和 Python UndoService.record_forward 一样，新正向操作会截断当前标签页 redo 分支。
      await client.query(
        `UPDATE undo_operations
         SET status = 'expired', failure_code = 'redo_cleared_by_new_operation'
         WHERE user_id = $1 AND undo_context_id = $2 AND actor_type = 'web'
           AND status = 'undone'`,
        [record.userId, contextId],
      )
      await client.query(
        `INSERT INTO undo_operations (
           id, user_id, undo_context_id, group_id, resource, action, target_refs,
           before_state, after_state, base_versions, artifact_refs, actor_type,
           status, created_at, expires_at, undone_at, failure_code
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::json, $8::json, $9::json, $10::json,
           '{}'::json, 'web', 'active', CURRENT_TIMESTAMP,
           CURRENT_TIMESTAMP + INTERVAL '30 days', NULL, NULL
         )`,
        [
          newUndoId('op'),
          record.userId,
          contextId,
          newUndoId('group'),
          record.resource,
          record.action,
          json(record.targetRefs),
          json(record.beforeState),
          json(record.afterState),
          json(record.baseVersions),
        ],
      )
    },
  }
}

/** PostgreSQL host adapter. Project/Undo writes share one transaction; event delivery runs after commit. */
export function createPostgresProjectCreateRuntime(pool: Pool, publishProjectCreated: EventPublisher): ProjectCreateRuntime {
  return {
    async transaction<T>(work: (tx: ProjectCreateTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work(transactionAdapter(client))
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    publishProjectCreated,
  }
}
