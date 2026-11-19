import type { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { lockQuota, reconcileLocalUsage, recoverStagedLocalFile, stageLocalFileRemoval } from '../../files/persistence/trash-mutations-postgres.js'
import { ensureRegistrationFileLibraryQuota } from '../../files/persistence/storage-quota.js'
import { enqueueScheduledTaskRagRebuild } from '../../scheduled-tasks/persistence/task-rag-job-postgres.js'

export async function hasProjectExpiryJournalSchema(db: Pick<Pool, 'query'>): Promise<boolean> {
  const result = await db.query<{ ready: boolean }>(
    "SELECT to_regclass('project_expiry_journals') IS NOT NULL AS ready",
  )
  return result.rows[0]?.ready === true
}

/** 清理一个过期项目；行锁使恢复和多个清理者不会同时处理同一项目。 */
export async function purgeExpiredProject(pool: Pool, storageRoot: string, cutoff: Date, defaultLimitBytes: number | null): Promise<boolean> {
  const client = await pool.connect()
  const staged: NonNullable<Awaited<ReturnType<typeof stageLocalFileRemoval>>>[] = []
  let committed = false
  let commitAttempted = false
  let locked = false
  let journalClient: PoolClient | undefined
  try {
    const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('gugu-project-expiry:' || current_schema())) AS acquired")
    if (!lock.rows[0]?.acquired) return false
    locked = true
    // 先预留日志连接，再持有项目行锁；其他请求等待项目时不会耗尽所需连接。
    journalClient = await pool.connect()
    await client.query('BEGIN')
    const result = await client.query<{ id: number; user_id: string }>(
      `SELECT id,user_id::text FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= $1
       ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`, [cutoff],
    )
    const project = result.rows[0]
    if (!project) {
      await client.query('COMMIT')
      return false
    }
    const { id, user_id: owner } = project
    const files = await client.query<{ id: number; storage_key: string }>(
      `SELECT id,storage_key FROM files WHERE user_id=$1 AND
       (project_id=$2 OR folder_id IN (SELECT id FROM folders WHERE user_id=$1 AND project_id=$2)) FOR UPDATE`,
      [owner, id],
    )
    await ensureRegistrationFileLibraryQuota(client, owner, defaultLimitBytes)
    const quota = await lockQuota(client, owner)
    const journalId = randomUUID()
    // 独立连接先提交日志；项目行锁持续持有到清理事务结束。
    await journalClient.query(
      `INSERT INTO project_expiry_journals(id,user_id,project_id,entries,created_at)
       VALUES($1,$2,$3,$4::json,CURRENT_TIMESTAMP)`,
      [journalId, owner, id, JSON.stringify(files.rows)],
    )
    for (const file of files.rows) {
      const item = await stageLocalFileRemoval(storageRoot, owner, file.storage_key, journalId)
      if (item) staged.push(item)
    }
    await client.query('DELETE FROM files WHERE user_id=$1 AND id=ANY($2::int[])', [owner, files.rows.map((file) => file.id)])
    const removedTasks = await client.query<{ id: number }>(
      `DELETE FROM scheduled_tasks WHERE user_id=$1 AND event_id IN
       (SELECT id FROM calendar_events WHERE user_id=$1 AND project_id=$2) RETURNING id`, [owner, id],
    )
    for (const task of removedTasks.rows) await enqueueScheduledTaskRagRebuild(client, owner, Number(task.id))
    await client.query('DELETE FROM calendar_events WHERE user_id=$1 AND project_id=$2', [owner, id])
    await client.query('DELETE FROM folders WHERE user_id=$1 AND project_id=$2', [owner, id])
    await client.query('DELETE FROM projects WHERE user_id=$1 AND id=$2', [owner, id])
    await reconcileLocalUsage(client, storageRoot, owner, quota, new Set(staged.map((item) => item.stagedPath)))
    commitAttempted = true
    await client.query('COMMIT')
    committed = true
    for (const item of staged) await item.discard()
    await journalClient.query('DELETE FROM project_expiry_journals WHERE id=$1', [journalId])
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    // 提交连接中断时结果未知，保留暂存文件供后续核对，不能假定回滚成功。
    if (!committed && !commitAttempted) {
      for (const item of staged.reverse()) await item.restore()
    }
    throw error
  } finally {
    journalClient?.release()
    let discard = false
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext('gugu-project-expiry:' || current_schema()))") }
      catch { discard = true }
    }
    client.release(discard)
  }
}

/** 重启后按数据库中项目和文件的状态恢复；任何路径冲突均保留日志供重试。 */
export async function recoverProjectExpiryJournal(pool: Pool, storageRoot: string): Promise<boolean | 'busy'> {
  const client = await pool.connect()
  let locked = false
  try {
    const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('gugu-project-expiry:' || current_schema())) AS acquired")
    if (!lock.rows[0]?.acquired) return 'busy'
    locked = true
    await client.query('BEGIN')
    const journals = await client.query<{ id: string; user_id: string; project_id: number; entries: Array<{ id: number; storage_key: string }> }>(
      `SELECT id,user_id::text,project_id,entries FROM project_expiry_journals
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    )
    const journal = journals.rows[0]
    if (!journal) { await client.query('COMMIT'); return false }
    const project = await client.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [journal.project_id, journal.user_id])
    for (const entry of journal.entries) {
      const file = await client.query<{ storage_key: string }>('SELECT storage_key FROM files WHERE id=$1 AND user_id=$2 FOR UPDATE', [entry.id, journal.user_id])
      if (file.rows[0] && file.rows[0].storage_key !== entry.storage_key) throw new Error('暂存文件对应的路径已变更')
      if (project.rowCount && !file.rowCount) throw new Error('项目仍存在但暂存文件记录已不存在')
      await recoverStagedLocalFile(storageRoot, journal.user_id, entry.storage_key, journal.id, Boolean(file.rowCount))
    }
    await client.query('DELETE FROM project_expiry_journals WHERE id=$1', [journal.id])
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    let discard = false
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext('gugu-project-expiry:' || current_schema()))") }
      catch { discard = true }
    }
    client.release(discard)
  }
}
