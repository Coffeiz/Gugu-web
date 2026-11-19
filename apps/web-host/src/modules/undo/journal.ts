import { randomUUID } from 'node:crypto'
import { recoverProjectFileMoves, type ProjectUndoMove, type ProjectUndoJournalStorage } from '@gugu/core/projects/undo'
import type { ProjectDeleteRuntime } from '@gugu/core/tools'
import type { Pool, PoolClient } from 'pg'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { checkedPath, moveProjectFileNoReplace } from '../projects/lifecycle/storage.js'

export type { ProjectUndoMove, ProjectUndoJournalStorage } from '@gugu/core/projects/undo'

const forwardBefore = 'agent_pending'

const forwardAfter = 'agent_committed'

const journalLock = "hashtext('gugu-project-undo-journal')"

type ProjectDeleteMove = ProjectUndoMove & { fileId: number }

export async function hasProjectDeleteJournalSchema(db: Pick<Pool, 'query'>): Promise<boolean> {
  const result = await db.query<{ ready: boolean }>(
    "SELECT to_regclass('project_undo_journals') IS NOT NULL AND to_regclass('core_operation_receipts') IS NOT NULL AS ready",
  )
  return result.rows[0]?.ready === true
}

export interface ProjectUndoJournal {
  id: string
  ownerId: string
  operationId: string
  beforeStatus: 'active' | 'undone' | typeof forwardBefore
  afterStatus: 'active' | 'undone' | typeof forwardAfter
  moves: ProjectUndoMove[]
}

/** 在任意物理移动前持久化完整计划；调用方持有跨进程锁直到事务结束。 */
export async function saveProjectUndoJournal(pool: Pick<Pool, 'query'>, journal: ProjectUndoJournal): Promise<void> {
  await pool.query(`INSERT INTO project_undo_journals
    (id,user_id,operation_id,before_status,after_status,moves,created_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,CURRENT_TIMESTAMP)`,
  [journal.id, journal.ownerId, journal.operationId, journal.beforeStatus, journal.afterStatus, JSON.stringify(journal.moves)])
}

/** 在执行单次移动前提交目标；调用方必须持续持有与恢复共用的进程间锁。 */
export async function appendProjectUndoMove(pool: Pick<Pool, 'query'>, id: string, move: ProjectUndoMove): Promise<void> {
  if (!move.from || !move.to || move.from === move.to) throw new Error('撤销文件移动计划无效')
  const result = await pool.query(`UPDATE project_undo_journals SET moves=(moves::jsonb || $2::jsonb)::json WHERE id=$1`,
    [id, JSON.stringify([move])])
  if (result.rowCount !== 1) throw new Error('撤销文件日志不存在')
}

/** 重启时在同一跨进程锁内核对操作终态；有歧义时保留日志并停止。 */
async function withJournalLock<T>(pool: Pick<Pool, 'connect'>, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let locked = false
  try {
    await client.query(`SELECT pg_advisory_lock(${journalLock})`)
    locked = true
    return await work(client)
  } finally {
    let discard = !locked
    if (locked) try { await client.query(`SELECT pg_advisory_unlock(${journalLock})`) } catch { discard = true }
    client.release(discard)
  }
}

