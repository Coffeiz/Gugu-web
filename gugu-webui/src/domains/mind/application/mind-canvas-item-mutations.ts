import { runBestEffort } from '../../../adapters/best-effort.js'
import type { MindCanvasItemResponse } from '../mind-canvas-read.js'

export interface MindCanvasItemCreateInput {
  nodeId: number
  x: number
  y: number
  w: number | null
  h: number | null
  z: number
  collapsed: boolean
  dataJson: string
}

export interface MindCanvasItemUpdateInput {
  x?: number
  y?: number
  w?: number | null
  h?: number | null
  z?: number
  collapsed?: boolean
  dataJson?: string
}

export interface MindCanvasItemChangedEvent {
  ownerId: string
  operation: 'create' | 'update' | 'delete'
  entityId: number
  origin: string | null
  mutationId: string | null
  entity: MindCanvasItemResponse | { id: number; canvas_id: number }
}

export interface MindCanvasItemMutationRuntime {
  add(
    ownerId: string,
    canvasId: number,
    input: MindCanvasItemCreateInput,
    undoContextId: string | null,
  ): Promise<{ item: MindCanvasItemResponse; created: boolean }>
  update(
    ownerId: string,
    canvasId: number,
    itemId: number,
    input: MindCanvasItemUpdateInput,
    undoContextId: string | null,
  ): Promise<MindCanvasItemResponse>
  bringToFront(
    ownerId: string,
    canvasId: number,
    itemId: number,
    x: number,
    y: number,
    undoContextId: string | null,
  ): Promise<MindCanvasItemResponse>
  remove(ownerId: string, canvasId: number, itemId: number, undoContextId: string | null): Promise<void>
  publishChanged(event: MindCanvasItemChangedEvent): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}

export interface MindCanvasItemMutationMetadata {
  undoContextId: string | null
  clientId: string | null
  mutationId: string | null
}

export class MindCanvasItemMutationError extends Error {
  constructor(message: string, readonly statusCode: 404 | 422) {
    super(message)
    this.name = 'MindCanvasItemMutationError'
  }
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MindCanvasItemMutationError('请求内容必须是对象', 422)
  return value as Record<string, unknown>
}

function finite(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new MindCanvasItemMutationError(`${name} 必须是有效数字`, 422)
  return value
}

function integer(value: unknown, name: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim())
      : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new MindCanvasItemMutationError(`${name} 必须是整数`, 422)
  return parsed
}

function optionalSize(body: Record<string, unknown>, key: 'w' | 'h'): number | null {
  if (!Object.hasOwn(body, key) || body[key] === null) return null
  return finite(body[key], key)
}

function dataJson(value: unknown, fallback: Record<string, unknown>): string {
  if (value === undefined) return JSON.stringify(fallback)
  if (value !== null && (typeof value !== 'object' || Array.isArray(value)))
    throw new MindCanvasItemMutationError('data 必须是对象或空值', 422)
  return JSON.stringify(value)
}

/** 对齐画布条目 add/update/bring-to-front/remove 的输入、Undo 与提交后事件边界。 */
export function createMindCanvasItemMutations(runtime: MindCanvasItemMutationRuntime) {
  return {
    async add(ownerId: string, canvasId: number, value: unknown, metadata: MindCanvasItemMutationMetadata) {
      const body = bodyObject(value)
      const nodeId = integer(body.nodeId ?? body.node_id, 'node_id')
      const input: MindCanvasItemCreateInput = {
        nodeId,
        x: finite(body.x, 'x', 0),
        y: finite(body.y, 'y', 0),
        w: optionalSize(body, 'w'),
        h: optionalSize(body, 'h'),
        z: integer(body.z, 'z', 0),
        collapsed: body.collapsed === undefined ? false : body.collapsed as boolean,
        dataJson: dataJson(body.data, {}),
      }
      if (typeof input.collapsed !== 'boolean')
        throw new MindCanvasItemMutationError('collapsed 必须是布尔值', 422)
      const result = await runtime.add(ownerId, canvasId, input, metadata.undoContextId)
      if (result.created) {
        await runBestEffort(
          'Mind canvas item create notification',
          () => runtime.publishChanged({
            ownerId, operation: 'create', entityId: result.item.id,
            origin: metadata.clientId, mutationId: metadata.mutationId, entity: result.item,
          }),
          (operation, error) => runtime.reportFailure?.(operation, error),
        )
      }
      return result.item
    },

    async update(
      ownerId: string,
      canvasId: number,
      itemId: number,
      value: unknown,
      metadata: MindCanvasItemMutationMetadata,
    ) {
      const body = bodyObject(value)
      const input: MindCanvasItemUpdateInput = {}
      for (const key of ['x', 'y'] as const) {
        if (Object.hasOwn(body, key)) input[key] = finite(body[key], key)
      }
      for (const key of ['w', 'h'] as const) {
        if (Object.hasOwn(body, key)) input[key] = body[key] === null ? null : finite(body[key], key)
      }
      if (Object.hasOwn(body, 'z')) input.z = integer(body.z, 'z')
      if (Object.hasOwn(body, 'collapsed')) {
        if (typeof body.collapsed !== 'boolean') throw new MindCanvasItemMutationError('collapsed 必须是布尔值', 422)
        input.collapsed = body.collapsed
      }
      if (Object.hasOwn(body, 'data')) input.dataJson = dataJson(body.data, {})
      const item = await runtime.update(ownerId, canvasId, itemId, input, metadata.undoContextId)
      await runBestEffort(
        'Mind canvas item update notification',
        () => runtime.publishChanged({ ownerId, operation: 'update', entityId: itemId, origin: metadata.clientId, mutationId: metadata.mutationId, entity: item }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
      return item
    },

    async bringToFront(
      ownerId: string,
      canvasId: number,
      itemId: number,
      value: unknown,
      metadata: MindCanvasItemMutationMetadata,
    ) {
      const body = bodyObject(value)
      const x = finite(body.x, 'x')
      const y = finite(body.y, 'y')
      const item = await runtime.bringToFront(ownerId, canvasId, itemId, x, y, metadata.undoContextId)
      await runBestEffort(
        'Mind canvas item z-order notification',
        () => runtime.publishChanged({ ownerId, operation: 'update', entityId: itemId, origin: metadata.clientId, mutationId: metadata.mutationId, entity: item }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
      return item
    },

    async remove(ownerId: string, canvasId: number, itemId: number, metadata: MindCanvasItemMutationMetadata) {
      await runtime.remove(ownerId, canvasId, itemId, metadata.undoContextId)
      await runBestEffort(
        'Mind canvas item delete notification',
        () => runtime.publishChanged({
          ownerId, operation: 'delete', entityId: itemId, origin: metadata.clientId, mutationId: metadata.mutationId,
          entity: { id: itemId, canvas_id: canvasId },
        }),
        (operation, error) => runtime.reportFailure?.(operation, error),
      )
    },
  }
}
