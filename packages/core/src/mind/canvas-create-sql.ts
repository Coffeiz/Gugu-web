import type { Kysely, Transaction } from 'kysely'
import { dataContext } from '../contracts/index.js'
import { databaseTime, nowUtc, type Clock } from '../data/codec.js'
import type { Backend } from '../data/repositories.js'
import type { Database } from '../data/schema.js'
import { recordForwardUndoOperation } from '../data/undo.js'
import { enqueueMindRagIndex } from './rag-index-job.js'
import type { MindCanvasCreateRuntime } from './canvas-create.js'

/** 使用现有表和 Undo 构建创建事务；调用方负责提交后发布。 */
export function createSqlMindCanvasCreateRuntime(db: Kysely<Database>, backend: Backend, publishChanged: MindCanvasCreateRuntime['publishChanged'], reportFailure?: MindCanvasCreateRuntime['reportFailure'], clock: Clock = nowUtc): MindCanvasCreateRuntime {
  return {
    transaction: (rawOwner, work) => {
      const canonical = dataContext(rawOwner).ownerId
      const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
      const run = async (tx: Transaction<Database>) => work({
        async projectExistsForOwner(_owner, id) {
          return !!await tx.selectFrom('projects').select('id').where('id', '=', id).where('user_id', '=', owner).where('deleted_at', 'is', null).executeTakeFirst()
        },
        async insert(_owner, title, projectId) {
          const now = databaseTime(clock(), backend)
          const row = await tx.insertInto('mind_maps').values({ user_id: owner, title, project_id: projectId, data_json: '{}', created_at: now, updated_at: now, deleted_at: null }).returningAll().executeTakeFirstOrThrow()
          await enqueueMindRagIndex(tx, backend, owner, 'canvas', '', now, 'create')
          const timestamp = new Date(`${now.replace(' ', 'T').replace(/\+00:00$/, '')}Z`)
          return { ...row, id: Number(row.id), created_at: timestamp, updated_at: timestamp }
        },
        async recordUndo(record) { await recordForwardUndoOperation(tx, backend, { ...record, userId: canonical }, clock) },
      })
      return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run)
    }, publishChanged, reportFailure,
  }
}
