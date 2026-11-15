import type { Kysely, Selectable, Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, utc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database, MindCanvasTable } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import type { MindCanvasUpdateRuntime } from './canvas-update.js'

function canvas(row: Selectable<MindCanvasTable>) {
  const date = (value: unknown) => new Date(utc(value instanceof Date ? value.toISOString() : value).replace(' ', 'T'))
  return { ...row, id: Number(row.id), project_id: row.project_id === null ? null : Number(row.project_id), created_at: date(row.created_at), updated_at: date(row.updated_at) }
}
export function createSqlMindCanvasUpdateRuntime(db: Kysely<Database>, backend: Backend, publishChanged: MindCanvasUpdateRuntime['publishChanged'], reportFailure?: MindCanvasUpdateRuntime['reportFailure'], clock: Clock = nowUtc): MindCanvasUpdateRuntime {
  return {
    transaction: (rawOwner, work) => {
      const canonical = dataContext(rawOwner).ownerId
      const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
      const run = async (tx: Transaction<Database>) => work({
        async getOwned(_owner, id) {
          let query = tx.selectFrom('mind_maps').selectAll().where('id', '=', id).where('user_id', '=', owner).where('deleted_at', 'is', null)
          if (backend === 'postgres') query = query.forUpdate()
          const row = await query.executeTakeFirst()
          return row ? canvas(row) : null
        },
        async update(_owner, id, fields) {
          if (fields.title === undefined && fields.dataJson === undefined) {
            const row = await tx.selectFrom('mind_maps').selectAll().where('id', '=', id).where('user_id', '=', owner).where('deleted_at', 'is', null).executeTakeFirst()
            return row ? canvas(row) : null
          }
          const patch = { ...(fields.title !== undefined ? { title: fields.title } : {}), ...(fields.dataJson !== undefined ? { data_json: fields.dataJson } : {}), updated_at: databaseTime(clock(), backend) }
          const row = await tx.updateTable('mind_maps').set(patch).where('id', '=', id).where('user_id', '=', owner).where('deleted_at', 'is', null).returningAll().executeTakeFirst()
          return row ? canvas(row) : null
        },
        async recordUndo(record) { await recordForwardUndoOperation(tx, backend, { ...record, userId: canonical }, clock) },
      })
      return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run)
    }, publishChanged, reportFailure,
  }
}
