export interface GlobalRelationRecord {
  id: number; canvas_id: number | null; src_node_id: number; dst_node_id: number; rel_type: string; edge_key: string
  origin: string; status: string; note: string | null; created_at: Date | string; updated_at: Date | string; deleted_at: Date | string | null
}
export interface GlobalRelationUndo {
  userId: string; contextId: string; resource: 'mind'; action: 'delete'; targetRefs: Array<{ kind: 'relation'; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }; afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, Record<string, never>>
}
export interface GlobalRelationDeleteRuntime {
  transaction<T>(owner: string, work: (tx: { deleteGlobal(owner: string, id: number): Promise<{ before: GlobalRelationRecord; after: GlobalRelationRecord } | null>; recordUndo(record: GlobalRelationUndo): Promise<void> }) => Promise<T>): Promise<T>
  publishChanged(event: { ownerId: string; operation: 'delete'; entityId: number; origin: string | null; mutationId: string | null; entity: { id: number; canvas_id: null } }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}
export class MindCanvasRelationMutationError extends Error {
  constructor(readonly statusCode: 404 | 422, message: string) { super(message); this.name = 'MindCanvasRelationMutationError' }
}
function snapshot(row: GlobalRelationRecord) {
  return { id: Number(row.id), canvas_id: row.canvas_id === null ? null : Number(row.canvas_id), src_node_id: Number(row.src_node_id), dst_node_id: Number(row.dst_node_id), rel_type: row.rel_type, edge_key: row.edge_key, origin: row.origin, status: row.status, note: row.note, deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString().replace(/Z$/, '+00:00') : null }
}
/** 全局关系删除和 Undo 原子提交，通知在提交之后执行。 */
export function createMindGlobalRelationDelete(runtime: GlobalRelationDeleteRuntime) {
  return async (ownerId: string, relationId: number, metadata: { undoContextId: string | null; clientId: string | null; mutationId: string | null }) => {
    const row = await runtime.transaction(ownerId, async tx => {
      const deleted = await tx.deleteGlobal(ownerId, relationId)
      if (!deleted) throw new MindCanvasRelationMutationError(404, '关联不存在')
      const contextId = metadata.undoContextId?.trim().slice(0, 128)
      if (contextId) {
        const key = `relation:${relationId}`
        await tx.recordUndo({ userId: ownerId, contextId, resource: 'mind', action: 'delete', targetRefs: [{ kind: 'relation', id: relationId }], beforeState: { items: { [key]: snapshot(deleted.before) } }, afterState: { items: { [key]: snapshot(deleted.after) } }, baseVersions: { [key]: {} } })
      }
      return deleted.after
    })
    try { await runtime.publishChanged({ ownerId, operation: 'delete', entityId: relationId, origin: metadata.clientId, mutationId: metadata.mutationId, entity: { id: relationId, canvas_id: null } }) } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      try { runtime.reportFailure?.('Mind relation delete notification', code) } catch { /* 诊断失败不影响已提交操作。 */ }
    }
    return row
  }
}
