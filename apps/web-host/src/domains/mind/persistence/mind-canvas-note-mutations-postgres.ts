import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { toUtcIsoWithOffset } from '../../../shared/date-time.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import { toMindNoteReadResponse, type MindNoteReadResponse } from '../mind-notes-read.js'
import type { MindCanvasItemResponse } from '../mind-canvas-read.js'
import { mindCanvasNoteContentProjection, type MindCanvasNoteMutationRuntime } from '../application/mind-canvas-note-mutations.js'
import { MindCanvasNoteMutationError, type MindCanvasNoteCreateInput, type MindCanvasNoteUpdateInput } from '../application/mind-canvas-note-mutations.js'
import { mindNoteUndoSnapshot, type MindNotePersistenceRow } from './mind-note-snapshot.js'

type ItemRow = {
  id: number | string
  user_id: string
  canvas_id: number | string
  node_id: number | string
  x: number
  y: number
  w: number | null
  h: number | null
  z: number | string
  collapsed: boolean
  data_json: string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}

const nodeColumns = `id, kind, title, content_md, content_plain, color, captured_at,
  version, created_at, updated_at, deleted_at, ref_type, ref_id, ref_snapshot, origin`
const itemColumns = `id, user_id, canvas_id, node_id, x, y, w, h, z, collapsed, data_json,
  created_at, updated_at, deleted_at`

