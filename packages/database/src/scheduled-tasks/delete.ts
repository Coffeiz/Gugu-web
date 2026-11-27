import { sql, type Transaction } from 'kysely'
import type { ScheduleTaskDeleted } from './ports.js'

/** 删除和调用方的关联状态更新在同一个事务中完成。 */
export async function deleteOwnedScheduledTask<DB>(
  tx: Transaction<DB>, owner: string, id: number, independent: boolean, onDelete: ScheduleTaskDeleted<DB>,
): Promise<boolean> {
  const kind = independent ? sql`AND event_id IS NULL` : sql``
  const result = await sql<{ id: number }>`DELETE FROM scheduled_tasks
    WHERE id=${id} AND user_id=${owner} ${kind} RETURNING id`.execute(tx)
  if (result.rows.length !== 1) return false
  await onDelete(tx, owner, id)
  return true
}
