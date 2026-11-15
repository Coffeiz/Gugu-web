import { strip } from '../shared/values.js'

export interface MindCanvasResponse { id: number; title: string; projectId: number | null; data: Record<string, unknown>; createdAt: string; updatedAt: string }
export interface MindCanvasCreateRecord { id: number; title: string; project_id: number | null; data_json: string; created_at: Date | string; updated_at: Date | string }
export interface MindCanvasCreateUndo {
  userId: string; contextId: string; resource: 'mind'; action: 'create'; targetRefs: Array<{ kind: string; id: number }>;
  beforeState: { items: Record<string, Record<string, unknown>> }; afterState: { items: Record<string, Record<string, unknown>> }; baseVersions: Record<string, Record<string, never>>
}
export interface MindCanvasCreateTransaction {
  projectExistsForOwner(owner: string, id: number): Promise<boolean>
  insert(owner: string, title: string, projectId: number | null): Promise<MindCanvasCreateRecord>
  recordUndo(record: MindCanvasCreateUndo): Promise<void>
}
export interface MindCanvasCreateRuntime {
  transaction<T>(owner: string, work: (tx: MindCanvasCreateTransaction) => Promise<T>): Promise<T>
  publishChanged(event: { ownerId: string; operation: 'create'; entityId: number; origin: string | null; entity: MindCanvasResponse }): Promise<void>
  reportFailure?(operation: string, error?: unknown): void
}
export class MindCanvasMutationError extends Error {
  constructor(readonly statusCode: 404 | 422, message: string) { super(message); this.name = 'MindCanvasMutationError' }
}
/** 画布和 Undo 同事务提交，事件仅在提交后发布。 */
export function createMindCanvasCreation(runtime: MindCanvasCreateRuntime) {
  return async (ownerId: string, value: unknown, metadata: { undoContextId: string | null; clientId: string | null }): Promise<MindCanvasResponse> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MindCanvasMutationError(422, '请求内容必须是对象')
    const body = value as Record<string, unknown>
    const rawTitle = body.title === undefined ? '未命名画布' : body.title
    if (typeof rawTitle !== 'string') throw new MindCanvasMutationError(422, 'title 必须是字符串')
    const title = strip(rawTitle) || '未命名画布'
    const rawId = body.projectId === undefined ? body.project_id : body.projectId
    const projectId = rawId === undefined || rawId === null ? null : typeof rawId === 'number' ? rawId : typeof rawId === 'string' && /^[+-]?\d+$/.test(rawId.trim()) ? Number(rawId.trim()) : Number.NaN
    if (projectId !== null && !Number.isSafeInteger(projectId)) throw new MindCanvasMutationError(422, 'project_id 必须是整数或空值')
    const row = await runtime.transaction(ownerId, async tx => {
      if (projectId !== null && !await tx.projectExistsForOwner(ownerId, projectId)) throw new MindCanvasMutationError(404, '项目不存在')
      const created = await tx.insert(ownerId, title, projectId)
      const contextId = metadata.undoContextId?.trim().slice(0, 128)
      if (contextId) {
        const key = `canvas:${created.id}`
        await tx.recordUndo({ userId: ownerId, contextId, resource: 'mind', action: 'create', targetRefs: [{ kind: 'canvas', id: Number(created.id) }], beforeState: { items: {} }, afterState: { items: { [key]: { id: Number(created.id), title: created.title, project_id: created.project_id, data_json: created.data_json, deleted_at: null } } }, baseVersions: { [key]: {} } })
      }
      return created
    })
    let data: unknown = row.data_json
    if (typeof data === 'string') { try { data = JSON.parse(data || '{}') } catch { data = {} } }
    const response: MindCanvasResponse = { id: Number(row.id), title: row.title, projectId: row.project_id === null ? null : Number(row.project_id), data: data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}, createdAt: new Date(row.created_at).toISOString().replace(/Z$/, '+00:00'), updatedAt: new Date(row.updated_at).toISOString().replace(/Z$/, '+00:00') }
    try { await runtime.publishChanged({ ownerId, operation: 'create', entityId: row.id, origin: metadata.clientId, entity: response }) } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      try { runtime.reportFailure?.('Mind canvas create notification', code) } catch { /* 诊断不影响已提交操作。 */ }
    }
    return response
  }
}
