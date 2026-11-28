import type { Kysely, Selectable, Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindRelationTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { MindCanvasRelationMutationError } from './relation-delete-global.js'
import type { CanvasRelationDeleteRuntime } from './relation-delete-canvas.js'
function map(row: Selectable<MindRelationTable>) { const date = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T')); return { ...row, id: Number(row.id), canvas_id: row.canvas_id === null ? null : Number(row.canvas_id), src_node_id: Number(row.src_node_id), dst_node_id: Number(row.dst_node_id), created_at: date(row.created_at), updated_at: date(row.updated_at), deleted_at: row.deleted_at === null ? null : date(row.deleted_at) } }
export function createSqlMindCanvasRelationDeleteRuntime(db: Kysely<Database>, backend: Backend, publishChanged: CanvasRelationDeleteRuntime['publishChanged'], reportFailure?: CanvasRelationDeleteRuntime['reportFailure'], clock: Clock = nowUtc): CanvasRelationDeleteRuntime {
  return { transaction: (rawOwner, work) => {
    const canonical = dataContext(rawOwner).ownerId, owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    const run = async (tx: Transaction<Database>) => work({
      async delete(_owner, canvasId, id) {
        let canvas = tx.selectFrom('mind_maps').select('id').where('id', '=', canvasId).where('user_id', '=', owner).where('deleted_at', 'is', null)
        if (backend === 'postgres') canvas = canvas.forUpdate()
        if (!await canvas.executeTakeFirst()) throw new MindCanvasRelationMutationError(404, '画布不存在')
        let query = tx.selectFrom('mind_relations').selectAll().where('id', '=', id).where('user_id', '=', owner).where('canvas_id', '=', canvasId).where('deleted_at', 'is', null)
        if (backend === 'postgres') query = query.forUpdate()
        const before = await query.executeTakeFirst()
        if (!before) return null
        const now = databaseTime(clock(), backend)
        const after = await tx.updateTable('mind_relations').set({ deleted_at: now, updated_at: now }).where('id', '=', id).where('user_id', '=', owner).where('canvas_id', '=', canvasId).where('deleted_at', 'is', null).returningAll().executeTakeFirst()
        return after ? { before: map(before), after: map(after) } : null
      },
      async recordUndo(record) { await recordForwardUndoOperation(tx, backend, { ...record, userId: canonical }, clock) },
    })
    return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run)
  }, publishChanged, reportFailure }
}
