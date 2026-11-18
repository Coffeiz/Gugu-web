import { sql, type Kysely, type Transaction } from 'kysely'
import type { ScheduledTaskDeleteRuntime } from './task-delete.js'
import { enqueueScheduledTaskRagIndex } from './rag-index-job.js'

/** 删除记录与索引墓碑任务同事务提交；不干预进行中的任务。 */
export function createKyselyScheduledTaskDeleteRuntime<DB>(
  db: Kysely<DB>, backend: 'sqlite' | 'postgres',
  publish: ScheduledTaskDeleteRuntime['publish'],
): ScheduledTaskDeleteRuntime {
  return {
    async deleteOwned(owner, id) {
      const user = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
      return db.transaction().execute(tx => deleteScheduledTaskInTransaction(tx, backend, user, id))
    },
    publish,
  }
}

/** Agent 与 HTTP 复用删除和索引墓碑；Agent 仅可删除独立任务。 */
export async function deleteScheduledTaskInTransaction<DB>(
  tx: Transaction<DB>, backend: 'sqlite' | 'postgres', owner: string, id: number, independent = false,
): Promise<boolean> {
  const kind = independent ? sql`AND event_id IS NULL` : sql``
  const result = await sql<{ id: number }>`DELETE FROM scheduled_tasks
    WHERE id=${id} AND user_id=${owner} ${kind} RETURNING id`.execute(tx)
  if (result.rows.length !== 1) return false
  await enqueueScheduledTaskRagIndex(tx, backend, owner, id)
  return true
}
