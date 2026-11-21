import { sql, type Kysely } from 'kysely'
import type { Database } from '../../data/schema.js'
import type { RunIdentity } from '../models.js'
import type { CancellationPort } from '../ports.js'
import { createAgentRunEventStream, createAgentRunStateReader, type AgentRunEventReader } from './event-stream.js'
import { sqliteAgentRunScope } from './sqlite-store.js'

function createRunSignals() {
  const listeners = new Map<string, Set<() => void>>()

  function key(identity: RunIdentity) {
    const { owner, session, run } = sqliteAgentRunScope(identity)
    return JSON.stringify([owner, session, run])
  }

  return {
    listen(identity: RunIdentity, callback: () => void) {
      const id = key(identity)
      const group = listeners.get(id) ?? new Set<() => void>()
      listeners.set(id, group)
      group.add(callback)
      return () => {
        group.delete(callback)
        if (group.size === 0 && listeners.get(id) === group) listeners.delete(id)
      }
    },
    async notify(identity: RunIdentity) {
      for (const callback of [...listeners.get(key(identity)) ?? []]) callback()
    },
  }
}

/** 本机唤醒只传递变化信号，事件、取消和启动失败均以 SQLite 为准。 */
export function createSqliteAgentRunCoordination(
  db: Kysely<Database>,
  store: Pick<AgentRunEventReader, 'readEventsAfter'> & {
    read(identity: RunIdentity): ReturnType<AgentRunEventReader['readState']>
  },
) {
  const eventSignals = createRunSignals()
  const cancellationSignals = createRunSignals()

  async function readControl(identity: RunIdentity) {
    const { owner, session, run } = sqliteAgentRunScope(identity)
    return (await sql<{ cancel_requested: number; startup_failed: number }>`
      SELECT cancel_requested,startup_failed FROM agent_run_controls
      WHERE user_id=${owner} AND session_id=${session} AND run_id=${run}`.execute(db)).rows[0]
  }

  const cancellation: CancellationPort = {
    async isRequested(identity) { return (await readControl(identity))?.cancel_requested === 1 },
    async request(identity) {
      const { owner, session, run } = sqliteAgentRunScope(identity)
      await sql`INSERT INTO agent_run_controls(user_id,session_id,run_id,cancel_requested)
        SELECT user_id,id,${run},1 FROM conversation_sessions WHERE id=${session} AND user_id=${owner}
        ON CONFLICT(user_id,session_id,run_id) DO UPDATE SET cancel_requested=1`.execute(db)
    },
    notify: cancellationSignals.notify,
    async subscribe(identity, listener) {
      return cancellationSignals.listen(identity, listener)
    },
  }

  const startup = {
    async readFailure(identity: RunIdentity) { return (await readControl(identity))?.startup_failed === 1 },
    async failStart(identity: RunIdentity) {
      const { owner, session, run } = sqliteAgentRunScope(identity)
      await db.transaction().execute(async tx => {
        const { rows } = await sql`INSERT INTO agent_run_controls(user_id,session_id,run_id,startup_failed)
          SELECT user_id,id,${run},1 FROM conversation_sessions WHERE id=${session} AND user_id=${owner}
            AND NOT EXISTS(SELECT 1 FROM agent_run_checkpoints WHERE user_id=${owner} AND session_id=${session} AND run_id=${run})
            AND NOT EXISTS(SELECT 1 FROM agent_run_leases WHERE user_id=${owner} AND session_id=${session}
              AND expires_at_ms > ${Date.now()})
          ON CONFLICT(user_id,session_id,run_id) DO UPDATE SET startup_failed=1
          RETURNING run_id`.execute(tx)
        if (rows.length)
          await sql`UPDATE conversation_sessions SET active_run_id=NULL,execution_state='idle'
            WHERE id=${session} AND user_id=${owner} AND active_run_id=${run}`.execute(tx)
      })
    },
  }

  const readState = createAgentRunStateReader(store, startup)
  const events = createAgentRunEventStream({
    readEventsAfter: (identity, sequence) => store.readEventsAfter(identity, sequence),
    readState,
  }, {
    notify: eventSignals.notify,
    async subscribe(identity) {
      let pending = false
      let closed = false
      let wake: (() => void) | undefined
      const unsubscribe = eventSignals.listen(identity, () => {
        if (wake) wake()
        else pending = true
      })
      return {
        async next(signal) {
          if (signal.aborted || closed) return
          if (pending) { pending = false; return }
          await new Promise<void>(resolve => {
            const finish = () => {
              signal.removeEventListener('abort', finish)
              wake = undefined
              resolve()
            }
            wake = finish
            signal.addEventListener('abort', finish, { once: true })
          })
        },
        async close() {
          closed = true
          unsubscribe()
          wake?.()
        },
      }
    },
  })

  return { cancellation, events, readState, failStart: startup.failStart }
}
