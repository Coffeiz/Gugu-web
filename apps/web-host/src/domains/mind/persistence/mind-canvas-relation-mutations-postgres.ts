import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import {
  MindCanvasRelationMutationError,
  type MindCanvasRelationMutationRuntime,
  type MindCanvasRelationRecord,
  type MindCanvasRelationTransaction,
  type MindCanvasRelationUndoRecord,
} from '../application/mind-canvas-relation-mutations.js'

type Row = Record<string, unknown> & {
  id: number | string
  canvas_id: number | string | null
  src_node_id: number | string
  dst_node_id: number | string
  rel_type: string
  edge_key: string
  origin: string
  status: string
  note: string | null
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}

const columns = `id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, note,
  created_at, updated_at, deleted_at`

function mapRelation(row: Row): MindCanvasRelationRecord {
  return {
    id: Number(row.id), canvas_id: row.canvas_id === null ? null : Number(row.canvas_id), src_node_id: Number(row.src_node_id),
    dst_node_id: Number(row.dst_node_id), rel_type: row.rel_type, edge_key: row.edge_key,
    origin: row.origin, status: row.status, note: row.note,
    created_at: row.created_at, updated_at: row.updated_at, deleted_at: row.deleted_at,
  }
}

function mutationTransaction(client: PoolClient): MindCanvasRelationTransaction {
  return {
    async create(ownerId, canvasId, sourceId, targetId, allowParallel) {
      const canvas = await client.query(
        `SELECT id FROM mind_maps WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [canvasId, ownerId],
      )
      if (!canvas.rows[0]) throw new MindCanvasRelationMutationError(404, '画布不存在')

      const nodeIds = [sourceId, targetId]
      const placements = await client.query<{ node_id: number | string }>(
        `SELECT node_id FROM mind_canvas_items
         WHERE canvas_id=$1 AND user_id=$2 AND node_id=ANY($3::bigint[]) AND deleted_at IS NULL`,
        [canvasId, ownerId, nodeIds],
      )
      if (new Set(placements.rows.map((row) => Number(row.node_id))).size !== 2)
        throw new MindCanvasRelationMutationError(422, '两个节点都必须已经放在同一张画布上')

      const nodes = await client.query(
        `SELECT id FROM mind_nodes WHERE id=ANY($1::bigint[]) AND user_id=$2 AND deleted_at IS NULL`,
        [nodeIds, ownerId],
      )
      if (nodes.rows.length !== 2) throw new MindCanvasRelationMutationError(404, '节点不存在')

      const source = Math.min(sourceId, targetId)
      const target = Math.max(sourceId, targetId)
      let before: MindCanvasRelationRecord | null = null
      if (!allowParallel) {
        const existing = await client.query<Row>(
          `SELECT ${columns} FROM mind_relations
           WHERE user_id=$1 AND canvas_id=$2 AND src_node_id=$3 AND dst_node_id=$4
             AND rel_type='related' AND edge_key='' FOR UPDATE`,
          [ownerId, canvasId, source, target],
        )
        if (existing.rows[0]) {
          before = mapRelation(existing.rows[0])
          if (before.deleted_at === null)
            return { relation: before, before, created: false }
          const restored = await client.query<Row>(
            `UPDATE mind_relations SET deleted_at=NULL, updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND user_id=$2 RETURNING ${columns}`,
            [before.id, ownerId],
          )
          if (!restored.rows[0]) throw new Error('Mind relation restore returned no row')
          return { relation: mapRelation(restored.rows[0]), before, created: true }
        }
      }

      const result = allowParallel
        ? await client.query<Row>(
          `INSERT INTO mind_relations
             (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'related', $5, 'user', 'confirmed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING ${columns}`,
          [ownerId, canvasId, source, target, randomUUID().replaceAll('-', '')],
        )
        : await client.query<Row & { inserted: boolean }>(
          `INSERT INTO mind_relations
             (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key, origin, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'related', '', 'user', 'confirmed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id, canvas_id, src_node_id, dst_node_id, rel_type, edge_key)
           DO UPDATE SET deleted_at=NULL, updated_at=CURRENT_TIMESTAMP
           RETURNING ${columns}, (xmax = 0) AS inserted`,
          [ownerId, canvasId, source, target],
        )
      const row = result.rows[0]
      if (!row) throw new Error('Mind relation insert returned no row')
      const relation = mapRelation(row)
      return { relation, before, created: allowParallel || Boolean('inserted' in row && row.inserted) }
    },

    async delete(ownerId, canvasId, relationId) {
      const canvas = await client.query(
        `SELECT id FROM mind_maps WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [canvasId, ownerId],
      )
      if (!canvas.rows[0]) throw new MindCanvasRelationMutationError(404, '画布不存在')
      const result = await client.query<Row>(
        `SELECT ${columns} FROM mind_relations
         WHERE id=$1 AND user_id=$2 AND canvas_id=$3 AND deleted_at IS NULL FOR UPDATE`,
        [relationId, ownerId, canvasId],
      )
      const row = result.rows[0]
      if (!row) return null
      const before = mapRelation(row)
      const deleted = await client.query<Row>(
        `UPDATE mind_relations SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND user_id=$2 AND canvas_id=$3 AND deleted_at IS NULL RETURNING ${columns}`,
        [relationId, ownerId, canvasId],
      )
      if (!deleted.rows[0]) return null
      return { before, after: mapRelation(deleted.rows[0]) }
    },

    async deleteGlobal(ownerId, relationId) {
      const result = await client.query<Row>(
        `SELECT ${columns} FROM mind_relations
         WHERE id=$1 AND user_id=$2 AND canvas_id IS NULL AND deleted_at IS NULL FOR UPDATE`,
        [relationId, ownerId],
      )
      const row = result.rows[0]
      if (!row) return null
      const before = mapRelation(row)
      const deleted = await client.query<Row>(
        `UPDATE mind_relations SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND user_id=$2 AND canvas_id IS NULL AND deleted_at IS NULL RETURNING ${columns}`,
        [relationId, ownerId],
      )
      if (!deleted.rows[0]) return null
      return { before, after: mapRelation(deleted.rows[0]) }
    },

    async recordUndo(record: MindCanvasRelationUndoRecord) {
      await recordForwardUndoOperation(client, record)
    },
  }
}

/** Relation state and Undo share one PostgreSQL transaction; notifications run after commit. */
export function createPostgresMindCanvasRelationMutationRuntime(
  pool: Pick<Pool, 'connect'>,
  publishChanged: MindCanvasRelationMutationRuntime['publishChanged'],
  reportFailure?: MindCanvasRelationMutationRuntime['reportFailure'],
): MindCanvasRelationMutationRuntime {
  return {
    transaction<T>(_ownerId: string, work: (tx: MindCanvasRelationTransaction) => Promise<T>): Promise<T> {
      return withPostgresTransaction(pool, (client) => work(mutationTransaction(client)))
    },
    publishChanged,
    reportFailure,
  }
}
