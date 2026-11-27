import type { CanvasReferenceData } from '../contracts/desktop.js'
import { MindCanvasItemMutationError } from './canvas-item-remove.js'
import type { MindNoteReadResponse } from './note-create.js'
export interface CanvasItemAddInput { nodeId: number; x: number; y: number; w: number | null; h: number | null; z: number; collapsed: boolean; dataJson: string }
export interface CanvasItemResponse { id: number; canvasId: number; nodeId: number; x: number; y: number; w: number | null; h: number | null; z: number; collapsed: boolean; data: Record<string, unknown>; refData: CanvasReferenceData | null; node: MindNoteReadResponse; createdAt: string; updatedAt: string }
export interface CanvasItemAddRuntime {
  add(owner: string, canvasId: number, input: CanvasItemAddInput, context: string | null): Promise<{ item: CanvasItemResponse; created: boolean }>
  publishChanged(event: { ownerId: string; operation: 'create'; entityId: number; origin: string | null; mutationId: string | null; entity: CanvasItemResponse }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}
function integer(value: unknown, name: string, fallback?: number) { const n = value === undefined && fallback !== undefined ? fallback : typeof value === 'number' ? value : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN; if (!Number.isSafeInteger(n)) throw new MindCanvasItemMutationError(`${name} 必须是整数`, 422); return n }
function finite(value: unknown, name: string, fallback?: number) { const n = value === undefined ? fallback : value; if (typeof n !== 'number' || !Number.isFinite(n)) throw new MindCanvasItemMutationError(`${name} 必须是有效数字`, 422); return n }
export function createMindCanvasItemAdd(runtime: CanvasItemAddRuntime) {
  return async (ownerId: string, canvasId: number, value: unknown, metadata: { undoContextId: string | null; clientId: string | null; mutationId: string | null }) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MindCanvasItemMutationError('请求内容必须是对象', 422)
    const body = value as Record<string, unknown>
    if (body.data !== undefined && body.data !== null && (typeof body.data !== 'object' || Array.isArray(body.data))) throw new MindCanvasItemMutationError('data 必须是对象或空值', 422)
    const collapsed = body.collapsed === undefined ? false : body.collapsed
    if (typeof collapsed !== 'boolean') throw new MindCanvasItemMutationError('collapsed 必须是布尔值', 422)
    const input: CanvasItemAddInput = { nodeId: integer(body.nodeId ?? body.node_id, 'node_id'), x: finite(body.x, 'x', 0), y: finite(body.y, 'y', 0), w: body.w === undefined || body.w === null ? null : finite(body.w, 'w'), h: body.h === undefined || body.h === null ? null : finite(body.h, 'h'), z: integer(body.z, 'z', 0), collapsed, dataJson: JSON.stringify(body.data === undefined ? {} : body.data) }
    const result = await runtime.add(ownerId, canvasId, input, metadata.undoContextId)
    if (result.created) try { await runtime.publishChanged({ ownerId, operation: 'create', entityId: result.item.id, origin: metadata.clientId, mutationId: metadata.mutationId, entity: result.item }) } catch (error) { const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined; try { runtime.reportFailure?.('Mind canvas item create notification', code) } catch { /* 诊断不影响已提交操作。 */ } }
    return result.item
  }
}
