import { MindCanvasRelationMutationError, type GlobalRelationRecord, type GlobalRelationUndo } from './relation-delete-global.js'
export interface CanvasRelationDeleteRuntime {
  transaction<T>(owner: string, work: (tx: { delete(owner: string, canvasId: number, relationId: number): Promise<{ before: GlobalRelationRecord; after: GlobalRelationRecord } | null>; recordUndo(record: GlobalRelationUndo): Promise<void> }) => Promise<T>): Promise<T>
  publishChanged(event: { ownerId: string; operation: 'delete'; entityId: number; origin: string | null; mutationId: string | null; entity: { id: number; canvas_id: number } }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}
function snapshot(row: GlobalRelationRecord) { return { id: Number(row.id), canvas_id: row.canvas_id === null ? null : Number(row.canvas_id), src_node_id: Number(row.src_node_id), dst_node_id: Number(row.dst_node_id), rel_type: row.rel_type, edge_key: row.edge_key, origin: row.origin, status: row.status, note: row.note, deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString().replace(/Z$/, '+00:00') : null } }
/** 画布关系与 Undo 同事务提交，提交后发布事件。 */
export function createMindCanvasRelationDelete(runtime: CanvasRelationDeleteRuntime) {
  return async (ownerId: string, canvasId: number, relationId: number, metadata: { undoContextId: string | null; clientId: string | null; mutationId: string | null }) => {
    const row = await runtime.transaction(ownerId, async tx => {
      const deleted = await tx.delete(ownerId, canvasId, relationId)
      if (!deleted) throw new MindCanvasRelationMutationError(404, '画布关联不存在')
      const contextId = metadata.undoContextId?.trim().slice(0, 128)
      if (contextId) { const key = `relation:${relationId}`; await tx.recordUndo({ userId: ownerId, contextId, resource: 'mind', action: 'delete', targetRefs: [{ kind: 'relation', id: relationId }], beforeState: { items: { [key]: snapshot(deleted.before) } }, afterState: { items: { [key]: snapshot(deleted.after) } }, baseVersions: { [key]: {} } }) }
      return deleted.after
    })
    try { await runtime.publishChanged({ ownerId, operation: 'delete', entityId: relationId, origin: metadata.clientId, mutationId: metadata.mutationId, entity: { id: relationId, canvas_id: canvasId } }) } catch (error) { const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined; try { runtime.reportFailure?.('Mind canvas relation delete notification', code) } catch { /* 诊断不影响已提交操作。 */ } }
    return row
  }
}
