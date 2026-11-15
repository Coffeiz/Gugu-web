import type { Pool } from 'pg'

export interface PurgeLease {
  id: number
  userId: string
  snapshotAt: Date
  progressCurrent: number
  progressTotal: number
  failedCount: number
}

/** 只负责持久租约及进度；文件删除和运行生命周期由调用方单独实现。 */
export function createPostgresPurgeLeaseStore(pool: Pool, leaseMs = 60_000, now = () => new Date()) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError('回收站租约期限无效')
  const expiry = (time: Date) => new Date(time.getTime() + leaseMs)
  return {
    async claim(owner: string): Promise<PurgeLease | null> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const time = now()
        const active = await client.query("SELECT id FROM trash_purge_jobs WHERE status='running' AND lease_until>$1 LIMIT 1", [time])
        if (active.rowCount) { await client.query('COMMIT'); return null }
        const expired = await client.query<{ id: number }>("SELECT id FROM trash_purge_jobs WHERE status='running' AND (lease_until<=$1 OR lease_until IS NULL) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1", [time])
        const queued = expired.rows[0] ? undefined : await client.query<{ id: number }>("SELECT id FROM trash_purge_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")
        const id = expired.rows[0]?.id ?? queued?.rows[0]?.id
        if (id === undefined) { await client.query('COMMIT'); return null }
        const result = await client.query<{ id: number; user_id: string; snapshot_at: Date; progress_current: number; progress_total: number; failed_count: number }>(
          `UPDATE trash_purge_jobs SET status='running',lease_owner=$2,lease_until=$3,started_at=COALESCE(started_at,$4)
           WHERE id=$1 RETURNING id,user_id::text,snapshot_at,progress_current,progress_total,failed_count`, [id, owner, expiry(time), time],
        )
        await client.query('COMMIT')
        const row = result.rows[0]!
        return { id: row.id, userId: row.user_id, snapshotAt: row.snapshot_at, progressCurrent: row.progress_current, progressTotal: row.progress_total, failedCount: row.failed_count }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
          && 'constraint' in error && error.constraint === 'uq_trash_purge_jobs_global_running') return null
        throw error
      } finally { client.release() }
    },
    async renew(id: number, owner: string): Promise<boolean> {
      const time = now()
      const result = await pool.query("UPDATE trash_purge_jobs SET lease_until=$3 WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_until>$4", [id, owner, expiry(time), time])
      return result.rowCount === 1
    },
    async advance(id: number, owner: string): Promise<boolean> {
      const time = now()
      const result = await pool.query("UPDATE trash_purge_jobs SET progress_current=progress_current+1,lease_until=$3 WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_until>$4", [id, owner, expiry(time), time])
      return result.rowCount === 1
    },
    async finish(id: number, owner: string, state: 'completed' | 'failed', errorCode: string | null = null): Promise<boolean> {
      const time = now()
      const result = await pool.query(`UPDATE trash_purge_jobs SET status=$3,finished_at=$4,error_code=$5,
        failed_count=failed_count+CASE WHEN $3::varchar='failed' THEN 1 ELSE 0 END,lease_owner=NULL,lease_until=NULL
        WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_until>$4`, [id, owner, state, time, errorCode])
      return result.rowCount === 1
    },
  }
}
