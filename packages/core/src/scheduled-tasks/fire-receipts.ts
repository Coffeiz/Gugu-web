import { sql, type Kysely } from 'kysely'
import { databaseTime, nowUtc, type Clock } from '../data/codec.js'

export interface ScheduledFire { taskId: string; fireAt: number }
export type ScheduledFireState = 'claimed' | 'completed' | 'unknown'

/** 只允许首次认领；未知或已完成的执行结果不自动重放。 */
export function createKyselyScheduledFireReceipts<DB>(db: Kysely<DB>, backend: 'sqlite' | 'postgres', clock: Clock = nowUtc) {
  const fireTime = (fire: ScheduledFire) => databaseTime(new Date(fire.fireAt).toISOString(), backend)
  const currentTime = () => backend === 'sqlite' ? sql`${databaseTime(clock(), backend)}` : sql`CURRENT_TIMESTAMP`
  return {
    async claim(fire: ScheduledFire, owner: string): Promise<boolean> {
      const timestamp = currentTime()
      const result = await sql`INSERT INTO scheduled_task_fires(task_id,fire_at,lease_owner,status,created_at,updated_at)
        VALUES(${fire.taskId},${fireTime(fire)},${owner},'claimed',${timestamp},${timestamp})
        ON CONFLICT(task_id,fire_at) DO NOTHING`.execute(db)
      return Number(result.numAffectedRows) === 1
    },
    async finish(fire: ScheduledFire, owner: string, state: 'completed' | 'unknown'): Promise<void> {
      const result = await sql`UPDATE scheduled_task_fires SET status=${state},updated_at=${currentTime()}
        WHERE task_id=${fire.taskId} AND fire_at=${fireTime(fire)} AND lease_owner=${owner} AND status='claimed'`.execute(db)
      if (Number(result.numAffectedRows) !== 1) throw new Error('定时任务触发收据已失效')
    },
    async get(fire: ScheduledFire): Promise<{ owner: string; state: ScheduledFireState } | null> {
      const result = await sql<{ lease_owner: string; status: ScheduledFireState }>`SELECT lease_owner,status FROM scheduled_task_fires WHERE task_id=${fire.taskId} AND fire_at=${fireTime(fire)}`.execute(db)
      const row = result.rows[0]
      return row ? { owner: row.lease_owner, state: row.status } : null
    },
  }
}
