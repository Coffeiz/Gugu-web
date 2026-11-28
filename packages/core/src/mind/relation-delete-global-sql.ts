import type { Kysely, Selectable } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindRelationTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import type { GlobalRelationDeleteRuntime } from './relation-delete-global.js'
function relation(row: Selectable<MindRelationTable>) {
  const date = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T'))
  return { ...row, id: Number(row.id), canvas_id: row.canvas_id === null ? null : Number(row.canvas_id), src_node_id: Number(row.src_node_id), dst_node_id: Number(row.dst_node_id), created_at: date(row.created_at), updated_at: date(row.updated_at), deleted_at: row.deleted_at === null ? null : date(row.deleted_at) }
}
export function createSqlMindGlobalRelationDeleteRuntime(db: Kysely<Database>, backend: Backend, publishChanged: GlobalRelationDeleteRuntime['publishChanged'], reportFailure?: GlobalRelationDeleteRuntime['reportFailure'], clock: Clock = nowUtc): GlobalRelationDeleteRuntime {
  return { transaction: (rawOwner, work) => {
    const canonical = dataContext(rawOwner).ownerId
    const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    return db.transaction().execute(async tx => work({
      async deleteGlobal(_owner, id) {
        let query = tx.selectFrom('mind_relations').selectAll().where('id', '=', id).where('user_id', '=', owner).where('canvas_id', 'is', null).where('deleted_at', 'is', null)
        if (backend === 'postgres') query = query.forUpdate()
        const before = await query.executeTakeFirst()
        if (!before) return null
        const now = databaseTime(clock(), backend)
        const after = await tx.updateTable('mind_relations').set({ deleted_at: now, updated_at: now }).where('id', '=', id).where('user_id', '=', owner).where('canvas_id', 'is', null).where('deleted_at', 'is', null).returningAll().executeTakeFirst()
        return after ? { before: relation(before), after: relation(after) } : null
      },
      async recordUndo(record) { await recordForwardUndoOperation(tx, backend, { ...record, userId: canonical }, clock) },
    }))
  }, publishChanged, reportFailure }
}
