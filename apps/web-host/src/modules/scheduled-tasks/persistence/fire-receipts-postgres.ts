import type { Pool } from 'pg'
import type { ScheduledFire, ScheduledFireReceipts } from '../repeating-dispatch.js'

/** 不自动接管已领取记录，未知结果由显式恢复流程处理。 */
export function createPostgresScheduledFireReceipts(pool: Pick<Pool, 'query'>): ScheduledFireReceipts {
  return {
    async claim(fire: ScheduledFire, owner: string) {
      const result = await pool.query(`INSERT INTO scheduled_task_fires(task_id,fire_at,lease_owner,status)
        VALUES($1,$2,$3,'claimed') ON CONFLICT (task_id,fire_at) DO NOTHING`,
      [fire.taskId, new Date(fire.fireAt), owner])
      return result.rowCount === 1
    },
    async finish(fire: ScheduledFire, owner: string, state: 'completed' | 'unknown') {
      const result = await pool.query(`UPDATE scheduled_task_fires SET status=$4,updated_at=CURRENT_TIMESTAMP
        WHERE task_id=$1 AND fire_at=$2 AND lease_owner=$3 AND status='claimed'`,
      [fire.taskId, new Date(fire.fireAt), owner, state])
      if (result.rowCount !== 1) throw new Error('定时任务触发收据已失效')
    },
  }
}
