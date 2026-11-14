import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import type {
  MindCanvasMutationRuntime,
  MindCanvasMutationTransaction,
  MindCanvasRecord,
  MindCanvasUndoRecord,
} from '../application/mind-canvas-mutations.js'

type Row = Record<string, unknown>

function canvas(row: Row): MindCanvasRecord {
  return {
    id: Number(row.id),
    title: String(row.title),
    project_id: row.project_id === null || row.project_id === undefined ? null : Number(row.project_id),
    data_json: String(row.data_json ?? '{}'),
    created_at: row.created_at as Date | string,
    updated_at: row.updated_at as Date | string,
  }
}

function mutationTransaction(client: PoolClient): MindCanvasMutationTransaction {
  const columns = 'id, title, project_id, data_json, created_at, updated_at'
  return {
    async projectExistsForOwner(requestOwnerId, projectId) {
      const result = await client.query(
        'SELECT 1 FROM projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL LIMIT 1',
        [projectId, requestOwnerId],
      )
      return result.rows.length > 0
    },

    async insert(requestOwnerId, title, projectId) {
      const result = await client.query<Row>(
        `INSERT INTO mind_maps (user_id, title, project_id, data_json, created_at, updated_at)
         VALUES ($1, $2, $3, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING ${columns}`,
        [requestOwnerId, title, projectId],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Mind canvas insert returned no row')
      return canvas(row)
    },

    async getOwned(requestOwnerId, canvasId) {
      const result = await client.query<Row>(
        `SELECT ${columns} FROM mind_maps
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
         FOR UPDATE`,
        [canvasId, requestOwnerId],
      )
      return result.rows[0] ? canvas(result.rows[0]) : null
    },

    async update(requestOwnerId, canvasId, fields) {
      const assignments: string[] = []
      const values: unknown[] = [canvasId, requestOwnerId]
      if (fields.title !== undefined) {
        values.push(fields.title)
        assignments.push(`title=$${values.length}`)
      }
      if (fields.dataJson !== undefined) {
        values.push(fields.dataJson)
        assignments.push(`data_json=$${values.length}`)
      }
      if (assignments.length === 0) {
        const result = await client.query<Row>(
          `SELECT ${columns} FROM mind_maps
           WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
           FOR UPDATE`,
          [canvasId, requestOwnerId],
        )
        return result.rows[0] ? canvas(result.rows[0]) : null
      }
      assignments.push('updated_at=CURRENT_TIMESTAMP')
      const result = await client.query<Row>(
        `UPDATE mind_maps SET ${assignments.join(', ')}
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
         RETURNING ${columns}`,
        values,
      )
      return result.rows[0] ? canvas(result.rows[0]) : null
    },

    async recordUndo(record: MindCanvasUndoRecord) {
      await recordForwardUndoOperation(client, record)
    },
  }
}

/** Commits canvas state and Undo together; application code publishes only after this resolves. */
export function createPostgresMindCanvasMutationRuntime(
  pool: Pick<Pool, 'connect'>,
  publishChanged: MindCanvasMutationRuntime['publishChanged'],
  reportFailure?: MindCanvasMutationRuntime['reportFailure'],
): MindCanvasMutationRuntime {
  return {
    transaction<T>(ownerId: string, work: (tx: MindCanvasMutationTransaction) => Promise<T>): Promise<T> {
      return withPostgresTransaction(pool, (client) => work(mutationTransaction(client)))
    },
    publishChanged,
    reportFailure,
  }
}
