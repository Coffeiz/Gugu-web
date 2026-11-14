import { runBestEffort } from '../../../adapters/best-effort.js'
import { toUtcIsoWithOffset } from '../../../shared/date-time.js'
import type { MindNoteReadResponse } from '../mind-notes-read.js'

export type MindReferenceType = 'project' | 'file' | 'event'

export interface MindReferenceNodeSnapshot {
  id: number | string
  kind: string
  title: string | null
  content_md: string | null
  content_plain: string
  color: string | null
  captured_at: Date | string
  version: number | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
  ref_type: string | null
  ref_id: number | string | null
  ref_snapshot: Record<string, unknown> | null
  origin: string
}

export interface MindRefNodeUndoRecord {
  userId: string
  contextId: string
  resource: 'mind'
  action: 'create'
  targetRefs: Array<{ kind: 'ref_node'; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, { version: number }>
}

export interface MindRefNodeTransaction {
  create(ownerId: string, refType: MindReferenceType, refId: number): Promise<{
    node: MindReferenceNodeSnapshot
    created: boolean
  }>
  recordUndo(record: MindRefNodeUndoRecord): Promise<void>
}

export interface MindRefNodeChangedEvent {
  ownerId: string
  entityId: number
  origin: string | null
  mutationId: string | null
  entity: MindNoteReadResponse
}

export interface MindRefNodeCreateRuntime {
  transaction<T>(ownerId: string, work: (tx: MindRefNodeTransaction) => Promise<T>): Promise<T>
  publishChanged(event: MindRefNodeChangedEvent): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}

export interface MindRefNodeCreateMetadata {
  undoContextId: string | null
  clientId: string | null
  mutationId: string | null
}

export class MindRefNodeCreateError extends Error {
  constructor(readonly statusCode: 404 | 422, message: string) {
    super(message)
    this.name = 'MindRefNodeCreateError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MindRefNodeCreateError(422, '请求内容必须是对象')
  return value as Record<string, unknown>
}

function referenceType(value: unknown): MindReferenceType {
  if (value === 'project' || value === 'file' || value === 'event') return value
  throw new MindRefNodeCreateError(422, '不支持的引用类型')
}

function referenceId(value: unknown): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim())
      : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new MindRefNodeCreateError(422, 'ref_id 必须是整数')
  return parsed
}

function snapshot(node: MindReferenceNodeSnapshot): Record<string, unknown> {
  return {
    id: Number(node.id), kind: node.kind, title: node.title, content_md: node.content_md,
    content_plain: node.content_plain, color: node.color,
    captured_at: toUtcIsoWithOffset(node.captured_at),
    version: Number(node.version), ref_type: node.ref_type, ref_id: node.ref_id,
    ref_snapshot: node.ref_snapshot, origin: node.origin,
    deleted_at: node.deleted_at ? toUtcIsoWithOffset(node.deleted_at) : null,
  }
}

/** Reuse per-owner reference nodes and record Undo only when this request inserts one. */
export function createMindRefNodeCreator(runtime: MindRefNodeCreateRuntime) {
  return {
    async create(ownerId: string, value: unknown, metadata: MindRefNodeCreateMetadata): Promise<MindNoteReadResponse> {
      const body = object(value)
      const refType = referenceType(body.refType ?? body.ref_type)
      const refId = referenceId(body.refId ?? body.ref_id)
      const result = await runtime.transaction(ownerId, async (tx) => {
        const created = await tx.create(ownerId, refType, refId)
        if (created.created) {
          const contextId = metadata.undoContextId?.trim().slice(0, 128)
          if (contextId) {
            const nodeId = Number(created.node.id)
            const key = `ref_node:${nodeId}`
            await tx.recordUndo({
              userId: ownerId,
              contextId,
              resource: 'mind',
              action: 'create',
              targetRefs: [{ kind: 'ref_node', id: nodeId }],
              beforeState: { items: {} },
              afterState: { items: { [key]: snapshot(created.node) } },
              baseVersions: { [key]: { version: 0 } },
            })
          }
        }
        return created
      })
      const response: MindNoteReadResponse = {
        id: Number(result.node.id), kind: result.node.kind, title: result.node.title,
        contentMd: result.node.content_md ?? '', color: result.node.color,
        capturedAt: toUtcIsoWithOffset(result.node.captured_at), version: Number(result.node.version),
        createdAt: toUtcIsoWithOffset(result.node.created_at),
        updatedAt: toUtcIsoWithOffset(result.node.updated_at),
        deletedAt: result.node.deleted_at ? toUtcIsoWithOffset(result.node.deleted_at) : null,
        refType: result.node.ref_type,
        refId: result.node.ref_id === null ? null : Number(result.node.ref_id),
        refSnapshot: result.node.ref_snapshot,
      }
      if (result.created) {
        await runBestEffort(
          'Mind reference node create notification',
          () => runtime.publishChanged({
            ownerId, entityId: response.id, origin: metadata.clientId,
            mutationId: metadata.mutationId, entity: response,
          }),
          (operation, error) => runtime.reportFailure?.(operation, error),
        )
      }
      return response
    },
  }
}
