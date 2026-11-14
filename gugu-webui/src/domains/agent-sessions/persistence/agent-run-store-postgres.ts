import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { RunStoreRejected } from '@gugu/core/harness'
import type { Lease, RunCheckpoint, RunEvent, RunIdentity, RunStore } from '@gugu/core/harness'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import { isPostgresUniqueViolation } from '../../../adapters/postgres-errors.js'

const encryptionInfo = Buffer.from('gugu-agent-run-store-v1', 'utf8')
export interface AgentRunHistoryWrite<C> {
  outcome: 'success' | 'interruption' | 'silent'
  context: C
  text: string
}

export interface AgentRunStoreOptions<C> {
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

function sessionNumber(sessionId: string): number {
  if (!/^[1-9]\d*$/.test(sessionId)) throw new TypeError('Agent 会话身份无效')
  const value = Number(sessionId)
  if (!Number.isSafeInteger(value)) throw new TypeError('Agent 会话身份无效')
  return value
}

function validateIdentity(identity: RunIdentity): void {
  if (!identity.ownerId || !identity.runId || identity.runId.length > 128)
    throw new TypeError('Agent run 身份无效')
  sessionNumber(identity.sessionId)
}

function sameIdentity(left: RunIdentity, right: RunIdentity): boolean {
  return left.ownerId === right.ownerId
    && left.sessionId === right.sessionId
    && left.runId === right.runId
}

function identityAad(identity: RunIdentity, kind: 'checkpoint' | 'event', id: string): Buffer {
  return Buffer.from(`${identity.ownerId}\n${identity.sessionId}\n${identity.runId}\n${kind}\n${id}`, 'utf8')
}

function deriveKey(secretKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.alloc(0), encryptionInfo, 32))
}

function encrypt(secretKey: string, identity: RunIdentity, kind: 'checkpoint' | 'event', id: string, value: unknown) {
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError('Agent run 状态无法序列化')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretKey), nonce)
  cipher.setAAD(identityAad(identity, kind, id))
  const payload = Buffer.concat([cipher.update(json, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { nonce, payload }
}

function decrypt<T>(secretKey: string, identity: RunIdentity, kind: 'checkpoint' | 'event', id: string, nonce: Buffer, payload: Buffer): T {
  if (nonce.length !== 12 || payload.length < 16) throw new Error('Agent run 状态密文无效')
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKey), nonce)
    decipher.setAAD(identityAad(identity, kind, id))
    decipher.setAuthTag(payload.subarray(-16))
    const json = Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString('utf8')
    return JSON.parse(json) as T
  } catch {
    throw new Error('Agent run 状态无法安全解密')
  }
}

function assertCheckpointIdentity<C>(identity: RunIdentity, checkpoint: RunCheckpoint<C>): void {
  validateIdentity(identity)
  if (!sameIdentity(identity, checkpoint.identity)) throw new TypeError('Agent run checkpoint 身份不一致')
  if (!Number.isSafeInteger(checkpoint.version) || checkpoint.version < 0
    || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0)
    throw new TypeError('Agent run checkpoint 版本无效')
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
  secretKey: string,
  identity: RunIdentity,
  events: readonly RunEvent[],
): Promise<void> {
  for (const event of events) {
    if (!sameIdentity(identity, event.identity) || !Number.isSafeInteger(event.sequence) || event.sequence < 1)
      throw new TypeError('Agent run event 身份或序号无效')
    const encrypted = encrypt(secretKey, identity, 'event', event.id, event)
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
): RunStore<C> {
  if (!secretKey) throw new TypeError('Agent run 加密密钥不能为空')

  return {
    async read(identity) {
      validateIdentity(identity)
      const result = await pool.query<StoredCheckpoint>(
        `SELECT version, nonce, payload
         FROM agent_run_checkpoints
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3`,
        [identity.ownerId, sessionNumber(identity.sessionId), identity.runId],
      )
      const row = result.rows[0]
      if (!row) return null
      const checkpoint = decrypt<RunCheckpoint<C>>(secretKey, identity, 'checkpoint', 'current', row.nonce, row.payload)
      assertCheckpointIdentity(identity, checkpoint)
      if (checkpoint.version !== Number(row.version)) throw new Error('Agent run checkpoint 版本不一致')
      return checkpoint
    },

    async create(checkpoint, lease, events) {
      assertCheckpointIdentity(checkpoint.identity, checkpoint)
      if (checkpoint.version !== 0) throw new TypeError('Agent run 初始 checkpoint 版本必须为 0')
      const identity = checkpoint.identity
      assertEventTransition(identity, 0, checkpoint.sequence, events)
      const encrypted = encrypt(secretKey, identity, 'checkpoint', 'current', checkpoint)
      await withPostgresTransaction(pool, async (client) => {
        await assertLease(client, identity, lease)
        await client.query(
          `INSERT INTO agent_run_checkpoints (
             user_id, session_id, run_id, version, sequence, status, phase,
             nonce, payload, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp(), clock_timestamp())`,
          [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, checkpoint.version,
            checkpoint.sequence, checkpoint.status, checkpoint.phase, encrypted.nonce, encrypted.payload],
        )
        await insertEvents(client, secretKey, identity, events)
      }, (error) => isPostgresUniqueViolation(error) ? new RunStoreRejected('conflict') : error)
    },

    async commit(change) {
      assertCheckpointIdentity(change.identity, change.checkpoint)
      if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0
        || change.checkpoint.version !== change.expectedVersion + 1)
        throw new TypeError('Agent run checkpoint CAS 版本无效')
      const identity = change.identity
      const encrypted = encrypt(secretKey, identity, 'checkpoint', 'current', change.checkpoint)
      await withPostgresTransaction(pool, async (client) => {
        await assertLease(client, identity, change.lease)
        const current = await client.query<{ version: string | number; sequence: string | number }>(
          `SELECT version, sequence FROM agent_run_checkpoints
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
        await insertEvents(client, secretKey, identity, change.events)
        if (change.history !== null)
          await options.writeHistory(client, identity, change.history, change.checkpoint)
      }, (error) => isPostgresUniqueViolation(error) ? new RunStoreRejected('conflict') : error)
    },

    async pendingEvents(identity) {
      validateIdentity(identity)
      const result = await pool.query<StoredEvent>(
        `SELECT event_id, sequence, nonce, payload
         FROM agent_run_events
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND acknowledged_at IS NULL
         ORDER BY sequence ASC`,
        [identity.ownerId, sessionNumber(identity.sessionId), identity.runId],
      )
      return result.rows.map((row) => {
        const event = decrypt<RunEvent>(secretKey, identity, 'event', row.event_id, row.nonce, row.payload)
        if (event.id !== row.event_id || event.sequence !== Number(row.sequence)
          || !sameIdentity(identity, event.identity)) throw new Error('Agent run outbox 内容无效')
        return event
      })
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
