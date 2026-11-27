import { sql, type Kysely } from 'kysely'

/** 独立原型：调用方必须提供共享文件库和经协调创建的租约表。 */
export function createSqliteTaskLease<DB>(db: Kysely<DB>, clock: () => number = Date.now) {
  function argumentsFor(taskId: string, owner: string, ttl?: number) {
    if (!taskId || !owner || (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 1)))
      throw new RangeError('任务租约参数无效')
    const now = clock()
    if (!Number.isSafeInteger(now) || (ttl !== undefined && !Number.isSafeInteger(now + ttl)))
      throw new RangeError('任务租约时间无效')
    return now
  }
  return {
    async acquire(taskId: string, owner: string, ttl: number): Promise<boolean> {
      const now = argumentsFor(taskId, owner, ttl)
      const result = await sql`INSERT INTO scheduled_task_leases(task_id,lease_owner,expires_at_ms) VALUES(${taskId},${owner},${now + ttl})
        ON CONFLICT(task_id) DO UPDATE SET lease_owner=excluded.lease_owner,expires_at_ms=excluded.expires_at_ms
        WHERE scheduled_task_leases.expires_at_ms<=${now} RETURNING task_id`.execute(db)
      return result.rows.length === 1
    },
    async renew(taskId: string, owner: string, ttl: number): Promise<boolean> {
      const now = argumentsFor(taskId, owner, ttl)
      const result = await sql`UPDATE scheduled_task_leases SET expires_at_ms=${now + ttl}
        WHERE task_id=${taskId} AND lease_owner=${owner} AND expires_at_ms>${now} RETURNING task_id`.execute(db)
      return result.rows.length === 1
    },
    async release(taskId: string, owner: string): Promise<void> {
      argumentsFor(taskId, owner)
      await sql`DELETE FROM scheduled_task_leases WHERE task_id=${taskId} AND lease_owner=${owner}`.execute(db)
    },
    async isHeld(taskId: string): Promise<boolean> {
      const now = argumentsFor(taskId, 'check')
      const result = await sql`SELECT task_id FROM scheduled_task_leases WHERE task_id=${taskId} AND expires_at_ms>${now}`.execute(db)
      return result.rows.length === 1
    },
  }
}
