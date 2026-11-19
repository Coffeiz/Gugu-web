import { randomUUID } from 'node:crypto'
import { runTrashPurgeJob, type TrashPurgeEntry, type TrashPurgeJobLease } from '@gugu/core/files/trash-purge-worker'
import { CoreError } from '@gugu/core/contracts'
import type { Pool } from 'pg'
import type { LiveSubscriptionFactory } from '../../adapters/redis-live-subscription.js'
import type { RedisEventPublisher } from '../../adapters/redis-events.js'
import { createPostgresPurgeLeaseStore, type PurgeLease } from './trash-purge-worker-postgres.js'

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
