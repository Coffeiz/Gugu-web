import { sql, type Kysely, type Selectable, type Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindCanvasItemTable, MindNodeTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { MindCanvasItemMutationError } from './canvas-item-remove.js'
import type { CanvasItemAddRuntime } from './canvas-item-add.js'
import { enqueueMindRagIndex } from './rag-index-job.js'
const iso = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')).toISOString().replace(/Z$/, '+00:00')
function parseObject(value: unknown) { if (typeof value === 'string') { try { value = JSON.parse(value || '{}') } catch { value = {} } } return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
export function canvasItemSnapshot(row: Selectable<MindCanvasItemTable>) { return { id: Number(row.id), canvas_id: Number(row.canvas_id), node_id: Number(row.node_id), x: Number(row.x), y: Number(row.y), w: row.w === null ? null : Number(row.w), h: row.h === null ? null : Number(row.h), z: Number(row.z), collapsed: Boolean(row.collapsed), data_json: row.data_json, deleted_at: row.deleted_at === null ? null : iso(row.deleted_at) } }
export async function canvasItemResponse(tx: Transaction<Database>, owner: string, item: Selectable<MindCanvasItemTable>, node: Selectable<MindNodeTable>) {
  const event = node.ref_type === 'event' && node.ref_id !== null ? (await sql<{ date: string; time: string | null; end_time: string | null; description: string | null }>`SELECT date, time, end_time, description FROM calendar_events WHERE id=${node.ref_id} AND user_id=${owner} AND deleted_at IS NULL LIMIT 1`.execute(tx)).rows[0] : undefined
  return { id: Number(item.id), canvasId: Number(item.canvas_id), nodeId: Number(item.node_id), x: Number(item.x), y: Number(item.y), w: item.w === null ? null : Number(item.w), h: item.h === null ? null : Number(item.h), z: Number(item.z), collapsed: Boolean(item.collapsed), data: parseObject(item.data_json), refData: event ? { date: event.date, time: event.time, endTime: event.end_time, description: event.description } : null,
    node: { id: Number(node.id), kind: node.kind, title: node.title, contentMd: node.content_md ?? '', color: node.color, capturedAt: iso(node.captured_at), version: Number(node.version), createdAt: iso(node.created_at), updatedAt: iso(node.updated_at), deletedAt: node.deleted_at === null ? null : iso(node.deleted_at), refType: node.ref_type, refId: node.ref_id === null ? null : Number(node.ref_id), refSnapshot: node.ref_snapshot === null ? null : parseObject(node.ref_snapshot) }, createdAt: iso(item.created_at), updatedAt: iso(item.updated_at) }
}
/** 锁定画布以串行化条目添加和恢复，并将 Undo 纳入同一事务。 */
export function createSqlMindCanvasItemAddRuntime(db: Kysely<Database>, backend: Backend, publishChanged: CanvasItemAddRuntime['publishChanged'], reportFailure?: CanvasItemAddRuntime['reportFailure'], clock: Clock = nowUtc): CanvasItemAddRuntime {
  return { async add(rawOwner, canvasId, input, contextId) {
    const canonical = dataContext(rawOwner).ownerId, owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const run = async (tx: Transaction<Database>) => {
      let canvas = tx.selectFrom('mind_maps').select('id').where('id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null)
      if (backend === 'postgres') canvas = canvas.forUpdate()
      if (!await canvas.executeTakeFirst()) throw new MindCanvasItemMutationError('画布不存在', 404)
      let nodeQuery = tx.selectFrom('mind_nodes').selectAll().where('id', '=', input.nodeId).where('user_id', '=', owner).where('deleted_at', 'is', null)
      if (backend === 'postgres') nodeQuery = nodeQuery.forUpdate()
      const node = await nodeQuery.executeTakeFirst()
      if (!node) throw new MindCanvasItemMutationError('节点不存在', 404)
      let query = tx.selectFrom('mind_canvas_items').selectAll().where('canvas_id', '=', canvasId).where('node_id', '=', input.nodeId).where('user_id', '=', owner)
      if (backend === 'postgres') query = query.forUpdate()
      const existing = await query.executeTakeFirst()
      if (existing && existing.deleted_at === null) return { item: await canvasItemResponse(tx, owner, existing, node), created: false }
      const now = databaseTime(clock(), backend)
      const fields = { x: input.x, y: input.y, w: input.w, h: input.h, z: input.z, collapsed: backend === 'sqlite' ? Number(input.collapsed) : input.collapsed, data_json: input.dataJson || '{}', deleted_at: null, updated_at: now }
      const after = existing ? await tx.updateTable('mind_canvas_items').set(fields).where('id', '=', Number(existing.id)).where('user_id', '=', owner).returningAll().executeTakeFirstOrThrow() : await tx.insertInto('mind_canvas_items').values({ ...fields, user_id: owner, canvas_id: canvasId, node_id: input.nodeId, created_at: now }).returningAll().executeTakeFirstOrThrow()
      await enqueueMindRagIndex(tx, backend, owner, 'canvas', '', now, 'update')
      const context = contextId?.trim().slice(0, 128)
      if (context) { const id = Number(after.id), key = `canvas_item:${id}`; await recordForwardUndoOperation(tx, backend, { userId: canonical, contextId: context, resource: 'mind', action: 'create', targetRefs: [{ kind: 'canvas_item', id }], beforeState: { items: {} }, afterState: { items: { [key]: canvasItemSnapshot(after) } }, baseVersions: { [key]: {} } }, clock) }
      return { item: await canvasItemResponse(tx, owner, after, node), created: true }
    }
    return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run)
  }, publishChanged, reportFailure }
}
