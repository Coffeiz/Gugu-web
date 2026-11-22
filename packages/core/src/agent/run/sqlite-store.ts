import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import type { Database } from '../../data/schema.js'
import { RunStoreRejected, type Lease, type RunCheckpoint, type RunEvent, type RunIdentity } from '../models.js'
import { terminalRunStates } from './lifecycle.js'
import type { LeasePort, RunStore } from '../ports.js'
import { createAgentInbox } from '../subagent/inbox.js'
import { createSubagentDeliveryStore } from '../subagent/delivery-store.js'
import { assertRunCheckpoint, assertRunEventTransition, assertRunIdentity, createAgentRunCodec } from './codec.js'

type RunCommit<C> = Parameters<RunStore<C>['commit']>[0]

/** 会话已被另一个未结束的运行占用：本次租约接管必须整体回滚。 */
class AgentSessionOccupiedError extends Error {
  constructor() {
    super('Agent run 会话已被占用')
    this.name = 'AgentSessionOccupiedError'
  }
}
interface CheckpointRow { version: number; sequence: number; nonce: Buffer; payload: Buffer }
interface EventRow { event_id: string; sequence: number; nonce: Buffer; payload: Buffer }

export function sqliteAgentRunScope(identity: RunIdentity) {
  assertRunIdentity(identity)
  const owner = dataContext(identity.ownerId).ownerId.replaceAll('-', '')
  return { owner, session: Number(identity.sessionId), run: identity.runId }
}

async function assertLease(db: Kysely<Database>, identity: RunIdentity, lease: Lease, now: number) {
  const { owner, session, run } = sqliteAgentRunScope(identity)
  const result = await sql`SELECT 1 FROM agent_run_leases AS lease
    JOIN conversation_sessions AS session ON session.id=lease.session_id AND session.user_id=lease.user_id
    WHERE lease.user_id=${owner} AND lease.session_id=${session} AND lease.run_id=${run}
      AND lease.token=${lease.token} AND lease.fence=${lease.fence} AND lease.expires_at_ms > ${now}`.execute(db)
  if (!result.rows.length) throw new RunStoreRejected('lease_lost')
}

