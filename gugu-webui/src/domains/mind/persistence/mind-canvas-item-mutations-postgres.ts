import type { Pool, PoolClient } from 'pg'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { toUtcIsoWithOffset } from '../../../shared/date-time.js'
import { recordForwardUndoOperation } from '../../undo/persistence/forward-operation.js'
import { MindCanvasItemMutationError, type MindCanvasItemMutationRuntime, type MindCanvasItemUpdateInput } from '../application/mind-canvas-item-mutations.js'
import type { MindCanvasItemResponse } from '../mind-canvas-read.js'
import { toMindNoteReadResponse } from '../mind-notes-read.js'
import type { MindNotePersistenceRow } from './mind-note-snapshot.js'

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

type JoinedRow = Record<string, unknown> & {
  id: number | string
  item_user_id: string
  canvas_id: number | string
  node_id: number | string
  x: number
  y: number
  w: number | null
  h: number | null
  z: number | string
  collapsed: boolean
  item_data_json: string
  item_created_at: Date | string
  item_updated_at: Date | string
  item_deleted_at: Date | string | null
  kind: string
  node_title: string | null
  content_md: string | null
  content_plain: string
  color: string | null
  captured_at: Date | string
  version: number | string
  node_created_at: Date | string
  node_updated_at: Date | string
  node_deleted_at: Date | string | null
  ref_type: string | null
  ref_id: number | string | null
  ref_snapshot: Record<string, unknown> | null
  origin: string
}

const itemColumns = `id, user_id, canvas_id, node_id, x, y, w, h, z, collapsed, data_json,
  created_at, updated_at, deleted_at`
const joinedSelect = `SELECT ci.id, ci.user_id AS item_user_id, ci.canvas_id, ci.node_id,
  ci.x, ci.y, ci.w, ci.h, ci.z, ci.collapsed, ci.data_json AS item_data_json,
  ci.created_at AS item_created_at, ci.updated_at AS item_updated_at, ci.deleted_at AS item_deleted_at,
  n.kind, n.title AS node_title, n.content_md, n.content_plain, n.color, n.captured_at, n.version,
  n.created_at AS node_created_at, n.updated_at AS node_updated_at, n.deleted_at AS node_deleted_at,
  n.ref_type, n.ref_id, n.ref_snapshot, n.origin
  FROM mind_canvas_items ci JOIN mind_nodes n ON n.id=ci.node_id`

function mapItem(row: JoinedRow): ItemRow {
  return {
    id: row.id,
    user_id: row.item_user_id,
    canvas_id: row.canvas_id,
    node_id: row.node_id,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    z: row.z,
    collapsed: row.collapsed,
    data_json: row.item_data_json,
    created_at: row.item_created_at,
    updated_at: row.item_updated_at,
    deleted_at: row.item_deleted_at,
  }
}

function mapNode(row: JoinedRow): MindNotePersistenceRow {
  return {
    id: row.node_id,
    kind: row.kind,
    title: row.node_title,
    content_md: row.content_md as string | null,
    content_plain: row.content_plain,
    color: row.color,
    captured_at: row.captured_at,
    version: row.version,
    created_at: row.node_created_at,
    updated_at: row.node_updated_at,
    deleted_at: row.node_deleted_at,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    ref_snapshot: row.ref_snapshot,
    origin: row.origin,
  }
}

