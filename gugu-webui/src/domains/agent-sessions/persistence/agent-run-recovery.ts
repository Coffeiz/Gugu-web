import type { Pool, PoolClient } from 'pg'

export interface AgentRunRecoveryState {
  probe(sessionId: number): Promise<{
    redisOk: boolean
    active: boolean | null
    stale: boolean
  }>
  reap(sessionId: number): Promise<void>
  compressionLockExists(sessionId: number): Promise<boolean>
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // Keep the original failure; releasing the connection remains mandatory.
  }
}

/** Owner-scoped recovery for a run whose worker no longer owns a Redis lease. */
export function createPostgresAgentOrphanRecovery(
  pool: Pick<Pool, 'connect'>,
  state: AgentRunRecoveryState,
) {
  return async function recoverOrphanedSession(ownerId: string, sessionId: number): Promise<boolean> {
    const probe = await state.probe(sessionId)
    if (!probe.redisOk || (probe.active && !probe.stale)) return false

    const client = await pool.connect()
    let transactionOpen = false
    try {
      await client.query('BEGIN')
      transactionOpen = true
      const owned = await client.query<{
        execution_state: string
        active_run_id: string | null
      }>(
        `SELECT execution_state, active_run_id FROM conversation_sessions
         WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [sessionId, ownerId],
      )
      const session = owned.rows[0]
      if (!session || !['running', 'baseline_updating'].includes(session.execution_state)) {
        await client.query('COMMIT')
        transactionOpen = false
        return false
      }

      if (session.execution_state === 'baseline_updating') {
        let compressionLocked: boolean
        try {
          compressionLocked = await state.compressionLockExists(sessionId)
        } catch {
          await client.query('COMMIT')
          transactionOpen = false
          return false
        }
        if (compressionLocked) {
          await client.query('COMMIT')
          transactionOpen = false
          return false
        }
      }

      if (probe.stale) await state.reap(sessionId)
      const updated = await client.query(
        `UPDATE conversation_sessions
         SET execution_state = 'idle', active_run_id = NULL
         WHERE id = $1 AND user_id = $2 AND execution_state = $3
           AND active_run_id IS NOT DISTINCT FROM $4`,
        [sessionId, ownerId, session.execution_state, session.active_run_id],
      )
      await client.query('COMMIT')
      transactionOpen = false
      return updated.rowCount === 1
    } catch (error) {
      if (transactionOpen) await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }
}
