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

function canvasUndo(row: Row): Record<string, unknown> {
  return { id: Number(row.id), title: String(row.title), project_id: row.project_id === null ? null : Number(row.project_id), data_json: String(row.data_json ?? '{}'), deleted_at: row.deleted_at ?? null }
}

function itemUndo(row: Row): Record<string, unknown> {
  return { id: Number(row.id), canvas_id: Number(row.canvas_id), node_id: Number(row.node_id), x: Number(row.x), y: Number(row.y), w: row.w === null ? null : Number(row.w), h: row.h === null ? null : Number(row.h), z: Number(row.z), collapsed: Boolean(row.collapsed), data_json: String(row.data_json ?? '{}'), deleted_at: row.deleted_at ?? null }
}

function relationUndo(row: Row): Record<string, unknown> {
  return { id: Number(row.id), canvas_id: row.canvas_id === null ? null : Number(row.canvas_id), src_node_id: Number(row.src_node_id), dst_node_id: Number(row.dst_node_id), rel_type: String(row.rel_type), edge_key: row.edge_key ?? null, origin: row.origin ?? null, status: String(row.status), note: row.note ?? null, deleted_at: row.deleted_at ?? null }
}

function noteUndo(row: Row): Record<string, unknown> {
  return { id: Number(row.id), kind: String(row.kind), title: row.title ?? null, content_md: String(row.content_md ?? ''), content_plain: String(row.content_plain ?? ''), color: row.color ?? null, ref_type: row.ref_type ?? null, ref_id: row.ref_id ?? null, ref_snapshot: row.ref_snapshot ?? null, origin: row.origin ?? null, captured_at: row.captured_at ?? null, version: Number(row.version ?? 1), deleted_at: row.deleted_at ?? null }
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

    async delete(requestOwnerId, canvasId) {
      const canvasResult = await client.query<Row>(
        `SELECT id, title, project_id, data_json, deleted_at FROM mind_maps
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [canvasId, requestOwnerId],
      )
      const canvasRow = canvasResult.rows[0]
      if (!canvasRow) return null

      const [itemResult, relationResult] = await Promise.all([
        client.query<Row>(
          `SELECT id, canvas_id, node_id, x, y, w, h, z, collapsed, data_json, deleted_at
           FROM mind_canvas_items WHERE canvas_id=$1 AND user_id=$2 FOR UPDATE`,
          [canvasId, requestOwnerId],
        ),
        client.query<Row>(
          `SELECT id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, note, deleted_at
           FROM mind_relations WHERE canvas_id=$1 AND user_id=$2 FOR UPDATE`,
          [canvasId, requestOwnerId],
        ),
      ])
      const items = itemResult.rows
      const relations = relationResult.rows
      const nodeIds = [...new Set(items.map((item) => Number(item.node_id)))]
      const notesResult = nodeIds.length
        ? await client.query<Row>(
          `SELECT id, kind, title, content_md, content_plain, color, ref_type, ref_id,
                  ref_snapshot, origin, captured_at, version, deleted_at
           FROM mind_nodes WHERE id=ANY($1::bigint[]) AND user_id=$2 AND kind='canvas_note' FOR UPDATE`,
          [nodeIds, requestOwnerId],
        )
        : { rows: [] as Row[] }
      const noteRows = notesResult.rows

      const before: Record<string, Record<string, unknown>> = { [`canvas:${canvasId}`]: canvasUndo(canvasRow) }
      const after: Record<string, Record<string, unknown>> = {}
      const targetRefs: Array<{ kind: string; id: number }> = [{ kind: 'canvas', id: canvasId }]
      for (const row of items) {
        const id = Number(row.id)
        before[`canvas_item:${id}`] = itemUndo(row)
        targetRefs.push({ kind: 'canvas_item', id })
      }
      for (const row of relations) {
        const id = Number(row.id)
        before[`relation:${id}`] = relationUndo(row)
        targetRefs.push({ kind: 'relation', id })
      }
      for (const row of noteRows) {
        const id = Number(row.id)
        before[`canvas_note:${id}`] = noteUndo(row)
        targetRefs.push({ kind: 'canvas_note', id })
      }

      const itemUpdate = await client.query<Row>(
        `UPDATE mind_canvas_items SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE canvas_id=$1 AND user_id=$2
         RETURNING id, canvas_id, node_id, x, y, w, h, z, collapsed, data_json, deleted_at`,
        [canvasId, requestOwnerId],
      )
      for (const row of itemUpdate.rows) after[`canvas_item:${Number(row.id)}`] = itemUndo(row)
      const relationUpdate = await client.query<Row>(
        `UPDATE mind_relations SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE canvas_id=$1 AND user_id=$2 AND deleted_at IS NULL
         RETURNING id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, note, deleted_at`,
        [canvasId, requestOwnerId],
      )
      for (const row of relations) after[`relation:${Number(row.id)}`] = relationUndo(row)
      for (const row of relationUpdate.rows) after[`relation:${Number(row.id)}`] = relationUndo(row)
      const deletedCanvas = await client.query<Row>(
        `UPDATE mind_maps SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
         RETURNING id, title, project_id, data_json, deleted_at`,
        [canvasId, requestOwnerId],
      )
      const deletedCanvasRow = deletedCanvas.rows[0]
      if (!deletedCanvasRow) throw new Error('Mind canvas disappeared during delete')
      after[`canvas:${canvasId}`] = canvasUndo(deletedCanvasRow)
      for (const row of noteRows) after[`canvas_note:${Number(row.id)}`] = noteUndo(row)
      return { targetRefs, before, after }
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
