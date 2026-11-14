import { CoreError } from '@gugu/core'
import type { Pool, QueryResultRow } from 'pg'
import { normalizeFileOwnerId } from '../file-owner.js'
import { TrashCooldownError, type TrashOperations } from '../trash.js'

interface TrashPurgeJobRow extends QueryResultRow {
  id: number | string
  user_id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress_current: number | string
  progress_total: number | string
  failed_count: number | string
  error_code: string | null
  finished_at: Date | string | null
}

function response(row: TrashPurgeJobRow) {
  return {
    id: Number(row.id), status: row.status, progressCurrent: Number(row.progress_current),
    progressTotal: Number(row.progress_total), failedCount: Number(row.failed_count), errorCode: row.error_code,
  }
}

function isWithinCooldown(value: Date | string | null): boolean {
  if (value === null) return false
  const finishedAt = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(finishedAt) && Date.now() - finishedAt < 30_000
}

export function createPostgresTrashPurgeOperations(
  pool: Pool,
  options: { notifyWorker(): Promise<void> },
): Pick<TrashOperations, 'startEmpty' | 'activeEmpty' | 'getEmpty'> {
  return {
    async startEmpty(rawOwner) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      const client = await pool.connect()
      let committed = false
      let job: TrashPurgeJobRow | undefined
      try {
        await client.query('BEGIN')
        const user = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerId])
        if (!user.rowCount) throw new CoreError('not_found', '用户不存在')

        const active = await client.query<TrashPurgeJobRow>(
          `SELECT id,user_id,status,progress_current,progress_total,failed_count,error_code,finished_at
           FROM trash_purge_jobs WHERE user_id=$1 AND status IN ('queued','running')
           ORDER BY created_at DESC LIMIT 1`, [ownerId],
        )
        if (active.rows[0]) {
          job = active.rows[0]
          await client.query('COMMIT')
          committed = true
          return response(job)
        }

        const latest = await client.query<TrashPurgeJobRow>(
          `SELECT id,user_id,status,progress_current,progress_total,failed_count,error_code,finished_at
           FROM trash_purge_jobs WHERE user_id=$1 AND status IN ('completed','failed')
           ORDER BY created_at DESC LIMIT 1`, [ownerId],
        )
        const previous = latest.rows[0]
        if (previous?.status === 'completed' && Number(previous.progress_total) > 0
          && isWithinCooldown(previous.finished_at)) throw new TrashCooldownError()

        const fileCount = await client.query<{ count: number | string }>(
          `SELECT count(file.id)::int AS count FROM files file
           LEFT JOIN folders parent ON parent.id=file.folder_id
           WHERE file.user_id=$1 AND file.deleted_at IS NOT NULL
             AND (file.folder_id IS NULL OR parent.deleted_at IS NULL)`, [ownerId],
        )
        const folderCount = await client.query<{ count: number | string }>(
          `SELECT count(folder.id)::int AS count FROM folders folder
           LEFT JOIN folders parent ON parent.id=folder.parent_id
           WHERE folder.user_id=$1 AND folder.deleted_at IS NOT NULL
             AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)`, [ownerId],
        )
        const total = Number(fileCount.rows[0]?.count ?? 0) + Number(folderCount.rows[0]?.count ?? 0)
        const status = total === 0 ? 'completed' : 'queued'
        const inserted = await client.query<TrashPurgeJobRow>(
          `INSERT INTO trash_purge_jobs
             (user_id,status,snapshot_at,progress_current,progress_total,failed_count,error_code,
              lease_owner,lease_until,created_at,started_at,finished_at)
           VALUES ($1,$2,CURRENT_TIMESTAMP,0,$3,0,NULL,NULL,NULL,CURRENT_TIMESTAMP,NULL,
                   CASE WHEN $2='completed' THEN CURRENT_TIMESTAMP ELSE NULL END)
           RETURNING id,user_id,status,progress_current,progress_total,failed_count,error_code,finished_at`,
          [ownerId, status, total],
        )
        job = inserted.rows[0]
        if (!job) throw new CoreError('busy', '回收站任务未能创建，请稍后重试')
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        if (!committed) await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
      if (job.status === 'queued') await options.notifyWorker().catch(() => undefined)
      return response(job)
    },

    async activeEmpty(rawOwner) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      const result = await pool.query<TrashPurgeJobRow>(
        `SELECT id,user_id,status,progress_current,progress_total,failed_count,error_code,finished_at
         FROM trash_purge_jobs WHERE user_id=$1 AND status IN ('queued','running')
         ORDER BY created_at DESC LIMIT 1`, [ownerId],
      )
      return result.rows[0] ? response(result.rows[0]) : null
    },

    async getEmpty(rawOwner, jobId) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      if (!Number.isSafeInteger(jobId) || jobId < 1) throw new CoreError('invalid_request', '任务 ID 无效')
      const result = await pool.query<TrashPurgeJobRow>(
        `SELECT id,user_id,status,progress_current,progress_total,failed_count,error_code,finished_at
         FROM trash_purge_jobs WHERE id=$1 AND user_id=$2 LIMIT 1`, [jobId, ownerId],
      )
      return result.rows[0] ? response(result.rows[0]) : null
    },
  }
}
