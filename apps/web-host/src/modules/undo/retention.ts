import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { createHash } from 'node:crypto'
import { undoRetentionCompletion } from '@gugu/core/undo'
import { normalizeFileOwnerId } from '../files/store.js'

type Candidate = QueryResultRow & {
  id: string
  user_id: string
  artifact_refs: unknown
  failure_code: string | null
}
type RetentionStorage = { removePrefix(ownerId: string, prefix: string): Promise<number> }

function artifactOperationIds(ownerId: string, row: Candidate): Set<string> {
  const owner = normalizeFileOwnerId(ownerId)
  const ids = new Set<string>()
  if (/^op-[0-9a-f]{32}$/.test(row.id)) ids.add(row.id)
  const refs = typeof row.artifact_refs === 'string' ? JSON.parse(row.artifact_refs) : row.artifact_refs
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return ids
  for (const [ref, value] of Object.entries(refs)) {
    if (!ref.startsWith('file:') || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const fileKey = createHash('sha256').update(ref.slice('file:'.length)).digest('hex').slice(0, 24)
    for (const key of Object.values(value as Record<string, unknown>)) {
      if (typeof key !== 'string') continue
      const parts = key.split('/')
      if (parts.length === 5 && parts[0] === owner && parts[1] === '.undo'
        && /^op-[0-9a-f]{32}$/.test(parts[2]!) && parts[3] === `file-${fileKey}`
        && (parts[4] === 'before' || parts[4] === 'after')) ids.add(parts[2]!) // 兼容旧版本 artifact 路径与 Undo 行 ID 错位。
    }
  }
  return ids
}

async function cleanCandidate(client: PoolClient, row: Candidate, storage: RetentionStorage): Promise<{ artifacts: number; cleaned: boolean }> {
  let artifacts = 0
  try {
    const prefixes = artifactOperationIds(row.user_id, row)
    for (const operationId of prefixes) artifacts += await storage.removePrefix(row.user_id, `${row.user_id}/.undo/${operationId}`)
  } catch {
    return { artifacts, cleaned: false }
  }
  const completed = undoRetentionCompletion(row.failure_code)
  await client.query(
    'UPDATE undo_operations SET status=$3,failure_code=$4,artifact_refs=$5::json WHERE id=$1 AND user_id=$2',
    [row.id, row.user_id, completed.status, completed.failureCode, JSON.stringify({})],
  )
  return { artifacts, cleaned: true }
}

/** 按 Python UndoService.cleanup_expired 的语义删除过期正文；失败记录保持可重试。 */
export async function cleanupExpiredUndoArtifacts(
  pool: Pick<Pool, 'connect'>,
  storage: RetentionStorage,
  now: Date,
  limit = 100,
): Promise<{ expired: number; artifacts: number; failed: number }> {
  if (!Number.isFinite(now.getTime())) throw new RangeError('清理时间无效')
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('清理批次无效')
  const client = await pool.connect()
  let begun = false
  try {
    await client.query('BEGIN')
    begun = true
    const selected = await client.query<Candidate>(
      `SELECT id,user_id,artifact_refs,failure_code FROM undo_operations
       WHERE (expires_at IS NOT NULL AND expires_at <= $1 AND status <> 'expired')
          OR (status = 'expired' AND failure_code = 'redo_cleared_by_new_operation')
          OR (status = 'expired' AND failure_code = 'retention_expired' AND artifact_refs::jsonb <> '{}'::jsonb)
       ORDER BY expires_at ASC NULLS LAST LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    )
    let expired = 0, artifacts = 0, failed = 0
    for (const row of selected.rows) {
      const result = await cleanCandidate(client, row, storage)
      artifacts += result.artifacts
      if (result.cleaned) expired += 1
      else failed += 1
    }
    await client.query('COMMIT')
    begun = false
    return { expired, artifacts, failed }
  } catch (error) {
    if (begun) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** 启动后每小时执行一次；停止时等待在途清理结束。 */
export function startUndoRetentionWorker(options: {
  pool: Pick<Pool, 'connect'>
  storage: RetentionStorage
  intervalMs?: number
  now?: () => Date
  onError(): void
}): { stop(): Promise<void> } {
  const interval = options.intervalMs ?? 3_600_000
  if (!Number.isSafeInteger(interval) || interval < 1) throw new RangeError('清理间隔无效')
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const wait = () => new Promise<void>(resolve => {
    wake = resolve
    timer = setTimeout(resolve, interval)
    timer.unref()
  })
  const running = (async () => {
    while (!stopped) {
      await wait()
      if (stopped) break
      try { await cleanupExpiredUndoArtifacts(options.pool, options.storage, options.now?.() ?? new Date()) }
      catch { try { options.onError() } catch { /* 诊断失败不能终止后续清理 */ } }
    }
  })()
  return { async stop() { stopped = true; if (timer) clearTimeout(timer); wake?.(); await running } }
}
