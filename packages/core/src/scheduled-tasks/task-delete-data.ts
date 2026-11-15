import { sql, type Kysely } from 'kysely'
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
      return db.transaction().execute(async tx => {
        const result = await sql<{ id: number }>`DELETE FROM scheduled_tasks WHERE id=${id} AND user_id=${user} RETURNING id`.execute(tx)
        if (result.rows.length !== 1) return false
        await enqueueScheduledTaskRagIndex(tx, backend, user, id)
        return true
      })
    },
    publish,
  }
}
