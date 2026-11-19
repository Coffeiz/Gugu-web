import { randomUUID, createHash } from 'node:crypto'
import { runTrashPurgeJob, type TrashPurgeEntry, type TrashPurgeJobLease } from '@gugu/core/files/trash-purge-worker'
import { CoreError } from '@gugu/core/contracts'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type { LiveSubscriptionFactory } from '../../../adapters/cache/redis-live-subscription.js'
import type { RedisEventPublisher } from '../../../adapters/cache/redis-events.js'
import { normalizeFileOwnerId } from '../store.js'
import { TrashCooldownError, type AgentTrashPurgeOperations, type TrashOperations } from './service.js'

const channel = 'jobs:trash-purge:wakeup'

const batchSize = 10

const recoveryScanMs = 30_000

interface PurgeDeleteOperations {
  hardDeleteFile(ownerId: string, fileId: number, origin: string | null): Promise<void>
  hardDeleteFolder(ownerId: string, folderId: number, origin: string | null): Promise<void>
}

export interface TrashPurgeWorkerOptions {
  pool: Pool
  deletes: PurgeDeleteOperations
  publisher: RedisEventPublisher
  subscribe?: LiveSubscriptionFactory
  onError(error?: unknown): void
}

/** PostgreSQL 租约、owner Local 删除、Redis 唤醒与恢复扫描组成回收站清空消费者。 */
export function startTrashPurgeWorker(options: TrashPurgeWorkerOptions) {
  const workerId = `node-${randomUUID()}`
  const leases = createPostgresPurgeLeaseStore(options.pool)
  const abort = new AbortController()
  let stopped = false
  let wakeSubscription: Awaited<ReturnType<LiveSubscriptionFactory>> | null = null
  let wakeListener: Promise<void> | null = null
  let resolveWake: () => void = () => undefined
  let wakePromise = new Promise<void>(resolve => { resolveWake = resolve })
  const wake = () => {
    resolveWake()
    wakePromise = new Promise<void>(resolve => { resolveWake = resolve })
  }

  async function nextBatch(job: TrashPurgeJobLease): Promise<TrashPurgeEntry[]> {
    const files = await options.pool.query<{ id: number | string }>(
      `SELECT file.id FROM files file LEFT JOIN folders parent ON parent.id=file.folder_id
       WHERE file.user_id=$1 AND file.deleted_at IS NOT NULL AND file.deleted_at<=$2
         AND (file.folder_id IS NULL OR parent.deleted_at IS NULL)
       ORDER BY file.deleted_at DESC LIMIT $3`, [job.userId, job.snapshotAt, batchSize],
    )
    if (files.rows.length) return files.rows.map(row => ({ kind: 'file', id: Number(row.id) }))
    const folders = await options.pool.query<{ id: number | string }>(
      `SELECT folder.id FROM folders folder LEFT JOIN folders parent ON parent.id=folder.parent_id
       WHERE folder.user_id=$1 AND folder.deleted_at IS NOT NULL AND folder.deleted_at<=$2
         AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)
       ORDER BY folder.deleted_at DESC LIMIT $3`, [job.userId, job.snapshotAt, batchSize],
    )
    return folders.rows.map(row => ({ kind: 'folder', id: Number(row.id) }))
  }

  async function consume(job: PurgeLease | null) {
    if (!job) return
    await runTrashPurgeJob(job, workerId, {
      renew: (id, owner) => leases.renew(id, owner),
      nextBatch,
      async deleteEntry(current, entry) {
        try {
          if (entry.kind === 'file') await options.deletes.hardDeleteFile(current.userId, entry.id, null)
          else await options.deletes.hardDeleteFolder(current.userId, entry.id, null)
        } catch (error) {
          if (error instanceof CoreError && error.code === 'not_found') return
          throw error
        }
      },
      advance: (id, owner) => leases.advance(id, owner),
      finish: (id, owner, status, errorCode, progress) => leases.finish(id, owner, status, errorCode, progress),
      async publishProgress(current) {
        await options.publisher.publishTrashPurgeProgress({
          ownerId: current.userId, jobId: current.id, status: current.status ?? 'running',
          progressCurrent: current.progressCurrent, progressTotal: current.progressTotal,
          failedCount: current.failedCount,
        })
      },
      async publishFilesChanged(ownerId) {
        await options.publisher.publishResourceChanged({
          ownerId, resource: 'files', operation: 'refresh',
        })
      },
    }, { onError: error => options.onError(error) })
  }

  async function listenForWakeups(): Promise<void> {
    if (!options.subscribe || wakeSubscription || stopped) return
    try {
      const subscription = await options.subscribe([channel])
      if (stopped) { await subscription.close(); return }
      wakeSubscription = subscription
      wakeListener = (async () => {
        try {
          while (!stopped) {
            const message = await subscription.next(abort.signal)
            if (message === null) break
            wake()
          }
        } catch {
          if (!stopped) options.onError()
        } finally {
          await subscription.close().catch(() => undefined)
          if (wakeSubscription === subscription) wakeSubscription = null
          wake()
        }
      })()
    } catch {
      if (!stopped) options.onError()
    }
  }

  async function waitForWakeOrRecoveryScan(): Promise<void> {
    const pendingWake = wakePromise
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([pendingWake, new Promise<void>(resolve => { timer = setTimeout(resolve, recoveryScanMs) })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }

  const loop = (async () => {
    while (!stopped) {
      await listenForWakeups()
      if (stopped) break
      try {
        const job = await leases.claim(workerId)
        if (job) { await consume(job); continue }
      } catch (error) { options.onError(error) }
      if (!stopped) await waitForWakeOrRecoveryScan()
    }
  })()

  return {
    async stop() {
      stopped = true
      abort.abort()
      wake()
      await wakeListener?.catch(() => undefined)
      await wakeSubscription?.close().catch(() => undefined)
      await loop
    },
  }
}

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
): Pick<TrashOperations, 'startEmpty' | 'activeEmpty' | 'getEmpty'> & AgentTrashPurgeOperations {
  async function readAgentSnapshot(client: PoolClient, ownerId: string) {
    const files = await client.query<{ count: number | string; digest: string }>(
      `SELECT count(*)::int AS count, md5(COALESCE(string_agg(id::text || ':' || COALESCE(deleted_at::text,''), ',' ORDER BY id),'')) AS digest
       FROM (SELECT file.id,file.deleted_at FROM files file LEFT JOIN folders parent ON parent.id=file.folder_id
         WHERE file.user_id=$1 AND file.deleted_at IS NOT NULL AND (file.folder_id IS NULL OR parent.deleted_at IS NULL)) targets`, [ownerId])
    const folders = await client.query<{ count: number | string; digest: string }>(
      `SELECT count(*)::int AS count, md5(COALESCE(string_agg(id::text || ':' || COALESCE(deleted_at::text,''), ',' ORDER BY id),'')) AS digest
       FROM (SELECT folder.id,folder.deleted_at FROM folders folder LEFT JOIN folders parent ON parent.id=folder.parent_id
         WHERE folder.user_id=$1 AND folder.deleted_at IS NOT NULL AND (folder.parent_id IS NULL OR parent.deleted_at IS NULL)) targets`, [ownerId])
    const file = files.rows[0], folder = folders.rows[0]
    if (!file || !folder) throw new CoreError('busy', '回收站快照不可用')
    return { file_count: Number(file.count), folder_count: Number(folder.count),
      digest: createHash('sha256').update(`${file.digest}:${folder.digest}`).digest('hex') }
  }
  const sameSnapshot = (left: { file_count: number; folder_count: number; digest: string },
    right: { file_count: number; folder_count: number; digest: string }) => left.file_count === right.file_count
      && left.folder_count === right.folder_count && left.digest === right.digest
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
                   CASE WHEN $2::varchar='completed' THEN CURRENT_TIMESTAMP ELSE NULL END)
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

    async startEmptyForAgent(rawOwner, operationId, snapshot) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId))
        throw new CoreError('invalid_request', '回收站操作标识无效')
      if (!Number.isSafeInteger(snapshot.file_count) || snapshot.file_count < 0
        || !Number.isSafeInteger(snapshot.folder_count) || snapshot.folder_count < 0
        || !/^[0-9a-f]{64}$/iu.test(snapshot.digest)) throw new CoreError('invalid_request', '回收站快照无效')
      const client = await pool.connect()
      let committed = false
      let job: TrashPurgeJobRow | undefined
      let shouldNotify = false
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        const user = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerId])
        if (!user.rowCount) throw new CoreError('not_found', '用户不存在')

        const previous = await client.query<TrashPurgeJobRow>(
          `SELECT j.id,j.user_id,j.status,j.progress_current,j.progress_total,j.failed_count,j.error_code,j.finished_at
             FROM trash_purge_agent_operations a JOIN trash_purge_jobs j ON j.id=a.job_id
            WHERE a.user_id=$1 AND a.operation_id=$2 FOR UPDATE OF a,j`, [ownerId, operationId],
        )
        if (previous.rows[0]) {
          job = previous.rows[0]
          await client.query('COMMIT')
          committed = true
          return response(job)
        }

        const current = await readAgentSnapshot(client, ownerId)
        if (!sameSnapshot(current, snapshot)) throw new CoreError('conflict', '回收站内容已变化，请重新确认')
        const active = await client.query<TrashPurgeJobRow>(
          `SELECT id,user_id,status,progress_current,progress_total,failed_count,error_code,finished_at
           FROM trash_purge_jobs WHERE user_id=$1 AND status IN ('queued','running')
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [ownerId],
        )
        if (active.rows[0]) throw new CoreError('busy', '已有回收站清空任务正在运行，请稍后重新确认')

        const latest = await client.query<TrashPurgeJobRow>(
          `SELECT id,user_id,status,progress_current,progress_total,failed_count,error_code,finished_at
           FROM trash_purge_jobs WHERE user_id=$1 AND status IN ('completed','failed')
           ORDER BY created_at DESC LIMIT 1`, [ownerId],
        )
        const last = latest.rows[0]
        if (last?.status === 'completed' && Number(last.progress_total) > 0 && isWithinCooldown(last.finished_at))
          throw new TrashCooldownError()

        const total = snapshot.file_count + snapshot.folder_count
        const status = total === 0 ? 'completed' : 'queued'
        const inserted = await client.query<TrashPurgeJobRow>(
          `INSERT INTO trash_purge_jobs
             (user_id,status,snapshot_at,progress_current,progress_total,failed_count,error_code,
              lease_owner,lease_until,created_at,started_at,finished_at)
           VALUES ($1,$2,clock_timestamp(),0,$3,0,NULL,NULL,NULL,CURRENT_TIMESTAMP,NULL,
                   CASE WHEN $2::varchar='completed' THEN clock_timestamp() ELSE NULL END)
           RETURNING id,user_id,status,progress_current,progress_total,failed_count,error_code,finished_at`,
          [ownerId, status, total],
        )
        job = inserted.rows[0]
        if (!job) throw new CoreError('busy', '回收站任务未能创建，请稍后重试')
        await client.query(
          `INSERT INTO trash_purge_agent_operations(operation_id,user_id,job_id,snapshot_digest,file_count,folder_count)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [operationId, ownerId, job.id, snapshot.digest, snapshot.file_count, snapshot.folder_count],
        )
        shouldNotify = status === 'queued'
        await client.query('COMMIT')
        committed = true
      } catch (error) {
        if (!committed) await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
      if (shouldNotify) await options.notifyWorker().catch(() => undefined)
      return response(job!)
    },

    async getAgentEmpty(rawOwner, operationId) {
      const ownerId = normalizeFileOwnerId(rawOwner)
      const result = await pool.query<TrashPurgeJobRow>(
        `SELECT j.id,j.user_id,j.status,j.progress_current,j.progress_total,j.failed_count,j.error_code,j.finished_at
           FROM trash_purge_agent_operations a JOIN trash_purge_jobs j ON j.id=a.job_id
          WHERE a.user_id=$1 AND a.operation_id=$2`, [ownerId, operationId],
      )
      return result.rows[0] ? response(result.rows[0]) : null
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
