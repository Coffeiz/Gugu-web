import { MindCanvasMutationError } from './canvas-create.js'
export interface MindCanvasDeleteState {
  targetRefs: Array<{ kind: string; id: number }>
  before: Record<string, Record<string, unknown>>; after: Record<string, Record<string, unknown>>
}
export interface MindCanvasDeleteUndo {
  userId: string; contextId: string; resource: 'mind'; action: 'delete'
  targetRefs: Array<{ kind: string; id: number }>; beforeState: { items: Record<string, Record<string, unknown>> }
  afterState: { items: Record<string, Record<string, unknown>> }; baseVersions: Record<string, Record<string, never>>
}
export interface MindCanvasDeleteRuntime {
  transaction<T>(owner: string, work: (tx: { delete(owner: string, id: number): Promise<MindCanvasDeleteState | null>; recordUndo(record: MindCanvasDeleteUndo): Promise<void> }) => Promise<T>): Promise<T>
  publishChanged(event: { ownerId: string; operation: 'delete'; entityId: number; origin: string | null; entity: { id: number } }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}
/** 删除与 Undo 同事务；提交后再发布事件。 */
export function createMindCanvasDelete(runtime: MindCanvasDeleteRuntime) {
  return async (ownerId: string, canvasId: number, metadata: { undoContextId: string | null; clientId: string | null }): Promise<void> => {
    await runtime.transaction(ownerId, async tx => {
      const result = await tx.delete(ownerId, canvasId)
      if (!result) throw new MindCanvasMutationError(404, '画布不存在')
      const contextId = metadata.undoContextId?.trim().slice(0, 128)
      if (contextId) await tx.recordUndo({ userId: ownerId, contextId, resource: 'mind', action: 'delete', targetRefs: result.targetRefs, beforeState: { items: result.before }, afterState: { items: result.after }, baseVersions: {} })
    })
    try { await runtime.publishChanged({ ownerId, operation: 'delete', entityId: canvasId, origin: metadata.clientId, entity: { id: canvasId } }) } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      try { runtime.reportFailure?.('Mind canvas delete notification', code) } catch { /* 诊断不影响已提交操作。 */ }
    }
  }
}
