import type { Kysely, Selectable, Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindCanvasTable, MindNodeTable, MindCanvasItemTable, MindRelationTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import type { MindCanvasDeleteRuntime, MindCanvasDeleteState } from './canvas-delete.js'

const time = (value: unknown) => value === null ? null : new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')).toISOString().replace(/Z$/, '+00:00')
function canvasSnapshot(r: Selectable<MindCanvasTable>) { return { id: Number(r.id), title: r.title, project_id: r.project_id === null ? null : Number(r.project_id), data_json: r.data_json, deleted_at: time(r.deleted_at) } }
function itemSnapshot(r: Selectable<MindCanvasItemTable>) { return { id: Number(r.id), canvas_id: Number(r.canvas_id), node_id: Number(r.node_id), x: Number(r.x), y: Number(r.y), w: r.w === null ? null : Number(r.w), h: r.h === null ? null : Number(r.h), z: Number(r.z), collapsed: Boolean(r.collapsed), data_json: r.data_json, deleted_at: time(r.deleted_at) } }
function relationSnapshot(r: Selectable<MindRelationTable>) { return { id: Number(r.id), canvas_id: r.canvas_id === null ? null : Number(r.canvas_id), src_node_id: Number(r.src_node_id), dst_node_id: Number(r.dst_node_id), rel_type: r.rel_type, edge_key: r.edge_key, origin: r.origin, status: r.status, note: r.note, deleted_at: time(r.deleted_at) } }
function nodeSnapshot(r: Selectable<MindNodeTable>) { return { id: Number(r.id), kind: r.kind, title: r.title, content_md: r.content_md, content_plain: r.content_plain, color: r.color, ref_type: r.ref_type, ref_id: r.ref_id === null ? null : Number(r.ref_id), ref_snapshot: typeof r.ref_snapshot === 'string' ? JSON.parse(r.ref_snapshot) : r.ref_snapshot, origin: r.origin, captured_at: time(r.captured_at), version: Number(r.version), deleted_at: time(r.deleted_at) } }
/** 画布及子项与 Undo 在同一事务中更新。 */
export function createSqlMindCanvasDeleteRuntime(db: Kysely<Database>, backend: Backend, publishChanged: MindCanvasDeleteRuntime['publishChanged'], reportFailure?: MindCanvasDeleteRuntime['reportFailure'], clock: Clock = nowUtc): MindCanvasDeleteRuntime {
  return {
    transaction: (rawOwner, work) => {
      const canonical = dataContext(rawOwner).ownerId
      const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
      const run = async (tx: Transaction<Database>) => work({
        async delete(_owner, id) {
          let query = tx.selectFrom('mind_maps').selectAll().where('id', '=', id).where('user_id', '=', owner).where('deleted_at', 'is', null)
          if (backend === 'postgres') query = query.forUpdate()
          const current = await query.executeTakeFirst()
          if (!current) return null
          let itemQuery = tx.selectFrom('mind_canvas_items').selectAll().where('user_id', '=', owner).where('canvas_id', '=', id)
          let relQuery = tx.selectFrom('mind_relations').selectAll().where('user_id', '=', owner).where('canvas_id', '=', id)
          if (backend === 'postgres') { itemQuery = itemQuery.forUpdate(); relQuery = relQuery.forUpdate() }
          const items = await itemQuery.execute(), relations = await relQuery.execute()
          const ids = [...new Set(items.map(item => Number(item.node_id)))]
          let nodes = ids.length ? tx.selectFrom('mind_nodes').selectAll().where('user_id', '=', owner).where('kind', '=', 'canvas_note').where('id', 'in', ids) : null
          if (nodes && backend === 'postgres') nodes = nodes.forUpdate()
          const notes = nodes ? await nodes.execute() : []
          const result: MindCanvasDeleteState = { targetRefs: [], before: {}, after: {} }
          function add(kind: string, snapshot: Record<string, unknown>) { const id = Number(snapshot.id), key = `${kind}:${id}`; result.targetRefs.push({ kind, id }); result.before[key] = snapshot }
          add('canvas', canvasSnapshot(current))
          for (const item of items) add('canvas_item', itemSnapshot(item))
          for (const relation of relations) add('relation', relationSnapshot(relation))
          for (const note of notes) add('canvas_note', nodeSnapshot(note))
          const now = databaseTime(clock(), backend)
          const changedItems = await tx.updateTable('mind_canvas_items').set({ deleted_at: now, updated_at: now }).where('user_id', '=', owner).where('canvas_id', '=', id).returningAll().execute()
          const changedRelations = await tx.updateTable('mind_relations').set({ deleted_at: now, updated_at: now }).where('user_id', '=', owner).where('canvas_id', '=', id).where('deleted_at', 'is', null).returningAll().execute()
          const changedCanvas = await tx.updateTable('mind_maps').set({ deleted_at: now, updated_at: now }).where('id', '=', id).where('user_id', '=', owner).where('deleted_at', 'is', null).returningAll().executeTakeFirstOrThrow()
          result.after[`canvas:${id}`] = canvasSnapshot(changedCanvas)
          for (const item of changedItems) result.after[`canvas_item:${Number(item.id)}`] = itemSnapshot(item)
          for (const relation of relations) result.after[`relation:${Number(relation.id)}`] = relationSnapshot(relation)
          for (const relation of changedRelations) result.after[`relation:${Number(relation.id)}`] = relationSnapshot(relation)
          for (const note of notes) result.after[`canvas_note:${Number(note.id)}`] = nodeSnapshot(note)
          return result
        },
        async recordUndo(record) { await recordForwardUndoOperation(tx, backend, { ...record, userId: canonical }, clock) },
      })
      return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run)
    }, publishChanged, reportFailure,
  }
}
