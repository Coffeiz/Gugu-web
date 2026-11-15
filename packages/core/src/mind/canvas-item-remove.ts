export class MindCanvasItemMutationError extends Error {
  constructor(message: string, readonly statusCode: 404 | 422) { super(message); this.name = 'MindCanvasItemMutationError' }
}
export interface MindCanvasItemRemoveRuntime {
  remove(ownerId: string, canvasId: number, itemId: number, undoContextId: string | null): Promise<void>
  publishChanged(event: { ownerId: string; operation: 'delete'; entityId: number; origin: string | null; mutationId: string | null; entity: { id: number; canvas_id: number } }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}
/** 事务成功后发布画布条目移除事件。 */
export function createMindCanvasItemRemove(runtime: MindCanvasItemRemoveRuntime) {
  return async (ownerId: string, canvasId: number, itemId: number, metadata: { undoContextId: string | null; clientId: string | null; mutationId: string | null }) => {
    await runtime.remove(ownerId, canvasId, itemId, metadata.undoContextId)
    try { await runtime.publishChanged({ ownerId, operation: 'delete', entityId: itemId, origin: metadata.clientId, mutationId: metadata.mutationId, entity: { id: itemId, canvas_id: canvasId } }) } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      try { runtime.reportFailure?.('Mind canvas item delete notification', code) } catch { /* 诊断失败不影响已提交操作。 */ }
    }
  }
}