/** 接入与 Web 相同的加密 RunStore 协议，SQLite 使用 Core 的即时写事务作 CAS 边界。 */
export function createSqliteAgentRunStore<C>(
  db: Kysely<Database>,
  secret: string,
  options: {
    now?: () => number
    onSubagentDeliveryCommitted?(parent: RunIdentity): void | Promise<void>
    applyPreparedContext?: (tx: Transaction<Database>, identity: RunIdentity, context: C) => Promise<void>
    persistPrivateContext?: (tx: Transaction<Database>, identity: RunIdentity, next: RunCheckpoint<C>, previous: RunCheckpoint<C> | null) => Promise<void>
    writeHistory: (tx: Transaction<Database>, identity: RunIdentity, history: NonNullable<RunCommit<C>['history']>, checkpoint: RunCheckpoint<C>) => Promise<void>
  },
): RunStore<C> & Required<Pick<RunStore<C>, 'isSubagentPending'>> & { readEventsAfter(identity: RunIdentity, sequence: number): Promise<readonly RunEvent[]> } {
  const codec = createAgentRunCodec(secret)
  const deliveries = createSubagentDeliveryStore(db, secret)
  const inbox = createAgentInbox(db, secret)
  const now = options.now ?? Date.now

  async function transaction(work: (tx: Transaction<Database>) => Promise<void>) {
    try { await db.transaction().execute(work) }
    catch (error) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
        throw new RunStoreRejected('conflict')
      throw error
    }
  }

  async function readRow(conn: Kysely<Database>, identity: RunIdentity) {
    const { owner, session, run } = sqliteAgentRunScope(identity)
    return (await sql<CheckpointRow>`SELECT version,sequence,nonce,payload FROM agent_run_checkpoints
      WHERE user_id=${owner} AND session_id=${session} AND run_id=${run}`.execute(conn)).rows[0]
  }

  function decode(identity: RunIdentity, row: CheckpointRow) {
    return codec.decryptCheckpoint<C>(identity, row.version, row.nonce, row.payload)
  }

  async function appendEvents(tx: Transaction<Database>, identity: RunIdentity, events: readonly RunEvent[]) {
    const { owner, session, run } = sqliteAgentRunScope(identity)
    for (const event of events) {
      const { nonce, payload } = codec.encryptEvent(identity, event)
      await sql`INSERT INTO agent_run_events(user_id,session_id,run_id,event_id,sequence,nonce,payload,created_at_ms)
        VALUES(${owner},${session},${run},${event.id},${event.sequence},${nonce},${payload},${now()})`.execute(tx)
    }
  }

  async function loadEvents(identity: RunIdentity, after: number | null) {
    const { owner, session, run } = sqliteAgentRunScope(identity)
    const filter = after === null ? sql`acknowledged = 0` : sql`sequence > ${after}`
    const limit = after === null ? sql`` : sql`LIMIT 256`
    const result = await sql<EventRow>`SELECT event_id,sequence,nonce,payload FROM agent_run_events
      WHERE user_id=${owner} AND session_id=${session} AND run_id=${run} AND ${filter}
      ORDER BY sequence ASC ${limit}`.execute(db)
    return result.rows.map(row => codec.decryptEvent(identity, row.event_id, row.sequence, row.nonce, row.payload))
  }

  return {
    readSubagentFinals: deliveries.pending,
    readAgentInbox: inbox.pending,
    isSubagentPending: deliveries.isPending,
    hasPendingSubagents: deliveries.hasPending,
    async read(identity) {
      const row = await readRow(db, identity)
      return row ? decode(identity, row) : null
    },
    async create(checkpoint, lease, events) {
      const identity = checkpoint.identity
      assertRunCheckpoint(identity, checkpoint)
      if (checkpoint.version !== 0) throw new TypeError('Agent run 初始 checkpoint 版本必须为 0')
      assertRunEventTransition(identity, 0, checkpoint.sequence, events)
      const { owner, session, run } = sqliteAgentRunScope(identity)
      const { nonce, payload } = codec.encryptCheckpoint(checkpoint)
      await transaction(async tx => {
        await assertLease(tx, identity, lease, now())
        const failed = await sql`SELECT 1 FROM agent_run_controls WHERE user_id=${owner} AND session_id=${session}
          AND run_id=${run} AND startup_failed=1`.execute(tx)
        if (failed.rows.length) throw new RunStoreRejected('conflict')
        await sql`INSERT INTO agent_run_checkpoints(user_id,session_id,run_id,version,sequence,status,phase,nonce,payload,updated_at_ms)
          VALUES(${owner},${session},${run},${checkpoint.version},${checkpoint.sequence},${checkpoint.status},${checkpoint.phase},${nonce},${payload},${now()})`.execute(tx)
        await appendEvents(tx, identity, events)
        if (checkpoint.context !== null) await options.applyPreparedContext?.(tx, identity, checkpoint.context)
        await options.persistPrivateContext?.(tx, identity, checkpoint, null)
      })
    },
    async commit(change) {
      const { identity, checkpoint, expectedVersion } = change
      assertRunCheckpoint(identity, checkpoint)
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || checkpoint.version !== expectedVersion + 1)
        throw new TypeError('Agent run checkpoint CAS 版本无效')
      const { owner, session, run } = sqliteAgentRunScope(identity)
      const { nonce, payload } = codec.encryptCheckpoint(checkpoint)
      await transaction(async tx => {
        await assertLease(tx, identity, change.lease, now())
        const current = await readRow(tx, identity)
        if (!current) throw new RunStoreRejected('not_found')
        if (current.version !== expectedVersion) throw new RunStoreRejected('conflict')
        assertRunEventTransition(identity, current.sequence, checkpoint.sequence, change.events)
        if (change.interactionReceipt !== null)
          await sql`INSERT INTO agent_run_interaction_receipts(user_id,session_id,run_id,receipt)
            VALUES(${owner},${session},${run},${change.interactionReceipt})`.execute(tx)
        const updated = await sql`UPDATE agent_run_checkpoints SET version=${checkpoint.version},sequence=${checkpoint.sequence},
          status=${checkpoint.status},phase=${checkpoint.phase},nonce=${nonce},payload=${payload},updated_at_ms=${now()}
          WHERE user_id=${owner} AND session_id=${session} AND run_id=${run} AND version=${expectedVersion}
          RETURNING version`.execute(tx)
        if (!updated.rows.length) throw new RunStoreRejected('conflict')
        if (change.agentInboxWaiting === true) await sql`
          INSERT INTO agent_inbox_waits(owner_id,session_id,run_id) VALUES(${identity.ownerId},${identity.sessionId},${run})
          ON CONFLICT(owner_id,session_id,run_id) DO NOTHING`.execute(tx)
        else if (change.agentInboxWaiting === false) await sql`DELETE FROM agent_inbox_waits
          WHERE owner_id=${identity.ownerId} AND session_id=${identity.sessionId} AND run_id=${run}`.execute(tx)
        if (change.subagentWaitChildId === null) await sql`DELETE FROM agent_subagent_waits
          WHERE owner_id=${identity.ownerId} AND parent_session_id=${identity.sessionId} AND parent_run_id=${run}`.execute(tx)
        else if (change.subagentWaitChildId !== undefined) await sql`
          INSERT INTO agent_subagent_waits(owner_id,parent_session_id,parent_run_id,child_id)
          VALUES(${identity.ownerId},${identity.sessionId},${run},${change.subagentWaitChildId})
          ON CONFLICT(owner_id,parent_session_id,parent_run_id) DO UPDATE SET child_id=excluded.child_id`.execute(tx)
        for (const childId of new Set(change.subagentFinalIds ?? []))
          if (!await deliveries.markConsumed(tx, identity, childId, checkpoint.version))
            throw new RunStoreRejected('conflict')
        const messages = [...new Set(change.inboxMessageIds ?? [])]
        if (messages.length) {
          const consumed = await sql`UPDATE agent_inbox_messages SET consumed_checkpoint_version=${checkpoint.version}
            WHERE owner_id=${identity.ownerId} AND recipient_session_id=${identity.sessionId}
              AND message_id IN (${sql.join(messages)}) AND consumed_checkpoint_version IS NULL RETURNING message_id`.execute(tx)
          if (consumed.rows.length !== messages.length) throw new RunStoreRejected('conflict')
        }
        const terminal = change.subagentTerminalDelivery
        if (terminal && !await deliveries.commitTerminal(tx, identity, terminal.parent, terminal.outcome))
          throw new RunStoreRejected('conflict')
        await appendEvents(tx, identity, change.events)
        if (options.applyPreparedContext || options.persistPrivateContext) {
          const previous = decode(identity, current)
          if (previous.context === null && checkpoint.context !== null)
            await options.applyPreparedContext?.(tx, identity, checkpoint.context)
          await options.persistPrivateContext?.(tx, identity, checkpoint, previous)
        }
        if (change.history !== null) await options.writeHistory(tx, identity, change.history, checkpoint)
        if (terminalRunStates.has(checkpoint.status)) {
          await sql`DELETE FROM desktop_agent_continuations
            WHERE user_id=${owner} AND session_id=${session} AND run_id=${run}`.execute(tx)
          await sql`UPDATE conversation_sessions SET active_run_id=NULL,execution_state='idle'
            WHERE id=${session} AND user_id=${owner} AND active_run_id=${run}`.execute(tx)
        }
      })
      if (change.subagentTerminalDelivery && options.onSubagentDeliveryCommitted) {
        try { await options.onSubagentDeliveryCommitted(change.subagentTerminalDelivery.parent) }
        catch { /* 持久等待由本机恢复流程补查。 */ }
      }
    },
    pendingEvents: identity => loadEvents(identity, null),
    readEventsAfter(identity, sequence) {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Agent run 事件序号无效')
      return loadEvents(identity, sequence)
    },
    async acknowledgeEvents(identity, ids) {
      const { owner, session, run } = sqliteAgentRunScope(identity)
      const unique = [...new Set(ids)]
      for (let offset = 0; offset < unique.length; offset += 256) {
        await sql`UPDATE agent_run_events SET acknowledged=1
          WHERE user_id=${owner} AND session_id=${session} AND run_id=${run}
            AND event_id IN (${sql.join(unique.slice(offset, offset + 256))})`.execute(db)
      }
    },
  }
}

