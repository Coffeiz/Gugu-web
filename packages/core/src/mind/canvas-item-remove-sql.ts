import type { Kysely, Selectable, Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindCanvasItemTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { MindCanvasItemMutationError, type MindCanvasItemRemoveRuntime } from './canvas-item-remove.js'
import { enqueueMindRagIndex } from './rag-index-job.js'

function snapshot(row: Selectable<MindCanvasItemTable>) {
  const rawDeleted: unknown = row.deleted_at
  const deleted = rawDeleted instanceof Date ? rawDeleted.toISOString() : rawDeleted
  return { id: Number(row.id), canvas_id: Number(row.canvas_id), node_id: Number(row.node_id), x: Number(row.x), y: Number(row.y), w: row.w === null ? null : Number(row.w), h: row.h === null ? null : Number(row.h), z: Number(row.z), collapsed: Boolean(row.collapsed), data_json: row.data_json, deleted_at: deleted === null ? null : new Date(utc(deleted).replace(' ', 'T')).toISOString().replace(/Z$/, '+00:00') }
}
function parseData(raw: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(raw || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} } catch { return {} }
}
/** 移除条目、记录脱离关系和 Undo 在同一事务中。 */
/** includeDeletedNodes仅由可信适配显式开启；默认Web行为继续过滤节点墓碑。 */
export function createSqlMindCanvasItemRemoveRuntime(db: Kysely<Database>, backend: Backend, publishChanged: MindCanvasItemRemoveRuntime['publishChanged'], reportFailure?: MindCanvasItemRemoveRuntime['reportFailure'], clock: Clock = nowUtc, options: { includeDeletedNodes?: boolean } = {}): MindCanvasItemRemoveRuntime {
  return { async remove(rawOwner, canvasId, itemId, contextId) {
    const canonical = dataContext(rawOwner).ownerId
    const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const run = async (tx: Transaction<Database>) => {
      let canvasQuery = tx.selectFrom('mind_maps').selectAll().where('id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null)
      if (backend === 'postgres') canvasQuery = canvasQuery.forUpdate()
      const canvas = await canvasQuery.executeTakeFirst()
      if (!canvas) throw new MindCanvasItemMutationError('画布不存在', 404)
      let itemQuery = tx.selectFrom('mind_canvas_items').selectAll().where('id', '=', itemId).where('canvas_id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null)
      if (backend === 'postgres') itemQuery = itemQuery.forUpdate()
      const before = await itemQuery.executeTakeFirst()
      if (!before) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      let nodeQuery = tx.selectFrom('mind_nodes').select('id').where('id', '=', Number(before.node_id)).where('user_id', '=', owner)
      if (!options.includeDeletedNodes) nodeQuery = nodeQuery.where('deleted_at', 'is', null)
      if (backend === 'postgres') nodeQuery = nodeQuery.forUpdate()
      if (!await nodeQuery.executeTakeFirst()) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      const relations = await tx.selectFrom('mind_relations').select('id').where('user_id', '=', owner).where('canvas_id', '=', canvasId).where(eb => eb.or([eb('src_node_id', '=', Number(before.node_id)), eb('dst_node_id', '=', Number(before.node_id))])).execute()
      const now = databaseTime(clock(), backend)
      if (relations.length) {
        const data = parseData(canvas.data_json)
        const detached = new Set<number>()
        if (Array.isArray(data.detachedRelationIds)) for (const id of data.detachedRelationIds) if (Number.isSafeInteger(id)) detached.add(id as number)
        for (const relation of relations) detached.add(Number(relation.id))
        data.detachedRelationIds = [...detached].sort((a, b) => a - b)
        await tx.updateTable('mind_maps').set({ data_json: JSON.stringify(data), updated_at: now }).where('id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null).execute()
      }
      const after = await tx.updateTable('mind_canvas_items').set({ deleted_at: now, updated_at: now }).where('id', '=', itemId).where('canvas_id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null).returningAll().executeTakeFirst()
      if (!after) throw new MindCanvasItemMutationError('画布贴纸不存在', 404)
      await enqueueMindRagIndex(tx, backend, owner, 'canvas', '', now, 'update')
      const context = contextId?.trim().slice(0, 128)
      if (context) {
        const key = `canvas_item:${itemId}`
        await recordForwardUndoOperation(tx, backend, { userId: canonical, contextId: context, resource: 'mind', action: 'delete', targetRefs: [{ kind: 'canvas_item', id: itemId }], beforeState: { items: { [key]: snapshot(before) } }, afterState: { items: { [key]: snapshot(after) } }, baseVersions: { [key]: {} } }, clock)
      }
    }
    await (db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run))
  }, publishChanged, reportFailure }
}