export async function recoverProjectUndoJournal(pool: Pool, storage: ProjectUndoJournalStorage): Promise<boolean> {
  return withJournalLock(pool, async client => {
    try {
      await client.query('BEGIN')
      const result = await client.query<{ id: string, user_id: string, operation_id: string, before_status: string, after_status: string, moves: ProjectUndoMove[] }>(
        "SELECT id,user_id::text,operation_id,before_status,after_status,moves FROM project_undo_journals WHERE before_status IN ('active','undone') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
      const journal = result.rows[0]
      if (!journal) { await client.query('COMMIT'); return false }
      const operation = await client.query<{ status: string }>('SELECT status FROM undo_operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [journal.operation_id, journal.user_id])
      const status = operation.rows[0]?.status
      await recoverProjectFileMoves({ ownerId: journal.user_id, beforeStatus: journal.before_status,
        afterStatus: journal.after_status, moves: journal.moves }, status, storage)
      await client.query('DELETE FROM project_undo_journals WHERE id=$1', [journal.id])
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  })
}

async function recoverForwardDelete(client: PoolClient, storage: ProjectUndoJournalStorage, owner: string, operationId: string, background = false) {
  await client.query('BEGIN')
  try {
    const result = await client.query<{ id: string; moves: ProjectDeleteMove[] }>(
      `SELECT id,moves FROM project_undo_journals WHERE user_id=$1 AND operation_id=$2 AND before_status=$3 AND after_status=$4 FOR UPDATE${background ? ' NOWAIT' : ''}`,
      [owner, operationId, forwardBefore, forwardAfter],
    )
    const journal = result.rows[0]
    if (journal) {
      // 收据事务与恢复共用操作锁。只有已确定事务终态后才检查收据。
      if (background) {
        const lock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [`${owner}:${operationId}`])
        if (lock.rows[0]?.acquired !== true) { await client.query('ROLLBACK'); return }
      } else await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${owner}:${operationId}`])
      const receipt = await client.query<{ method: string }>(
        'SELECT method FROM core_operation_receipts WHERE owner_id=$1 AND operation_id=$2', [owner, operationId],
      )
      if (receipt.rows[0] && receipt.rows[0].method !== 'agent.project.delete') throw new Error('项目删除日志与操作收据不匹配')
      const committed = Boolean(receipt.rows[0])
      const fileIds = journal.moves.map(move => move.fileId)
      if (fileIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(fileIds).size !== fileIds.length)
        throw new Error('项目删除文件日志无效')
      const files = await client.query<{ id: number; storage_key: string; deleted_at: Date | null }>(
        `SELECT id,storage_key,deleted_at FROM files WHERE user_id=$1 AND id=ANY($2::int[]) ORDER BY id FOR UPDATE${background ? ' NOWAIT' : ''}`,
        [owner, fileIds],
      )
      const byId = new Map(files.rows.map(file => [file.id, file]))
      for (const move of journal.moves) {
        const file = byId.get(move.fileId)
        if (!file || file.storage_key !== (committed ? move.to : move.from) || (file.deleted_at !== null) !== committed)
          throw new Error('项目删除后的文件记录已变化')
      }
      await recoverProjectFileMoves({ ownerId: owner, beforeStatus: forwardBefore, afterStatus: forwardAfter, moves: journal.moves },
        committed ? forwardAfter : forwardBefore, storage)
      await client.query('DELETE FROM project_undo_journals WHERE id=$1', [journal.id])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (background && (error as { code?: string })?.code === '55P03') return
    throw error
  }
}

/** 每批最多扫描 32 条，跳过正在执行的移动，单条冲突不阻塞其余记录。 */
export async function recoverProjectDeleteJournalBatch(pool: Pick<Pool, 'connect'>, storage: ProjectUndoJournalStorage,
  cursor: string | null, onError: () => void): Promise<string | null> {
  const client = await pool.connect()
  let locked = false, discard = false
  try {
    const lock = await client.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock(${journalLock}) AS acquired`)
    locked = lock.rows[0]?.acquired === true
    if (!locked) return cursor
    if (!await hasProjectDeleteJournalSchema(client)) return null
    const { rows } = await client.query<{ id: string; user_id: string; operation_id: string }>(`
      SELECT id::text,user_id::text,operation_id FROM project_undo_journals
      WHERE before_status=$1 AND after_status=$2 AND ($3::uuid IS NULL OR id>$3::uuid)
      ORDER BY id LIMIT 32`, [forwardBefore, forwardAfter, cursor])
    for (const row of rows) {
      try { await recoverForwardDelete(client, storage, row.user_id, row.operation_id, true) }
      catch { onError() }
    }
    return rows.length === 32 ? rows.at(-1)!.id : null
  } catch (error) {
    discard = !locked
    throw error
  } finally {
    if (locked) try { await client.query(`SELECT pg_advisory_unlock(${journalLock})`) } catch { discard = true }
    client.release(discard)
  }
}

/** 与 Undo 使用同一个移动日志和跨进程锁，恢复方向由 Agent 删除调用收据决定。 */
export function createPostgresProjectDeleteJournal(pool: Pick<Pool, 'connect'>, storage: ProjectUndoJournalStorage):
  Pick<ProjectDeleteRuntime, 'withJournal' | 'recoverJournal'> {
  return {
    async recoverJournal(owner, operationId) {
      await withJournalLock(pool, client => recoverForwardDelete(client, storage, owner, operationId))
    },
    async withJournal(owner, operationId, execute) {
      return withJournalLock(pool, async client => {
        await recoverForwardDelete(client, storage, owner, operationId)
        let id: string | undefined
        return execute({
          async record(fileId, from, to) {
            if (!Number.isSafeInteger(fileId) || fileId < 1) throw new Error('项目删除文件 ID 无效')
            if (!id) {
              const next = randomUUID()
              await saveProjectUndoJournal(client, { id: next, ownerId: owner, operationId,
                beforeStatus: forwardBefore, afterStatus: forwardAfter, moves: [] })
              id = next
            }
            const move: ProjectDeleteMove = { fileId, from, to }
            await appendProjectUndoMove(client, id, move)
          },
          async finish() {
            if (id) await recoverForwardDelete(client, storage, owner, operationId)
          },
        })
      })
    },
  }
}

/** 恢复常规文件；目录恢复在获得不覆盖原子移动能力前保留日志。 */
export function createLocalProjectUndoJournalStorage(storageRoot: string): ProjectUndoJournalStorage {
  return {
    async exists(ownerId, key) {
      try {
        const root = await realpath(storageRoot)
        const target = await checkedPath(root, ownerId, key, false)
        await lstat(target)
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return false
        throw error
      }
    },
    async move(ownerId, from, to) {
      const root = await realpath(storageRoot)
      const source = await checkedPath(root, ownerId, from, false)
      const target = await checkedPath(root, ownerId, to)
      await mkdir(path.dirname(target), { recursive: true })
      await moveProjectFileNoReplace(source, target, async () => {
        await checkedPath(root, ownerId, from, false)
        await checkedPath(root, ownerId, to)
      })
    },
  }
}
