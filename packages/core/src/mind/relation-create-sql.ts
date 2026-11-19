import { randomUUID } from 'node:crypto'
import type { Kysely, Selectable, Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindRelationTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { parseCanvasData } from './canvas-layout.js'
import { MindCanvasRelationMutationError } from './relation-delete-global.js'
import type { MindRelationCreateRuntime } from './relation-create.js'
function map(row: Selectable<MindRelationTable>) { const date = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')); return { ...row, id: Number(row.id), canvas_id: row.canvas_id === null ? null : Number(row.canvas_id), src_node_id: Number(row.src_node_id), dst_node_id: Number(row.dst_node_id), created_at: date(row.created_at), updated_at: date(row.updated_at), deleted_at: row.deleted_at === null ? null : date(row.deleted_at) } }
/** 锁定画布以串行化同一画布上的默认边创建。 */
export function createSqlMindCanvasRelationCreateRuntime(db: Kysely<Database>, backend: Backend, publishChanged: MindRelationCreateRuntime['publishChanged'], reportFailure?: MindRelationCreateRuntime['reportFailure'], clock: Clock = nowUtc): MindRelationCreateRuntime {
  return { transaction: (rawOwner, work) => {
    const canonical = dataContext(rawOwner).ownerId, owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const run = async (tx: Transaction<Database>) => work({
      async create(_owner, canvasId, sourceId, targetId, parallel) {
        let canvasQuery = tx.selectFrom('mind_maps').select('data_json').where('id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null)
        if (backend === 'postgres') canvasQuery = canvasQuery.forUpdate()
        const canvas = await canvasQuery.executeTakeFirst()
        if (!canvas) throw new MindCanvasRelationMutationError(404, '画布不存在')
        const ids = [sourceId, targetId]
        const placements = await tx.selectFrom('mind_canvas_items').select('node_id').where('user_id', '=', owner).where('canvas_id', '=', canvasId).where('node_id', 'in', ids).where('deleted_at', 'is', null).execute()
        if (new Set(placements.map(row => Number(row.node_id))).size !== 2) throw new MindCanvasRelationMutationError(422, '两个节点都必须已经放在同一张画布上')
        const nodes = await tx.selectFrom('mind_nodes').select('id').where('user_id', '=', owner).where('id', 'in', ids).where('deleted_at', 'is', null).execute()
        if (nodes.length !== 2) throw new MindCanvasRelationMutationError(404, '节点不存在')
        const source = Math.min(sourceId, targetId), target = Math.max(sourceId, targetId), now = databaseTime(clock(), backend)
        let before: ReturnType<typeof map> | null = null
        if (!parallel) {
          let query = tx.selectFrom('mind_relations').selectAll().where('user_id', '=', owner).where('canvas_id', '=', canvasId).where('src_node_id', '=', source).where('dst_node_id', '=', target).where('rel_type', '=', 'related').where('edge_key', '=', '')
          if (backend === 'postgres') query = query.forUpdate()
          const existing = await query.executeTakeFirst()
          if (existing) {
            before = map(existing)
            const data = parseCanvasData(canvas.data_json)
            const detached = data.detachedRelationIds
            const relationId = before.id
            if (Array.isArray(detached) && detached.includes(relationId)) {
              data.detachedRelationIds = detached.filter(id => id !== relationId)
              await tx.updateTable('mind_maps').set({ data_json: JSON.stringify(data), updated_at: now })
                .where('id', '=', canvasId).where('user_id', '=', owner).execute()
            }
            if (existing.deleted_at === null) return { relation: before, before, created: false }
            const restored = await tx.updateTable('mind_relations').set({ deleted_at: null, updated_at: now }).where('id', '=', Number(existing.id)).where('user_id', '=', owner).returningAll().executeTakeFirstOrThrow()
            return { relation: map(restored), before, created: true }
          }
        }
        const row = await tx.insertInto('mind_relations').values({ user_id: owner, canvas_id: canvasId, src_node_id: source, dst_node_id: target, rel_type: 'related', edge_key: parallel ? randomUUID().replaceAll('-', '') : '', origin: 'user', status: 'confirmed', note: null, created_at: now, updated_at: now, deleted_at: null }).returningAll().executeTakeFirstOrThrow()
        return { relation: map(row), before, created: true }
      },
      async recordUndo(record) { await recordForwardUndoOperation(tx, backend, { ...record, userId: canonical }, clock) },
    })
    return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run)
  }, publishChanged, reportFailure }
}
