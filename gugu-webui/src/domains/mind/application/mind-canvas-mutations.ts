import { runBestEffort } from '../../../adapters/best-effort.js'
import { toUtcIsoWithOffset } from '../../../shared/date-time.js'
import type { MindCanvasResponse } from '../mind-canvas-read.js'

export interface MindCanvasRecord {
  id: number
  title: string
  project_id: number | null
  data_json: string
  created_at: Date | string
  updated_at: Date | string
}

export interface MindCanvasUndoRecord {
  userId: string
  contextId: string
  resource: 'mind'
  action: 'create' | 'update'
  targetRefs: Array<{ kind: 'canvas'; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }
  afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, Record<string, never>>
}

export interface MindCanvasChangedEvent {
  ownerId: string
  operation: 'create' | 'update'
  entityId: number
  origin: string | null
  entity: MindCanvasResponse
}

export interface MindCanvasMutationTransaction {
  projectExistsForOwner(ownerId: string, projectId: number): Promise<boolean>
  insert(ownerId: string, title: string, projectId: number | null): Promise<MindCanvasRecord>
  getOwned(ownerId: string, canvasId: number): Promise<MindCanvasRecord | null>
  update(ownerId: string, canvasId: number, fields: { title?: string; dataJson?: string }): Promise<MindCanvasRecord | null>
  recordUndo(record: MindCanvasUndoRecord): Promise<void>
}

export interface MindCanvasMutationRuntime {
	transaction<T>(ownerId: string, work: (tx: MindCanvasMutationTransaction) => Promise<T>): Promise<T>
  publishChanged(event: MindCanvasChangedEvent): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}

export interface MindCanvasMutationMetadata {
  undoContextId: string | null
  clientId: string | null
}

export class MindCanvasMutationError extends Error {
  constructor(readonly statusCode: 404 | 422, message: string) {
    super(message)
    this.name = 'MindCanvasMutationError'
  }
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MindCanvasMutationError(422, '请求内容必须是对象')
  return value as Record<string, unknown>
}

function canvasResponse(row: MindCanvasRecord): MindCanvasResponse {
  let data: unknown = row.data_json
  if (typeof data === 'string') {
    try { data = JSON.parse(data || '{}') } catch { data = {} }
  }
  return {
    id: Number(row.id),
    title: row.title,
    projectId: row.project_id === null ? null : Number(row.project_id),
    data: data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {},
    createdAt: toUtcIsoWithOffset(row.created_at),
    updatedAt: toUtcIsoWithOffset(row.updated_at),
  }
}

function snapshot(row: MindCanvasRecord): Record<string, unknown> {
  return {
    id: Number(row.id),
    title: row.title,
    project_id: row.project_id === null ? null : Number(row.project_id),
    data_json: row.data_json,
    deleted_at: null,
  }
}

function undoRecord(
  ownerId: string,
  contextId: string | null,
  action: 'create' | 'update',
  row: MindCanvasRecord,
  before: Record<string, unknown> | null,
): MindCanvasUndoRecord | null {
  const normalized = contextId?.trim().slice(0, 128)
  if (!normalized) return null
  const key = `canvas:${row.id}`
  return {
    userId: ownerId,
    contextId: normalized,
    resource: 'mind',
    action,
    targetRefs: [{ kind: 'canvas', id: Number(row.id) }],
    beforeState: { items: before ? { [key]: before } : {} },
    afterState: { items: { [key]: snapshot(row) } },
    baseVersions: { [key]: {} },
  }
}

function projectId(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim())
      : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new MindCanvasMutationError(422, 'project_id 必须是整数或空值')
  return parsed
}

/** Creates and updates a canvas while keeping Undo atomic and live notifications post-commit. */
export function createMindCanvasMutations(runtime: MindCanvasMutationRuntime) {
  return {
    async create(ownerId: string, value: unknown, metadata: MindCanvasMutationMetadata): Promise<MindCanvasResponse> {
      const body = bodyObject(value)
      const rawTitle = body.title === undefined ? '未命名画布' : body.title
      if (typeof rawTitle !== 'string') throw new MindCanvasMutationError(422, 'title 必须是字符串')
      const title = rawTitle.trim() || '未命名画布'
      const rawProjectId = body.projectId === undefined ? body.project_id : body.projectId
      const selectedProjectId = projectId(rawProjectId)
      const row = await runtime.transaction(ownerId, async (tx) => {
        if (selectedProjectId !== null && !await tx.projectExistsForOwner(ownerId, selectedProjectId))
          throw new MindCanvasMutationError(404, '项目不存在')
        const created = await tx.insert(ownerId, title, selectedProjectId)
        const undo = undoRecord(ownerId, metadata.undoContextId, 'create', created, null)
        if (undo) await tx.recordUndo(undo)
        return created
      })
      const response = canvasResponse(row)
      await runBestEffort(
        'Mind canvas create notification',
        () => runtime.publishChanged({ ownerId, operation: 'create', entityId: row.id, origin: metadata.clientId, entity: response }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
      return response
    },

    async update(ownerId: string, canvasId: number, value: unknown, metadata: MindCanvasMutationMetadata): Promise<MindCanvasResponse> {
      const body = bodyObject(value)
      const fields: { title?: string; dataJson?: string } = {}
      if ('title' in body) {
        if (body.title !== null && typeof body.title !== 'string')
          throw new MindCanvasMutationError(422, 'title 必须是字符串或空值')
        fields.title = typeof body.title === 'string' ? body.title.trim() || '未命名画布' : '未命名画布'
      }
      if ('data' in body) {
        if (body.data !== null && (typeof body.data !== 'object' || Array.isArray(body.data)))
          throw new MindCanvasMutationError(422, 'data 必须是对象或空值')
        fields.dataJson = JSON.stringify(body.data)
      }
      const result = await runtime.transaction(ownerId, async (tx) => {
        const current = await tx.getOwned(ownerId, canvasId)
        if (!current) throw new MindCanvasMutationError(404, '画布不存在')
        const updated = await tx.update(ownerId, canvasId, fields)
        if (!updated) throw new MindCanvasMutationError(404, '画布不存在')
        const undo = undoRecord(ownerId, metadata.undoContextId, 'update', updated, snapshot(current))
        if (undo) await tx.recordUndo(undo)
        return updated
      })
      const response = canvasResponse(result)
      await runBestEffort(
        'Mind canvas update notification',
        () => runtime.publishChanged({ ownerId, operation: 'update', entityId: canvasId, origin: metadata.clientId, entity: response }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
      return response
    },
  }
}
