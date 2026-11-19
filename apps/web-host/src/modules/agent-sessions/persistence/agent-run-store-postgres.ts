import type { Pool, PoolClient } from 'pg'
import { RunStoreRejected } from '@gugu/core/agent'
import { createAgentRunCodec, assertRunIdentity as validateIdentity, sameRunIdentity as sameIdentity, assertRunCheckpoint as assertCheckpointIdentity } from '@gugu/core/agent/run/codec'
import { withBorrowedPostgresQuery } from '@gugu/core/data'
import type { Lease, RunCheckpoint, RunEvent, RunIdentity, RunStore } from '@gugu/core/agent'
import { agentRunStartupFailed, lockAgentRunSession } from './agent-run-startup-postgres.js'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { isPostgresUniqueViolation } from '../../../adapters/database/postgres-errors.js'

export interface AgentRunHistoryWrite<C> {
  outcome: 'success' | 'interruption' | 'silent'
  context: C
  text: string
}

export interface AgentRunStoreOptions<C> {
  /** 首次 prepared checkpoint 与快照 CAS 同事务提交。 */
  applyPreparedContext?(client: PoolClient, identity: RunIdentity, context: C): Promise<void>
  /** Canonical history, usage and pending compaction must share the checkpoint transaction. */
  writeHistory(
    client: PoolClient,
    identity: RunIdentity,
    history: AgentRunHistoryWrite<C>,
    checkpoint: RunCheckpoint<C>,
  ): Promise<void>
}

interface StoredCheckpoint {
  version: string | number
  nonce: Buffer
  payload: Buffer
}

interface StoredEvent {
  event_id: string
  sequence: string | number
  nonce: Buffer
  payload: Buffer
}
const checkpointReadSql = `SELECT version, nonce, payload FROM agent_run_checkpoints
  WHERE user_id = $1 AND session_id = $2 AND run_id = $3`

function sessionNumber(sessionId: string): number {
  if (!/^[1-9]\d*$/.test(sessionId)) throw new TypeError('Agent 会话身份无效')
  const value = Number(sessionId)
  if (!Number.isSafeInteger(value)) throw new TypeError('Agent 会话身份无效')
  return value
}

async function assertLease(client: PoolClient, identity: RunIdentity, lease: Lease): Promise<void> {
  validateIdentity(identity)
  const sessionId = sessionNumber(identity.sessionId)
  const result = await client.query(
    `SELECT 1
     FROM agent_run_leases AS lease
     JOIN conversation_sessions AS session
       ON session.id = lease.session_id AND session.user_id = lease.user_id
     WHERE lease.user_id = $1 AND lease.session_id = $2 AND lease.run_id = $3
       AND lease.token = $4 AND lease.fence = $5
       AND lease.expires_at > clock_timestamp()
     FOR UPDATE OF lease`,
    [identity.ownerId, sessionId, identity.runId, lease.token, lease.fence],
  )
  if (result.rowCount !== 1) throw new RunStoreRejected('lease_lost')
}

