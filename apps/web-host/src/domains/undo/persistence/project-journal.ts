import type { Pool } from 'pg'

export interface ProjectUndoMove { from: string; to: string }
export interface ProjectUndoJournalStorage {
  /** 检查授权根内路径，拒绝符号链接和越界。 */
  exists(ownerId: string, key: string): Promise<boolean>
  /** 不得覆盖目标；源和目标都必须处于 owner 授权根内。 */
  move(ownerId: string, from: string, to: string): Promise<void>
}
export interface ProjectUndoJournal {
  id: string
  ownerId: string
  operationId: string
  beforeStatus: 'active' | 'undone'
  afterStatus: 'active' | 'undone'
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
export async function recoverProjectUndoJournal(pool: Pool, storage: ProjectUndoJournalStorage): Promise<boolean> {
  const client = await pool.connect()
  let locked = false
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('gugu-project-undo-journal'))")
    locked = true
    await client.query('BEGIN')
    const result = await client.query<{ id: string, user_id: string, operation_id: string, before_status: string, after_status: string, moves: ProjectUndoMove[] }>(
      'SELECT id,user_id::text,operation_id,before_status,after_status,moves FROM project_undo_journals ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1',
    )
    const journal = result.rows[0]
    if (!journal) { await client.query('COMMIT'); return false }
    const operation = await client.query<{ status: string }>('SELECT status FROM undo_operations WHERE id=$1 AND user_id=$2 FOR UPDATE', [journal.operation_id, journal.user_id])
    const status = operation.rows[0]?.status
    if (status !== journal.before_status && status !== journal.after_status) throw new Error('撤销操作状态与文件日志不一致')
    const committed = status === journal.after_status
    const moves = committed ? journal.moves : [...journal.moves].reverse()
    for (const move of moves) {
      const from = committed ? move.from : move.to
      const to = committed ? move.to : move.from
      const source = await storage.exists(journal.user_id, from)
      const target = await storage.exists(journal.user_id, to)
      if (source && !target) await storage.move(journal.user_id, from, to)
      else if (source || !target) throw new Error('撤销文件日志路径状态不明确')
    }
    await client.query('DELETE FROM project_undo_journals WHERE id=$1', [journal.id])
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    let discard = false
    if (locked) try { await client.query("SELECT pg_advisory_unlock(hashtext('gugu-project-undo-journal'))") } catch { discard = true }
    client.release(discard)
  }
}