function objectValue(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function itemSnapshot(row: ItemRow): Record<string, unknown> {
  return {
    id: Number(row.id),
    canvas_id: Number(row.canvas_id),
    node_id: Number(row.node_id),
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    z: Number(row.z),
    collapsed: row.collapsed,
    data_json: row.data_json,
    deleted_at: row.deleted_at ? toUtcIsoWithOffset(row.deleted_at) : null,
  }
}

function itemResponse(item: ItemRow, node: MindNotePersistenceRow): MindCanvasItemResponse {
  return {
    id: Number(item.id),
    canvasId: Number(item.canvas_id),
    nodeId: Number(item.node_id),
    x: Number(item.x),
    y: Number(item.y),
    w: item.w === null ? null : Number(item.w),
    h: item.h === null ? null : Number(item.h),
    z: Number(item.z),
    collapsed: Boolean(item.collapsed),
    data: objectValue(item.data_json),
    refData: null,
    node: toMindNoteReadResponse(node),
    createdAt: toUtcIsoWithOffset(item.created_at),
    updatedAt: toUtcIsoWithOffset(item.updated_at),
  }
}

function noteSnapshot(row: MindNotePersistenceRow): Record<string, unknown> {
  return mindNoteUndoSnapshot(row)
}

function undoContext(value: string | null): string | null {
  return value?.trim().slice(0, 128) || null
}

async function requireCanvas(client: PoolClient, ownerId: string, canvasId: number): Promise<void> {
  const result = await client.query(
    'SELECT 1 FROM mind_maps WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',
    [canvasId, ownerId],
  )
  if (!result.rows.length) throw new MindCanvasNoteMutationError('画布不存在', 404)
}

async function recordCreateUndo(
  client: PoolClient,
  ownerId: string,
  contextId: string | null,
  node: MindNotePersistenceRow,
  item: ItemRow,
): Promise<void> {
  const context = undoContext(contextId)
  if (!context) return
  const nodeId = Number(node.id)
  const itemId = Number(item.id)
  const nodeKey = `canvas_note:${nodeId}`
  const itemKey = `canvas_item:${itemId}`
  await recordForwardUndoOperation(client, {
    userId: ownerId,
    contextId: context,
    resource: 'mind',
    action: 'create',
    targetRefs: [{ kind: 'canvas_note', id: nodeId }, { kind: 'canvas_item', id: itemId }],
    beforeState: { items: {} },
    afterState: { items: { [nodeKey]: noteSnapshot(node), [itemKey]: itemSnapshot(item) } },
    baseVersions: { [nodeKey]: { version: 0 }, [itemKey]: {} },
  })
}

function mutationTransaction(client: PoolClient) {
  return {
    async create(
      ownerId: string,
      canvasId: number,
      input: MindCanvasNoteCreateInput,
      undoContextId: string | null,
    ): Promise<MindCanvasItemResponse> {
      await requireCanvas(client, ownerId, canvasId)
      const projection = mindCanvasNoteContentProjection(input.contentMd)
      const nodeResult = await client.query<MindNotePersistenceRow>(
        `INSERT INTO mind_nodes (
           user_id, kind, title, content_md, content_plain, color, ref_type, ref_id,
           ref_snapshot, origin, indexed_at, indexed_hash, version, captured_at,
           created_at, updated_at, deleted_at
         ) VALUES ($1, 'canvas_note', $2, $3, $4, $5, NULL, NULL, NULL, 'user', NULL, $6, 1,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
         RETURNING ${nodeColumns}`,
        [ownerId, input.title, input.contentMd, projection.contentPlain, input.color, projection.indexedHash],
      )
      const node = nodeResult.rows[0]
      if (!node) throw new Error('画布便签插入后未返回记录')
      const itemResult = await client.query<ItemRow>(
        `INSERT INTO mind_canvas_items (
           user_id, canvas_id, node_id, x, y, w, h, z, collapsed, data_json,
           created_at, updated_at, deleted_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
         RETURNING ${itemColumns}`,
        [ownerId, canvasId, node.id, input.x, input.y, input.w, input.h, input.z],
      )
      const item = itemResult.rows[0]
      if (!item) throw new Error('画布便签位置插入后未返回记录')
      await recordCreateUndo(client, ownerId, undoContextId, node, item)
      return itemResponse(item, node)
    },

    async update(
      ownerId: string,
      nodeId: number,
      input: MindCanvasNoteUpdateInput,
      undoContextId: string | null,
    ): Promise<{ note: MindNoteReadResponse; changed: boolean }> {
      const beforeResult = await client.query<MindNotePersistenceRow>(
        `SELECT ${nodeColumns} FROM mind_nodes
         WHERE id=$1 AND user_id=$2 AND kind='canvas_note' AND deleted_at IS NULL
         FOR UPDATE`,
        [nodeId, ownerId],
      )
      const before = beforeResult.rows[0]
      if (!before) throw new MindCanvasNoteMutationError('画布便签不存在', 404)
      const beforeVersion = Number(before.version)
      if (input.version !== beforeVersion)
        throw new MindCanvasNoteMutationError('画布便签已被其他端修改，请刷新后重试', 409)

      const assignments: string[] = []
      const values: unknown[] = [nodeId, ownerId, input.version]
      if (input.title !== undefined) {
        values.push(input.title)
        assignments.push(`title=$${values.length}`)
      }
      if (input.contentMd !== undefined) {
        const projection = mindCanvasNoteContentProjection(input.contentMd)
        values.push(input.contentMd)
        assignments.push(`content_md=$${values.length}`)
        values.push(projection.contentPlain)
        assignments.push(`content_plain=$${values.length}`)
        values.push(projection.indexedHash)
        assignments.push(`indexed_hash=$${values.length}`)
        assignments.push('indexed_at=NULL')
      }
      if (input.color !== undefined) {
        values.push(input.color)
        assignments.push(`color=$${values.length}`)
      }
      if (!assignments.length) return { note: toMindNoteReadResponse(before), changed: false }
      assignments.push('version=version+1', 'updated_at=CURRENT_TIMESTAMP')
      const updatedResult = await client.query<MindNotePersistenceRow>(
        `UPDATE mind_nodes SET ${assignments.join(', ')}
         WHERE id=$1 AND user_id=$2 AND kind='canvas_note' AND version=$3 AND deleted_at IS NULL
         RETURNING ${nodeColumns}`,
        values,
      )
      const after = updatedResult.rows[0]
      if (!after) throw new MindCanvasNoteMutationError('画布便签已被其他端修改，请刷新后重试', 409)

      const context = undoContext(undoContextId)
      if (context) {
        const key = `canvas_note:${nodeId}`
        await recordForwardUndoOperation(client, {
          userId: ownerId,
          contextId: context,
          resource: 'mind',
          action: 'update',
          targetRefs: [{ kind: 'canvas_note', id: nodeId }],
          beforeState: { items: { [key]: noteSnapshot(before) } },
          afterState: { items: { [key]: noteSnapshot(after) } },
          baseVersions: { [key]: { version: beforeVersion } },
        })
      }
      return { note: toMindNoteReadResponse(after), changed: true }
    },
  }
}

/** 将便签节点、画布摆放状态和 Undo 快照原子写入 PostgreSQL。 */
export function createPostgresMindCanvasNoteMutationRuntime(
  pool: Pick<Pool, 'connect'>,
  publishChanged: MindCanvasNoteMutationRuntime['publishChanged'],
  reportFailure?: MindCanvasNoteMutationRuntime['reportFailure'],
): MindCanvasNoteMutationRuntime {
  return {
    async create(ownerId, canvasId, input, undoContextId) {
      return withPostgresTransaction(pool, (client) =>
        mutationTransaction(client).create(ownerId, canvasId, input, undoContextId),
      )
    },
    async update(ownerId, nodeId, input, undoContextId) {
      return withPostgresTransaction(pool, (client) =>
        mutationTransaction(client).update(ownerId, nodeId, input, undoContextId),
      )
    },
    publishChanged,
    reportFailure,
  }
}
