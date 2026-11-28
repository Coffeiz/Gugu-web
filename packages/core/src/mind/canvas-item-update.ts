import { MindCanvasItemMutationError } from './canvas-item-remove.js'
import type { CanvasItemResponse } from './canvas-item-add.js'
export interface CanvasItemUpdateInput { x?: number; y?: number; w?: number | null; h?: number | null; z?: number; collapsed?: boolean; dataJson?: string }
export interface CanvasItemUpdateRuntime {
  update(owner: string, canvasId: number, itemId: number, input: CanvasItemUpdateInput, context: string | null): Promise<CanvasItemResponse>
  bringToFront(owner: string, canvasId: number, itemId: number, x: number, y: number, context: string | null): Promise<CanvasItemResponse>
  publishChanged(event: { ownerId: string; operation: 'update'; entityId: number; origin: string | null; mutationId: string | null; entity: CanvasItemResponse }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}
function bodyObject(value: unknown) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MindCanvasItemMutationError('请求内容必须是对象', 422); return value as Record<string, unknown> }
function finite(value: unknown, name: string) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new MindCanvasItemMutationError(`${name} 必须是有效数字`, 422); return value }
function integer(value: unknown, name: string) { const n = typeof value === 'number' ? value : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN; if (!Number.isSafeInteger(n)) throw new MindCanvasItemMutationError(`${name} 必须是整数`, 422); return n }
async function publish(runtime: CanvasItemUpdateRuntime, operation: string, ownerId: string, itemId: number, metadata: { clientId: string | null; mutationId: string | null }, item: CanvasItemResponse) { try { await runtime.publishChanged({ ownerId, operation: 'update', entityId: itemId, origin: metadata.clientId, mutationId: metadata.mutationId, entity: item }) } catch (error) { const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined; try { runtime.reportFailure?.(operation, code) } catch { /* 诊断不影响已提交操作。 */ } } }
export function createMindCanvasItemUpdate(runtime: CanvasItemUpdateRuntime) {
  return {
    async update(ownerId: string, canvasId: number, itemId: number, value: unknown, metadata: { undoContextId: string | null; clientId: string | null; mutationId: string | null }) {
      const body = bodyObject(value), input: CanvasItemUpdateInput = {}
      for (const key of ['x', 'y'] as const) if (Object.hasOwn(body, key)) input[key] = finite(body[key], key)
      for (const key of ['w', 'h'] as const) if (Object.hasOwn(body, key)) input[key] = body[key] === null ? null : finite(body[key], key)
      if (Object.hasOwn(body, 'z')) input.z = integer(body.z, 'z')
      if (Object.hasOwn(body, 'collapsed')) { if (typeof body.collapsed !== 'boolean') throw new MindCanvasItemMutationError('collapsed 必须是布尔值', 422); input.collapsed = body.collapsed }
      if (Object.hasOwn(body, 'data')) { if (body.data !== null && (typeof body.data !== 'object' || Array.isArray(body.data))) throw new MindCanvasItemMutationError('data 必须是对象或空值', 422); input.dataJson = JSON.stringify(body.data) }
      const item = await runtime.update(ownerId, canvasId, itemId, input, metadata.undoContextId)
      await publish(runtime, 'Mind canvas item update notification', ownerId, itemId, metadata, item)
      return item
    },
    async bringToFront(ownerId: string, canvasId: number, itemId: number, value: unknown, metadata: { undoContextId: string | null; clientId: string | null; mutationId: string | null }) {
      const body = bodyObject(value), x = finite(body.x, 'x'), y = finite(body.y, 'y')
      const item = await runtime.bringToFront(ownerId, canvasId, itemId, x, y, metadata.undoContextId)
      await publish(runtime, 'Mind canvas item z-order notification', ownerId, itemId, metadata, item)
      return item
    },
  }
}
