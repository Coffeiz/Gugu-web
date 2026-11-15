import { sql, type Kysely } from 'kysely'
import type { ScheduledTaskDeleteRuntime } from './task-delete.js'

/** 单条 DELETE 自身构成事务，返回成功代表提交完成；不干预进行中的任务。 */
export function createKyselyScheduledTaskDeleteRuntime<DB>(
  db: Kysely<DB>, backend: 'sqlite' | 'postgres',
  publish: ScheduledTaskDeleteRuntime['publish'],
): ScheduledTaskDeleteRuntime {
  return {
    async deleteOwned(owner, id) {
      const user = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
      const result = await sql<{ id: number }>`DELETE FROM scheduled_tasks WHERE id=${id} AND user_id=${user} RETURNING id`.execute(db)
      return result.rows.length === 1
    },
    publish,
  }
}
