import type { Kysely, Transaction } from 'kysely'
import { deleteOwnedScheduledTask } from '@gugu/database/scheduled-tasks'
import type { ScheduledTaskDeleteRuntime } from '@gugu/scheduler/tasks'
import { CoreError, dataContext } from '../contracts/index.js'
import { enqueueScheduledTaskRagIndex } from '../agent/rag/scheduled-task-index-job.js'

/** 删除记录与索引墓碑任务同事务提交；不干预进行中的任务。 */
export function createKyselyScheduledTaskDeleteRuntime<DB>(
  db: Kysely<DB>, backend: 'sqlite' | 'postgres',
  publish: ScheduledTaskDeleteRuntime['publish'],
): ScheduledTaskDeleteRuntime {
  return {
    resolveOwner(rawOwner, id) {
      const owner = dataContext(rawOwner).ownerId
      if (!Number.isSafeInteger(id)) throw new CoreError('invalid_request', '任务标识无效')
      return owner
    },
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
  return deleteOwnedScheduledTask(tx, owner, id, independent,
    (tx, user, taskId) => enqueueScheduledTaskRagIndex(tx, backend, user, taskId))
}
