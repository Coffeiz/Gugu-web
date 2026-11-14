import { runBestEffort } from '../../../adapters/best-effort.js'
import { toUtcIsoWithOffset } from '../../../shared/date-time.js'
import type { MindRelationResponse } from '../mind-canvas-read.js'

export interface MindCanvasRelationRecord {
  id: number
  canvas_id: number | null
  src_node_id: number
  dst_node_id: number
  rel_type: string
  edge_key: string
  origin: string
  status: string
  note: string | null
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}

export interface MindCanvasRelationUndoRecord {
  userId: string
  contextId: string
  resource: 'mind'
  action: 'create' | 'delete'
  targetRefs: Array<{ kind: 'relation'; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, Record<string, never>>
}

export interface MindCanvasRelationTransaction {
  create(
    ownerId: string,
    canvasId: number,
    sourceId: number,
    targetId: number,
    allowParallel: boolean,
  ): Promise<{ relation: MindCanvasRelationRecord; before: MindCanvasRelationRecord | null; created: boolean }>
  delete(ownerId: string, canvasId: number, relationId: number): Promise<{
    before: MindCanvasRelationRecord
    after: MindCanvasRelationRecord
  } | null>
  deleteGlobal(ownerId: string, relationId: number): Promise<{
    before: MindCanvasRelationRecord
    after: MindCanvasRelationRecord
  } | null>
  recordUndo(record: MindCanvasRelationUndoRecord): Promise<void>
}

export interface MindCanvasRelationChangedEvent {
  ownerId: string
  operation: 'create' | 'delete'
  entityId: number
  origin: string | null
  mutationId: string | null
  entity: MindRelationResponse | { id: number; canvas_id: number | null }
}

export interface MindCanvasRelationMutationRuntime {
  transaction<T>(ownerId: string, work: (tx: MindCanvasRelationTransaction) => Promise<T>): Promise<T>
  publishChanged(event: MindCanvasRelationChangedEvent): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}

export interface MindCanvasRelationMutationMetadata {
  undoContextId: string | null
  clientId: string | null
  mutationId: string | null
}

export class MindCanvasRelationMutationError extends Error {
  constructor(readonly statusCode: 404 | 422, message: string) {
    super(message)
    this.name = 'MindCanvasRelationMutationError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MindCanvasRelationMutationError(422, '请求内容必须是对象')
  return value as Record<string, unknown>
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim())
      : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new MindCanvasRelationMutationError(422, `${field} 必须是整数`)
  return parsed
}

function snapshot(row: MindCanvasRelationRecord): Record<string, unknown> {
  return {
    id: Number(row.id), canvas_id: row.canvas_id === null ? null : Number(row.canvas_id), src_node_id: Number(row.src_node_id),
    dst_node_id: Number(row.dst_node_id), rel_type: row.rel_type, edge_key: row.edge_key,
    origin: row.origin, status: row.status, note: row.note,
    deleted_at: row.deleted_at ? toUtcIsoWithOffset(row.deleted_at) : null,
  }
}

function response(row: MindCanvasRelationRecord): MindRelationResponse {
  return {
    id: Number(row.id), canvasId: row.canvas_id === null ? null : Number(row.canvas_id),
    srcNodeId: Number(row.src_node_id), dstNodeId: Number(row.dst_node_id),
    relType: row.rel_type, origin: row.origin, status: row.status,
    createdAt: toUtcIsoWithOffset(row.created_at), updatedAt: toUtcIsoWithOffset(row.updated_at),
  }
}

function undoRecord(
  ownerId: string,
  contextId: string | null,
  action: 'create' | 'delete',
  row: MindCanvasRelationRecord,
  before: MindCanvasRelationRecord | null,
): MindCanvasRelationUndoRecord | null {
  const context = contextId?.trim().slice(0, 128)
  if (!context) return null
  const id = Number(row.id)
  const key = `relation:${id}`
  return {
    userId: ownerId, contextId: context, resource: 'mind', action,
    targetRefs: [{ kind: 'relation', id }],
    beforeState: { items: before ? { [key]: snapshot(before) } : {} },
    afterState: { items: { [key]: snapshot(row) } },
    baseVersions: { [key]: {} },
  }
}

/** Canvas relations are scoped to one canvas; Undo is atomic and events follow commit. */
export function createMindCanvasRelationMutations(runtime: MindCanvasRelationMutationRuntime) {
  return {
    async create(ownerId: string, value: unknown, metadata: MindCanvasRelationMutationMetadata) {
      const body = object(value)
      const canvasId = integer(body.canvasId ?? body.canvas_id, 'canvas_id')
      const sourceId = integer(body.srcNodeId ?? body.src_node_id, 'src_node_id')
      const targetId = integer(body.dstNodeId ?? body.dst_node_id, 'dst_node_id')
      if (typeof (body.allowParallel ?? body.allow_parallel ?? false) !== 'boolean')
        throw new MindCanvasRelationMutationError(422, 'allow_parallel 必须是布尔值')
      const allowParallel = Boolean(body.allowParallel ?? body.allow_parallel ?? false)
      if (sourceId === targetId) throw new MindCanvasRelationMutationError(422, '节点不能连向自己')
      const result = await runtime.transaction(ownerId, async (tx) => {
        const created = await tx.create(ownerId, canvasId, sourceId, targetId, allowParallel)
        const undo = undoRecord(ownerId, metadata.undoContextId, 'create', created.relation, created.before)
        if (undo) await tx.recordUndo(undo)
        return created
      })
      const mapped = response(result.relation)
      await runBestEffort(
        'Mind canvas relation create notification',
        () => runtime.publishChanged({
          ownerId, operation: 'create', entityId: mapped.id, origin: metadata.clientId,
          mutationId: metadata.mutationId, entity: mapped,
        }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
      return mapped
    },

    async delete(ownerId: string, canvasId: number, relationId: number, metadata: MindCanvasRelationMutationMetadata) {
      const row = await runtime.transaction(ownerId, async (tx) => {
        const deleted = await tx.delete(ownerId, canvasId, relationId)
        if (!deleted) throw new MindCanvasRelationMutationError(404, '画布关联不存在')
        const undo = undoRecord(ownerId, metadata.undoContextId, 'delete', deleted.after, deleted.before)
        if (undo) await tx.recordUndo(undo)
        return deleted.after
      })
      await runBestEffort(
        'Mind canvas relation delete notification',
        () => runtime.publishChanged({
          ownerId, operation: 'delete', entityId: relationId, origin: metadata.clientId,
          mutationId: metadata.mutationId, entity: { id: relationId, canvas_id: canvasId },
        }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
      return row
    },

    async deleteGlobal(ownerId: string, relationId: number, metadata: MindCanvasRelationMutationMetadata) {
      const row = await runtime.transaction(ownerId, async (tx) => {
        const deleted = await tx.deleteGlobal(ownerId, relationId)
        if (!deleted) throw new MindCanvasRelationMutationError(404, '关联不存在')
        const undo = undoRecord(ownerId, metadata.undoContextId, 'delete', deleted.after, deleted.before)
        if (undo) await tx.recordUndo(undo)
        return deleted.after
      })
      await runBestEffort(
        'Mind relation delete notification',
        () => runtime.publishChanged({
          ownerId, operation: 'delete', entityId: relationId, origin: metadata.clientId,
          mutationId: metadata.mutationId, entity: { id: relationId, canvas_id: null },
        }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
      return row
    },
  }
}