function parseData(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function itemSnapshot(row: ItemRow): Record<string, unknown> {
  return {
    id: Number(row.id), canvas_id: Number(row.canvas_id), node_id: Number(row.node_id),
    x: row.x, y: row.y, w: row.w, h: row.h, z: Number(row.z), collapsed: row.collapsed,
    data_json: row.data_json, deleted_at: row.deleted_at ? toUtcIsoWithOffset(row.deleted_at) : null,
  }
}

async function refData(
  client: PoolClient,
  ownerId: string,
  node: MindNotePersistenceRow,
): Promise<MindCanvasItemResponse['refData']> {
  if (node.ref_type !== 'event' || node.ref_id === null) return null
  const result = await client.query<{ date: string; time: string | null; end_time: string | null; description: string | null }>(
    `SELECT date, time, end_time, description FROM calendar_events
     WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [node.ref_id, ownerId],
  )
  const row = result.rows[0]
  return row ? { date: String(row.date), time: row.time, endTime: row.end_time, description: row.description } : null
}

async function response(
  client: PoolClient,
  ownerId: string,
  item: ItemRow,
  node: MindNotePersistenceRow,
): Promise<MindCanvasItemResponse> {
  let data: unknown
  try { data = JSON.parse(item.data_json || '{}') } catch { data = {} }
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
    data: data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {},
    refData: await refData(client, ownerId, node),
    node: toMindNoteReadResponse(node),
    createdAt: toUtcIsoWithOffset(item.created_at),
    updatedAt: toUtcIsoWithOffset(item.updated_at),
  }
}

async function requireCanvas(client: PoolClient, ownerId: string, canvasId: number): Promise<{ data_json: string }> {
  const result = await client.query<{ data_json: string }>(
    'SELECT data_json FROM mind_maps WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE',
    [canvasId, ownerId],
  )
  const canvas = result.rows[0]
  if (!canvas) throw new MindCanvasItemMutationError('画布不存在', 404)
  return canvas
}

async function findNode(client: PoolClient, ownerId: string, nodeId: number): Promise<MindNotePersistenceRow> {
  const result = await client.query<MindNotePersistenceRow>(
    `SELECT id, kind, title, content_md, content_plain, color, captured_at, version,
            created_at, updated_at, deleted_at, ref_type, ref_id, ref_snapshot, origin
     FROM mind_nodes WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
    [nodeId, ownerId],
  )
  const node = result.rows[0]
  if (!node) throw new MindCanvasItemMutationError('节点不存在', 404)
  return node
}

async function findCanvasItem(
  client: PoolClient,
  ownerId: string,
  canvasId: number,
  itemId: number,
): Promise<{ item: ItemRow; node: MindNotePersistenceRow }> {
  const result = await client.query<JoinedRow>(
    `${joinedSelect}
     WHERE ci.id=$1 AND ci.canvas_id=$2 AND ci.user_id=$3 AND ci.deleted_at IS NULL
       AND n.user_id=$3 AND n.deleted_at IS NULL
     FOR UPDATE OF ci, n`,
    [itemId, canvasId, ownerId],
  )
  const row = result.rows[0]
  if (!row) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
  return { item: mapItem(row), node: mapNode(row) }
}

async function recordUndo(
  client: PoolClient,
  ownerId: string,
  contextId: string | null,
  action: 'create' | 'update' | 'delete',
  before: ItemRow | null,
  after: ItemRow,
): Promise<void> {
  const context = contextId?.trim().slice(0, 128)
  if (!context) return
  const id = Number(after.id)
  const key = `canvas_item:${id}`
  await recordForwardUndoOperation(client, {
    userId: ownerId,
    contextId: context,
    resource: 'mind',
    action,
    targetRefs: [{ kind: 'canvas_item', id }],
    beforeState: { items: before ? { [key]: itemSnapshot(before) } : {} },
    afterState: { items: { [key]: itemSnapshot(after) } },
    baseVersions: { [key]: {} },
  })
}

function noteSize(value: number | null, axis: 'w' | 'h'): number | null {
  if (value === null) return null
  const [minimum, maximum] = axis === 'w' ? [180, 520] : [100, 420]
  return Math.min(maximum, Math.max(minimum, value))
}

async function fetchItemSnapshots(client: PoolClient, ownerId: string, canvasId: number): Promise<ItemRow[]> {
  const result = await client.query<ItemRow>(
    `SELECT ${itemColumns} FROM mind_canvas_items
     WHERE canvas_id=$1 AND user_id=$2 ORDER BY id FOR UPDATE`,
    [canvasId, ownerId],
  )
  return result.rows
}

function mutationTransaction(client: PoolClient) {
  return {
    async add(ownerId: string, canvasId: number, input: {
      nodeId: number; x: number; y: number; w: number | null; h: number | null; z: number;
      collapsed: boolean; dataJson: string;
    }, undoContextId: string | null): Promise<{ item: MindCanvasItemResponse; created: boolean }> {
      await requireCanvas(client, ownerId, canvasId)
      const node = await findNode(client, ownerId, input.nodeId)
      const existing = await client.query<ItemRow>(
        `SELECT ${itemColumns} FROM mind_canvas_items
         WHERE canvas_id=$1 AND node_id=$2 AND user_id=$3 FOR UPDATE`,
        [canvasId, input.nodeId, ownerId],
      )
      const existingItem = existing.rows[0]
      if (existingItem && existingItem.deleted_at === null)
        return { item: await response(client, ownerId, existingItem, node), created: false }

      let inserted: ItemRow | undefined
      if (existingItem) {
        const restored = await client.query<ItemRow>(
          `UPDATE mind_canvas_items SET x=$4, y=$5, w=$6, h=$7, z=$8, collapsed=$9,
             data_json=$10, deleted_at=NULL, updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND canvas_id=$2 AND user_id=$3 RETURNING ${itemColumns}`,
          [existingItem.id, canvasId, ownerId, input.x, input.y, input.w, input.h, input.z, input.collapsed, input.dataJson || '{}'],
        )
        inserted = restored.rows[0]
      } else {
        const created = await client.query<ItemRow>(
          `INSERT INTO mind_canvas_items (
             user_id, canvas_id, node_id, x, y, w, h, z, collapsed, data_json,
             created_at, updated_at, deleted_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL)
           ON CONFLICT (canvas_id, node_id) DO NOTHING
           RETURNING ${itemColumns}`,
          [ownerId, canvasId, input.nodeId, input.x, input.y, input.w, input.h, input.z, input.collapsed, input.dataJson || '{}'],
        )
        inserted = created.rows[0]
        if (!inserted) {
          const raced = await client.query<ItemRow>(
            `SELECT ${itemColumns} FROM mind_canvas_items
             WHERE canvas_id=$1 AND node_id=$2 AND user_id=$3 FOR UPDATE`,
            [canvasId, input.nodeId, ownerId],
          )
          const racedItem = raced.rows[0]
          if (!racedItem) throw new Error('并发创建画布贴纸后未返回记录')
          if (racedItem.deleted_at === null)
            return { item: await response(client, ownerId, racedItem, node), created: false }
          const restored = await client.query<ItemRow>(
            `UPDATE mind_canvas_items SET x=$4, y=$5, w=$6, h=$7, z=$8, collapsed=$9,
               data_json=$10, deleted_at=NULL, updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND canvas_id=$2 AND user_id=$3 RETURNING ${itemColumns}`,
            [racedItem.id, canvasId, ownerId, input.x, input.y, input.w, input.h, input.z, input.collapsed, input.dataJson || '{}'],
          )
          inserted = restored.rows[0]
        }
      }
      if (!inserted) throw new Error('画布贴纸写入后未返回记录')
      await recordUndo(client, ownerId, undoContextId, 'create', null, inserted)
      return { item: await response(client, ownerId, inserted, node), created: true }
    },

    async update(
      ownerId: string,
      canvasId: number,
      itemId: number,
      input: MindCanvasItemUpdateInput,
      undoContextId: string | null,
    ): Promise<MindCanvasItemResponse> {
      await requireCanvas(client, ownerId, canvasId)
      const { item: before, node } = await findCanvasItem(client, ownerId, canvasId, itemId)
      const assignments: string[] = []
      const values: unknown[] = [itemId, canvasId, ownerId]
      const fields = { ...input }
      if (node.kind === 'canvas_note') {
        if (fields.w !== undefined) fields.w = noteSize(fields.w, 'w')
        if (fields.h !== undefined) fields.h = noteSize(fields.h, 'h')
      }
      for (const key of ['x', 'y', 'w', 'h', 'z', 'collapsed', 'dataJson'] as const) {
        const value = fields[key]
        if (value === undefined) continue
        values.push(value)
        const column = key === 'dataJson' ? 'data_json' : key
        assignments.push(`${column}=$${values.length}`)
      }
      if (!assignments.length) return response(client, ownerId, before, node)
      assignments.push('updated_at=CURRENT_TIMESTAMP')
      const updated = await client.query<ItemRow>(
        `UPDATE mind_canvas_items SET ${assignments.join(', ')}
         WHERE id=$1 AND canvas_id=$2 AND user_id=$3 AND deleted_at IS NULL
         RETURNING ${itemColumns}`,
        values,
      )
      const after = updated.rows[0]
      if (!after) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      await recordUndo(client, ownerId, undoContextId, 'update', before, after)
      return response(client, ownerId, after, node)
    },

    async bringToFront(
      ownerId: string,
      canvasId: number,
      itemId: number,
      x: number,
      y: number,
      undoContextId: string | null,
    ): Promise<MindCanvasItemResponse> {
      await requireCanvas(client, ownerId, canvasId)
      const beforeRows = await fetchItemSnapshots(client, ownerId, canvasId)
      const active = await client.query<JoinedRow>(
        `${joinedSelect}
         WHERE ci.canvas_id=$1 AND ci.user_id=$2 AND ci.deleted_at IS NULL
           AND n.user_id=$2 AND n.deleted_at IS NULL
         ORDER BY ci.z, ci.id FOR UPDATE OF ci, n`,
        [canvasId, ownerId],
      )
      const target = active.rows.find((row) => Number(row.id) === itemId)
      if (!target) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      const ordered = [...active.rows.filter((row) => Number(row.id) !== itemId), target]
      let targetItem: ItemRow | null = null
      for (const [index, row] of ordered.entries()) {
        const position = index + 1
        const update = await client.query<ItemRow>(
          `UPDATE mind_canvas_items SET z=$4, x=$5, y=$6, updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND canvas_id=$2 AND user_id=$3 AND deleted_at IS NULL
           RETURNING ${itemColumns}`,
          [row.id, canvasId, ownerId, position * 1000, Number(row.id) === itemId ? x : Number(row.x), Number(row.id) === itemId ? y : Number(row.y)],
        )
        if (Number(row.id) === itemId) targetItem = update.rows[0] ?? null
      }
      if (!targetItem) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      const afterRows = await fetchItemSnapshots(client, ownerId, canvasId)
      const context = undoContextId?.trim().slice(0, 128)
      if (context) {
        const key = (row: ItemRow) => `canvas_item:${row.id}`
        await recordForwardUndoOperation(client, {
          userId: ownerId,
          contextId: context,
          resource: 'mind',
          action: 'update',
          targetRefs: beforeRows.map((row) => ({ kind: 'canvas_item', id: Number(row.id) })),
          beforeState: { items: Object.fromEntries(beforeRows.map((row) => [key(row), itemSnapshot(row)])) },
          afterState: { items: Object.fromEntries(afterRows.map((row) => [key(row), itemSnapshot(row)])) },
          baseVersions: {},
        })
      }
      return response(client, ownerId, targetItem, mapNode(target))
    },

    async remove(ownerId: string, canvasId: number, itemId: number, undoContextId: string | null): Promise<void> {
      const canvas = await requireCanvas(client, ownerId, canvasId)
      const { item: before } = await findCanvasItem(client, ownerId, canvasId, itemId)
      const relationResult = await client.query<{ id: number | string }>(
        `SELECT id FROM mind_relations
         WHERE user_id=$1 AND canvas_id=$2 AND (src_node_id=$3 OR dst_node_id=$3)`,
        [ownerId, canvasId, before.node_id],
      )
      if (relationResult.rows.length) {
        const relationIds = new Set<number>()
        const rawIds = parseData(canvas.data_json).detachedRelationIds
        if (Array.isArray(rawIds)) {
          for (const id of rawIds) if (Number.isSafeInteger(id)) relationIds.add(id as number)
        }
        for (const relation of relationResult.rows) relationIds.add(Number(relation.id))
        const mapData = parseData(canvas.data_json)
        mapData.detachedRelationIds = [...relationIds].sort((a, b) => a - b)
        await client.query(
          'UPDATE mind_maps SET data_json=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL',
          [canvasId, ownerId, JSON.stringify(mapData)],
        )
      }
      const deleted = await client.query<ItemRow>(
        `UPDATE mind_canvas_items SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND canvas_id=$2 AND user_id=$3 AND deleted_at IS NULL
         RETURNING ${itemColumns}`,
        [itemId, canvasId, ownerId],
      )
      const after = deleted.rows[0]
      if (!after) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      await recordUndo(client, ownerId, undoContextId, 'delete', before, after)
    },
  }
}

export function createPostgresMindCanvasItemMutationRuntime(
  pool: Pick<Pool, 'connect'>,
  publishChanged: MindCanvasItemMutationRuntime['publishChanged'],
  reportFailure?: MindCanvasItemMutationRuntime['reportFailure'],
): MindCanvasItemMutationRuntime {
  return {
    async add(ownerId, canvasId, input, undoContextId) {
      return withPostgresTransaction(pool, (client) =>
        mutationTransaction(client).add(ownerId, canvasId, input, undoContextId),
      )
    },
    async update(ownerId, canvasId, itemId, input, undoContextId) {
      return withPostgresTransaction(pool, (client) =>
        mutationTransaction(client).update(ownerId, canvasId, itemId, input, undoContextId),
      )
    },
    async bringToFront(ownerId, canvasId, itemId, x, y, undoContextId) {
      return withPostgresTransaction(pool, (client) =>
        mutationTransaction(client).bringToFront(ownerId, canvasId, itemId, x, y, undoContextId),
      )
    },
    async remove(ownerId, canvasId, itemId, undoContextId) {
      return withPostgresTransaction(pool, (client) =>
        mutationTransaction(client).remove(ownerId, canvasId, itemId, undoContextId),
      )
    },
    publishChanged,
    reportFailure,
  }
}
