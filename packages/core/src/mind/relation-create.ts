import { MindCanvasRelationMutationError, type GlobalRelationRecord } from './relation-delete-global.js'
export interface MindRelationCreateUndo {
  userId: string; contextId: string; resource: 'mind'; action: 'create'; targetRefs: Array<{ kind: 'relation'; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }; afterState: { items: Record<string, Record<string, unknown>> }; baseVersions: Record<string, Record<string, never>>
}
export interface MindRelationCreateRuntime {
  transaction<T>(owner: string, work: (tx: { create(owner: string, canvasId: number, source: number, target: number, parallel: boolean): Promise<{ relation: GlobalRelationRecord; before: GlobalRelationRecord | null; created: boolean }>; recordUndo(record: MindRelationCreateUndo): Promise<void> }) => Promise<T>): Promise<T>
  publishChanged(event: { ownerId: string; operation: 'create'; entityId: number; origin: string | null; mutationId: string | null; entity: MindRelationResponse }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}
export interface MindRelationResponse { id: number; canvasId: number | null; srcNodeId: number; dstNodeId: number; relType: string; origin: string; status: string; createdAt: string; updatedAt: string }
const iso = (value: string | Date) => new Date(value).toISOString().replace(/Z$/, '+00:00')
function snapshot(row: GlobalRelationRecord) { return { id: Number(row.id), canvas_id: row.canvas_id === null ? null : Number(row.canvas_id), src_node_id: Number(row.src_node_id), dst_node_id: Number(row.dst_node_id), rel_type: row.rel_type, edge_key: row.edge_key, origin: row.origin, status: row.status, note: row.note, deleted_at: row.deleted_at ? iso(row.deleted_at) : null } }
function integer(value: unknown, field: string) { const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN; if (!Number.isSafeInteger(parsed)) throw new MindCanvasRelationMutationError(422, `${field} 必须是整数`); return parsed }
/** 关系创建和 Undo 共同提交，事件仅在事务结束后发布。 */
export function createMindCanvasRelationCreate(runtime: MindRelationCreateRuntime) {
  return async (ownerId: string, value: unknown, metadata: { undoContextId: string | null; clientId: string | null; mutationId: string | null }) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MindCanvasRelationMutationError(422, '请求内容必须是对象')
    const body = value as Record<string, unknown>
    const canvasId = integer(body.canvasId ?? body.canvas_id, 'canvas_id'), source = integer(body.srcNodeId ?? body.src_node_id, 'src_node_id'), target = integer(body.dstNodeId ?? body.dst_node_id, 'dst_node_id')
    const parallel = body.allowParallel ?? body.allow_parallel ?? false
    if (typeof parallel !== 'boolean') throw new MindCanvasRelationMutationError(422, 'allow_parallel 必须是布尔值')
    if (source === target) throw new MindCanvasRelationMutationError(422, '节点不能连向自己')
    const result = await runtime.transaction(ownerId, async tx => {
      const result = await tx.create(ownerId, canvasId, source, target, parallel)
      const contextId = metadata.undoContextId?.trim().slice(0, 128)
      if (contextId) { const id = Number(result.relation.id), key = `relation:${id}`; await tx.recordUndo({ userId: ownerId, contextId, resource: 'mind', action: 'create', targetRefs: [{ kind: 'relation', id }], beforeState: { items: result.before ? { [key]: snapshot(result.before) } : {} }, afterState: { items: { [key]: snapshot(result.relation) } }, baseVersions: { [key]: {} } }) }
      return result
    })
    const row = result.relation
    const entity: MindRelationResponse = { id: Number(row.id), canvasId: row.canvas_id === null ? null : Number(row.canvas_id), srcNodeId: Number(row.src_node_id), dstNodeId: Number(row.dst_node_id), relType: row.rel_type, origin: row.origin, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
    try { await runtime.publishChanged({ ownerId, operation: 'create', entityId: entity.id, origin: metadata.clientId, mutationId: metadata.mutationId, entity }) } catch (error) { const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined; try { runtime.reportFailure?.('Mind canvas relation create notification', code) } catch { /* 诊断不影响已提交操作。 */ } }
    return entity
  }
}