async function insertEvents(
  client: PoolClient,
  codec: ReturnType<typeof createAgentRunCodec>,
  identity: RunIdentity,
  events: readonly RunEvent[],
): Promise<void> {
  for (const event of events) {
    if (!sameIdentity(identity, event.identity) || !Number.isSafeInteger(event.sequence) || event.sequence < 1)
      throw new TypeError('Agent run event 身份或序号无效')
    const encrypted = codec.encryptEvent(identity, event)
    await client.query(
      `INSERT INTO agent_run_events (
         user_id, session_id, run_id, event_id, sequence, nonce, payload, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
      [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, event.id,
        event.sequence, encrypted.nonce, encrypted.payload],
    )
  }
}

function assertEventTransition(
  identity: RunIdentity,
  previousSequence: number,
  nextSequence: number,
  events: readonly RunEvent[],
): void {
  if (!Number.isSafeInteger(previousSequence) || !Number.isSafeInteger(nextSequence)
    || nextSequence < previousSequence)
    throw new TypeError('Agent run 事件序号不能回退')
  if (events.length === 0) {
    if (nextSequence !== previousSequence) throw new TypeError('Agent run checkpoint 序号与事件不一致')
    return
  }
  if (events.length !== 1 || nextSequence !== previousSequence + 1
    || events[0]!.sequence !== nextSequence || !sameIdentity(identity, events[0]!.identity))
    throw new TypeError('Agent run checkpoint 序号与事件不一致')
}

/** PostgreSQL RunStore：加密保存完整 checkpoint/outbox，并以租约 fencing + version CAS 原子写入。 */
export function createPostgresAgentRunStore<C>(
  pool: Pick<Pool, 'connect' | 'query'>,
  secretKey: string,
  options: AgentRunStoreOptions<C>,
): RunStore<C> & { readEventsAfter(identity: RunIdentity, sequence: number): Promise<readonly RunEvent[]>; readForUpdate(client: PoolClient, identity: RunIdentity): Promise<RunCheckpoint<C> | null> } {
  const codec = createAgentRunCodec(secretKey)
  const decodeCheckpoint = (identity: RunIdentity, row: StoredCheckpoint | undefined): RunCheckpoint<C> | null =>
    row ? codec.decryptCheckpoint<C>(identity, Number(row.version), row.nonce, row.payload) : null

  async function loadEvents(identity: RunIdentity, after: number | null): Promise<readonly RunEvent[]> {
    validateIdentity(identity)
    const result = after === null
      ? await pool.query<StoredEvent>(`SELECT event_id, sequence, nonce, payload
         FROM agent_run_events
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND acknowledged_at IS NULL
         ORDER BY sequence ASC`, [identity.ownerId, sessionNumber(identity.sessionId), identity.runId])
      : await pool.query<StoredEvent>(`SELECT event_id, sequence, nonce, payload FROM agent_run_events
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND sequence > $4
         ORDER BY sequence ASC LIMIT 256`, [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, after])
    return result.rows.map(row => codec.decryptEvent(identity, row.event_id, Number(row.sequence), row.nonce, row.payload))
  }

  return {
    async readForUpdate(client, identity) {
      validateIdentity(identity)
      return withBorrowedPostgresQuery(client, async query => {
        const result = await query.query<StoredCheckpoint>(`${checkpointReadSql} FOR UPDATE`, [identity.ownerId, sessionNumber(identity.sessionId), identity.runId])
        return decodeCheckpoint(identity, result.rows[0])
      })
    },
    async read(identity) {
      validateIdentity(identity)
      const result = await pool.query<StoredCheckpoint>(
        checkpointReadSql,
        [identity.ownerId, sessionNumber(identity.sessionId), identity.runId],
      )
      return decodeCheckpoint(identity, result.rows[0])
    },

    async create(checkpoint, lease, events) {
      assertCheckpointIdentity(checkpoint.identity, checkpoint)
      if (checkpoint.version !== 0) throw new TypeError('Agent run 初始 checkpoint 版本必须为 0')
      const identity = checkpoint.identity
      assertEventTransition(identity, 0, checkpoint.sequence, events)
      const encrypted = codec.encryptCheckpoint(checkpoint)
      await withPostgresTransaction(pool, async (client) => {
        if (!await lockAgentRunSession(client, identity) || await agentRunStartupFailed(client, identity)) throw new RunStoreRejected('conflict')
        await assertLease(client, identity, lease)
        await client.query(
          `INSERT INTO agent_run_checkpoints (
             user_id, session_id, run_id, version, sequence, status, phase,
             nonce, payload, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp(), clock_timestamp())`,
          [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, checkpoint.version,
            checkpoint.sequence, checkpoint.status, checkpoint.phase, encrypted.nonce, encrypted.payload],
        )
        await insertEvents(client, codec, identity, events)
        if (checkpoint.context !== null && options.applyPreparedContext)
          await options.applyPreparedContext(client, identity, checkpoint.context)
      }, (error) => isPostgresUniqueViolation(error) ? new RunStoreRejected('conflict') : error)
    },

    async commit(change) {
      assertCheckpointIdentity(change.identity, change.checkpoint)
      if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0
        || change.checkpoint.version !== change.expectedVersion + 1)
        throw new TypeError('Agent run checkpoint CAS 版本无效')
      const identity = change.identity
      const encrypted = codec.encryptCheckpoint(change.checkpoint)
      await withPostgresTransaction(pool, async (client) => {
        // 与租约获取和释放保持一致的 session → lease → checkpoint 锁顺序。
        if (!await lockAgentRunSession(client, identity)) throw new RunStoreRejected('lease_lost')
        await assertLease(client, identity, change.lease)
        const current = await client.query<{ version: string | number; sequence: string | number; nonce: Buffer; payload: Buffer }>(
          `SELECT version, sequence, nonce, payload FROM agent_run_checkpoints
           WHERE user_id = $1 AND session_id = $2 AND run_id = $3
           FOR UPDATE`,
          [identity.ownerId, sessionNumber(identity.sessionId), identity.runId],
        )
        if (!current.rows[0]) throw new RunStoreRejected('not_found')
        if (Number(current.rows[0].version) !== change.expectedVersion)
          throw new RunStoreRejected('conflict')
        assertEventTransition(
          identity,
          Number(current.rows[0].sequence),
          change.checkpoint.sequence,
          change.events,
        )

        if (change.interactionReceipt !== null) {
          await client.query(
            `INSERT INTO agent_run_interaction_receipts (
               user_id, session_id, run_id, receipt, created_at
             ) VALUES ($1, $2, $3, $4, clock_timestamp())`,
            [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, change.interactionReceipt],
          )
        }

        const updated = await client.query(
          `UPDATE agent_run_checkpoints
           SET version = $4, sequence = $5, status = $6, phase = $7,
               nonce = $8, payload = $9, updated_at = clock_timestamp()
           WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND version = $10`,
          [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, change.checkpoint.version,
            change.checkpoint.sequence, change.checkpoint.status, change.checkpoint.phase,
            encrypted.nonce, encrypted.payload, change.expectedVersion],
        )
        if (updated.rowCount !== 1) throw new RunStoreRejected('conflict')
        await insertEvents(client, codec, identity, change.events)
        if (change.checkpoint.context !== null && options.applyPreparedContext) {
          const previous = codec.decryptCheckpoint<C>(identity, Number(current.rows[0].version), current.rows[0].nonce, current.rows[0].payload)
          if (previous.context === null)
            await options.applyPreparedContext(client, identity, change.checkpoint.context)
        }
        if (change.history !== null)
          await options.writeHistory(client, identity, change.history, change.checkpoint)
      }, (error) => isPostgresUniqueViolation(error) ? new RunStoreRejected('conflict') : error)
    },

    async pendingEvents(identity) {
      return loadEvents(identity, null)
    },

    async readEventsAfter(identity, sequence) {
      validateIdentity(identity)
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Agent run 事件序号无效')
      return loadEvents(identity, sequence)
    },

    async acknowledgeEvents(identity, ids) {
      validateIdentity(identity)
      if (ids.length === 0) return
      await pool.query(
        `UPDATE agent_run_events SET acknowledged_at = clock_timestamp()
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3
           AND event_id = ANY($4::text[]) AND acknowledged_at IS NULL`,
        [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, [...new Set(ids)]],
      )
    },
  }
}
