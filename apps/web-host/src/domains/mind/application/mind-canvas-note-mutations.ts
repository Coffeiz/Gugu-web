import { createHash } from 'node:crypto'
import { runBestEffort } from '../../../adapters/best-effort.js'
import { mindNotePlainText } from './mind-note-create.js'
import type { MindNoteReadResponse } from '../mind-notes-read.js'
import type { MindCanvasItemResponse } from '../mind-canvas-read.js'

const noteColors = new Set(['amber', 'coral', 'blue', 'teal'])

export interface MindCanvasNoteCreateInput {
  title: string
  contentMd: string
  color: string | null
  x: number
  y: number
  w: number | null
  h: number | null
  z: number
}

export interface MindCanvasNoteUpdateInput {
  version: number
  title?: string | null
  contentMd?: string
  color?: string | null
}

export interface MindCanvasNoteMutationEvent {
  ownerId: string
  operation: 'create' | 'update'
  entityId: number
  origin: string | null
  mutationId: string | null
  entityKind: 'canvas_item' | 'canvas_note'
  entity: MindCanvasItemResponse | MindNoteReadResponse
}

export interface MindCanvasNoteMutationRuntime {
  create(
    ownerId: string,
    canvasId: number,
    input: MindCanvasNoteCreateInput,
    undoContextId: string | null,
  ): Promise<MindCanvasItemResponse>
  update(
    ownerId: string,
    nodeId: number,
    input: MindCanvasNoteUpdateInput,
    undoContextId: string | null,
  ): Promise<{ note: MindNoteReadResponse; changed: boolean }>
  publishChanged(event: MindCanvasNoteMutationEvent): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}

export interface MindCanvasNoteMutationMetadata {
  undoContextId: string | null
  clientId: string | null
  mutationId?: string | null
}

export class MindCanvasNoteMutationError extends Error {
  constructor(message: string, readonly statusCode: 404 | 409 | 422) {
    super(message)
    this.name = 'MindCanvasNoteMutationError'
  }
}

function payload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MindCanvasNoteMutationError('请求内容必须是对象', 422)
  return value as Record<string, unknown>
}

function finiteNumber(value: unknown, field: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new MindCanvasNoteMutationError(`${field} 必须是有效数字`, 422)
  return value
}

function integer(value: unknown, field: string): number {
  const result = typeof value === 'number' ? value
    : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim())
      : Number.NaN
  if (!Number.isSafeInteger(result)) throw new MindCanvasNoteMutationError(`${field} 必须是整数`, 422)
  return result
}

function color(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !noteColors.has(value))
    throw new MindCanvasNoteMutationError('便签颜色必须是现有色板中的值', 422)
  return value
}

function canvasNoteSize(value: unknown, axis: 'w' | 'h'): number | null {
  if (value === undefined || value === null) return null
  const numberValue = finiteNumber(value, axis)
  const [minimum, maximum] = axis === 'w' ? [180, 520] : [100, 420]
  return Math.min(maximum, Math.max(minimum, numberValue))
}

/** 保持 Python 画布专属便签默认值、内容投影、色板与版本冲突语义。 */
export function createMindCanvasNoteMutations(runtime: MindCanvasNoteMutationRuntime) {
  return {
    async create(ownerId: string, canvasId: number, value: unknown, metadata: MindCanvasNoteMutationMetadata) {
      const body = payload(value)
      const rawTitle = body.title === undefined ? '新便签' : body.title
      if (typeof rawTitle !== 'string') throw new MindCanvasNoteMutationError('便签标题必须是文本', 422)
      if (rawTitle.length > 300) throw new MindCanvasNoteMutationError('便签标题不能超过 300 个字符', 422)
      const rawContent = body.contentMd === undefined ? body.content_md : body.contentMd
      const contentMd = rawContent === undefined ? '' : rawContent
      if (typeof contentMd !== 'string') throw new MindCanvasNoteMutationError('便签正文必须是文本', 422)
      const x = finiteNumber(body.x, 'x', 0)
      const y = finiteNumber(body.y, 'y', 0)
      const w = canvasNoteSize(body.w, 'w')
      const h = canvasNoteSize(body.h, 'h')
      const z = integer(body.z ?? 0, 'z')
      const input: MindCanvasNoteCreateInput = {
        title: rawTitle.trim() || '新便签',
        contentMd,
        color: color(body.color),
        x,
        y,
        w,
        h,
        z,
      }
      const item = await runtime.create(ownerId, canvasId, input, metadata.undoContextId)
      await runBestEffort(
        'Mind canvas note create notification',
        () => runtime.publishChanged({
          ownerId, operation: 'create', entityId: item.id, origin: metadata.clientId,
          mutationId: metadata.mutationId ?? null, entityKind: 'canvas_item', entity: item,
        }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
      return item
    },

    async update(ownerId: string, nodeId: number, value: unknown, metadata: MindCanvasNoteMutationMetadata) {
      const body = payload(value)
      const version = integer(body.version, 'version')
      const input: MindCanvasNoteUpdateInput = { version }
      if (Object.hasOwn(body, 'title')) {
        if (body.title !== null && typeof body.title !== 'string')
          throw new MindCanvasNoteMutationError('便签标题必须是文本或空值', 422)
        if (typeof body.title === 'string' && body.title.length > 300)
          throw new MindCanvasNoteMutationError('便签标题不能超过 300 个字符', 422)
        input.title = body.title as string | null
      }
      const rawContent = Object.hasOwn(body, 'contentMd') ? body.contentMd
        : Object.hasOwn(body, 'content_md') ? body.content_md : undefined
      if (rawContent !== undefined) {
        if (typeof rawContent !== 'string') throw new MindCanvasNoteMutationError('便签正文必须是文本', 422)
        input.contentMd = rawContent
      }
      if (Object.hasOwn(body, 'color')) input.color = color(body.color)

      const result = await runtime.update(ownerId, nodeId, input, metadata.undoContextId)
      if (result.changed) {
        await runBestEffort(
          'Mind canvas note update notification',
          () => runtime.publishChanged({
            ownerId, operation: 'update', entityId: nodeId, origin: metadata.clientId,
            mutationId: metadata.mutationId ?? null, entityKind: 'canvas_note', entity: result.note,
          }),
          (operation, error) => runtime.reportFailure?.(operation, error),
        )
      }
      return result.note
    },
  }
}

export function mindCanvasNoteContentProjection(contentMd: string): { contentPlain: string; indexedHash: string } {
  const contentPlain = mindNotePlainText(contentMd)
  return {
    contentPlain,
    indexedHash: createHash('sha256').update(contentPlain, 'utf8').digest('hex'),
  }
}
