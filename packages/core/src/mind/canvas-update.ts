import { MindCanvasMutationError, type MindCanvasCreateRecord, type MindCanvasResponse } from './canvas-create.js'
import { parseCanvasData } from './canvas-layout.js'

export interface MindCanvasUpdateUndo {
  userId: string; contextId: string; resource: 'mind'; action: 'update'
  targetRefs: Array<{ kind: string; id: number }>
  beforeState: { items: Record<string, Record<string, unknown>> }; afterState: { items: Record<string, Record<string, unknown>> }
  baseVersions: Record<string, Record<string, never>>
}
export interface MindCanvasUpdateTransaction {
  getOwned(owner: string, id: number): Promise<MindCanvasCreateRecord | null>
  update(owner: string, id: number, fields: { title?: string; dataJson?: string }): Promise<MindCanvasCreateRecord | null>
  recordUndo(record: MindCanvasUpdateUndo): Promise<void>
}
export interface MindCanvasUpdateRuntime {
  transaction<T>(owner: string, work: (tx: MindCanvasUpdateTransaction) => Promise<T>): Promise<T>
  publishChanged(event: { ownerId: string; operation: 'update'; entityId: number; origin: string | null; entity: MindCanvasResponse }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}
function snapshot(row: MindCanvasCreateRecord): Record<string, unknown> {
  return { id: Number(row.id), title: row.title, project_id: row.project_id === null ? null : Number(row.project_id), data_json: row.data_json, deleted_at: null }
}
/** 更新画布和 Undo 同事务，提交成功后再发布事件。 */
export function createMindCanvasUpdate(runtime: MindCanvasUpdateRuntime) {
  return async (ownerId: string, canvasId: number, value: unknown, metadata: { undoContextId: string | null; clientId: string | null }): Promise<MindCanvasResponse> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MindCanvasMutationError(422, '请求内容必须是对象')
    const body = value as Record<string, unknown>
    const fields: { title?: string; dataJson?: string } = {}
    if ('title' in body) {
      if (body.title !== null && typeof body.title !== 'string') throw new MindCanvasMutationError(422, 'title 必须是字符串或空值')
      fields.title = typeof body.title === 'string' ? body.title.trim() || '未命名画布' : '未命名画布'
    }
    if ('data' in body) {
      if (body.data !== null && (typeof body.data !== 'object' || Array.isArray(body.data))) throw new MindCanvasMutationError(422, 'data 必须是对象或空值')
      fields.dataJson = JSON.stringify(body.data)
    }
    const row = await runtime.transaction(ownerId, async tx => {
      const before = await tx.getOwned(ownerId, canvasId)
      if (!before) throw new MindCanvasMutationError(404, '画布不存在')
      if (fields.dataJson !== undefined) {
        const current = parseCanvasData(before.data_json)
        const next = parseCanvasData(fields.dataJson)
        // 断线状态由条目移除和显式连线管理。视图快照可能早于这两种操作。
        if (Array.isArray(current.detachedRelationIds)) {
          next.detachedRelationIds = current.detachedRelationIds
          fields.dataJson = JSON.stringify(next)
        } else if ('detachedRelationIds' in next) {
          delete next.detachedRelationIds
          fields.dataJson = JSON.stringify(next)
        }
      }
      const after = await tx.update(ownerId, canvasId, fields)
      if (!after) throw new MindCanvasMutationError(404, '画布不存在')
      const contextId = metadata.undoContextId?.trim().slice(0, 128)
      if (contextId) {
        const key = `canvas:${canvasId}`
        await tx.recordUndo({ userId: ownerId, contextId, resource: 'mind', action: 'update', targetRefs: [{ kind: 'canvas', id: canvasId }], beforeState: { items: { [key]: snapshot(before) } }, afterState: { items: { [key]: snapshot(after) } }, baseVersions: { [key]: {} } })
      }
      return after
    })
    let data: unknown = row.data_json
    if (typeof data === 'string') { try { data = JSON.parse(data || '{}') } catch { data = {} } }
    const response: MindCanvasResponse = { id: Number(row.id), title: row.title, projectId: row.project_id === null ? null : Number(row.project_id), data: data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}, createdAt: new Date(row.created_at).toISOString().replace(/Z$/, '+00:00'), updatedAt: new Date(row.updated_at).toISOString().replace(/Z$/, '+00:00') }
    try { await runtime.publishChanged({ ownerId, operation: 'update', entityId: canvasId, origin: metadata.clientId, entity: response }) } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      try { runtime.reportFailure?.('Mind canvas update notification', code) } catch { /* 诊断不影响已提交操作。 */ }
    }
    return response
  }
}