/** 同一会话只允许一个写入者，过期或释放后接任会推进 fence。 */
export function createSqliteAgentRunLeasePort(
  db: Kysely<Database>,
  options: { now?: () => number; ttlMs?: number; renewIntervalMs?: number } = {},
): LeasePort {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 30_000
  const renewIntervalMs = options.renewIntervalMs ?? Math.floor(ttlMs / 3)
  if (!Number.isSafeInteger(ttlMs) || !Number.isSafeInteger(renewIntervalMs) || renewIntervalMs < 10 || renewIntervalMs >= ttlMs)
    throw new RangeError('Agent run 租约时间配置无效')
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function update(identity: RunIdentity, lease: Lease, expiresAt: number, mustBeActive: boolean) {
    const { owner, session, run } = sqliteAgentRunScope(identity)
    const active = mustBeActive ? sql`AND expires_at_ms > ${now()}` : sql``
    return sql`UPDATE agent_run_leases SET expires_at_ms=${expiresAt}
      WHERE user_id=${owner} AND session_id=${session} AND run_id=${run}
        AND token=${lease.token} AND fence=${lease.fence} ${active} RETURNING fence`.execute(db)
  }

  function renew(identity: RunIdentity, lease: Lease) {
    const timer = setTimeout(() => {
      void update(identity, lease, now() + ttlMs, true).then(result => {
        if (timers.get(lease.token) !== timer) return
        if (result.rows.length) renew(identity, lease)
        else timers.delete(lease.token)
      }).catch(() => {
        if (timers.get(lease.token) === timer) timers.delete(lease.token)
      })
    }, renewIntervalMs)
    timer.unref()
    timers.set(lease.token, timer)
  }

  return {
    async acquire(identity) {
      const { owner, session, run } = sqliteAgentRunScope(identity)
      const token = randomUUID()
      const at = now()
      const row = await db.transaction().execute(async tx => {
        const { rows } = await sql<{ fence: number }>`
          INSERT INTO agent_run_leases(user_id,session_id,run_id,token,fence,expires_at_ms)
          SELECT user_id,id,${run},${token},1,${at + ttlMs}
          FROM conversation_sessions WHERE id=${session} AND user_id=${owner} AND execution_state<>'baseline_updating'
            AND NOT EXISTS(SELECT 1 FROM agent_run_controls WHERE user_id=${owner} AND session_id=${session}
              AND run_id=${run} AND startup_failed=1)
          ON CONFLICT(user_id,session_id) DO UPDATE SET run_id=excluded.run_id,token=excluded.token,
            fence=agent_run_leases.fence+1,expires_at_ms=excluded.expires_at_ms
          WHERE agent_run_leases.expires_at_ms <= ${at}
            OR EXISTS(SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=${owner} AND c.session_id=${session}
              AND c.run_id=agent_run_leases.run_id AND c.status IN (${sql.join([...terminalRunStates].map(status => sql`${status}`))}))
          RETURNING fence`.execute(tx)
        if (!rows.length) return null
        // 会话归属跟随正在执行的运行：等待子代理的运行已经归还会话。
        // 只有严格空闲或已经属于本运行的会话可以被接管，
        // 否则会抢走刚被准入但还没开始执行的新运行。
        const occupied = await sql`UPDATE conversation_sessions SET execution_state='running',active_run_id=${run}
          WHERE id=${session} AND user_id=${owner} AND (active_run_id IS NULL OR active_run_id=${run})
          RETURNING id`.execute(tx)
        if (!occupied.rows.length) throw new AgentSessionOccupiedError()
        return rows[0]!
      }).catch(error => {
        if (error instanceof AgentSessionOccupiedError) return null
        throw error
      })
      if (!row) return null
      if (!Number.isSafeInteger(row.fence)) throw new RangeError('Agent run fencing 序号超出安全范围')
      const lease = { token, fence: row.fence }
      renew(identity, lease)
      return lease
    },
    assert: (identity, lease) => assertLease(db, identity, lease, now()),
    async release(identity, lease) {
      const timer = timers.get(lease.token)
      if (timer) clearTimeout(timer)
      timers.delete(lease.token)
      const { owner, session, run } = sqliteAgentRunScope(identity)
      // 租约与会话归属同事务归还：等待子代理的运行不占着会话，用户可以继续对话。
      // 仍在执行中的运行保留会话归属：恢复流程要靠它找到这轮孤儿运行并结算。
      await db.transaction().execute(async tx => {
        await sql`UPDATE agent_run_leases SET expires_at_ms=0
          WHERE user_id=${owner} AND session_id=${session} AND run_id=${run}
            AND token=${lease.token} AND fence=${lease.fence}`.execute(tx)
        await sql`UPDATE conversation_sessions SET
          execution_state=CASE WHEN execution_state='baseline_updating' THEN execution_state ELSE 'idle' END,
          active_run_id=NULL
          WHERE id=${session} AND user_id=${owner} AND active_run_id=${run}
            AND NOT EXISTS(SELECT 1 FROM agent_run_checkpoints c
              WHERE c.user_id=${owner} AND c.session_id=${session} AND c.run_id=${run}
                AND c.status IN ('preparing','running'))`.execute(tx)
      })
    },
  }
}
