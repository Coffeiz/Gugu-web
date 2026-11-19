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
        const row = result.rows[0]!
        const remainingFiles = await client.query<{ count: number | string }>(
          `SELECT count(file.id)::int AS count FROM files file LEFT JOIN folders parent ON parent.id=file.folder_id
           WHERE file.user_id=$1 AND file.deleted_at IS NOT NULL AND file.deleted_at<=$2
             AND (file.folder_id IS NULL OR parent.deleted_at IS NULL)`, [row.user_id, row.snapshot_at],
        )
        const remainingFolders = await client.query<{ count: number | string }>(
          `SELECT count(folder.id)::int AS count FROM folders folder LEFT JOIN folders parent ON parent.id=folder.parent_id
           WHERE folder.user_id=$1 AND folder.deleted_at IS NOT NULL AND folder.deleted_at<=$2
             AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)`, [row.user_id, row.snapshot_at],
        )
        const remaining = Number(remainingFiles.rows[0]?.count ?? 0) + Number(remainingFolders.rows[0]?.count ?? 0)
        const recoveredProgress = Math.max(row.progress_current, Math.min(row.progress_total, row.progress_total - remaining))
        if (recoveredProgress > row.progress_current) {
          await client.query(
            `UPDATE trash_purge_jobs SET progress_current=$3
             WHERE id=$1 AND status='running' AND lease_owner=$2`,
            [row.id, owner, recoveredProgress],
          )
        }
        await client.query('COMMIT')
        return { id: row.id, userId: row.user_id, snapshotAt: row.snapshot_at, progressCurrent: recoveredProgress, progressTotal: row.progress_total, failedCount: row.failed_count }
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
    async finish(
      id: number, owner: string, state: 'completed' | 'failed', errorCode: string | null = null,
      progressCurrent?: number,
    ): Promise<boolean> {
      const time = now()
      const result = await pool.query(`UPDATE trash_purge_jobs SET status=$3,finished_at=$4,error_code=$5,
        progress_current=CASE WHEN $3::varchar='completed' THEN COALESCE($6,progress_current) ELSE progress_current END,
        failed_count=failed_count+CASE WHEN $3::varchar='failed' THEN 1 ELSE 0 END,lease_owner=NULL,lease_until=NULL
        WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_until>$4`, [id, owner, state, time, errorCode, progressCurrent ?? null])
      return result.rowCount === 1
    },
  }
}
