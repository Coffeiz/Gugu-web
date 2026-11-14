import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { RunStoreRejected, type Lease, type LeasePort, type RunIdentity } from '@gugu/core/harness'

export interface AgentRunLeaseOptions {
  leaseTtlMs?: number
  renewIntervalMs?: number
}

interface ActiveLease {
  identity: RunIdentity
  lease: Lease
  timer: ReturnType<typeof setTimeout> | null
  stopped: boolean
  renewal: Promise<void> | null
}

function validateOptions(options: AgentRunLeaseOptions) {
  const leaseTtlMs = options.leaseTtlMs ?? 30_000
  const renewIntervalMs = options.renewIntervalMs ?? Math.floor(leaseTtlMs / 3)
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 30
    || !Number.isSafeInteger(renewIntervalMs) || renewIntervalMs < 10
    || renewIntervalMs >= leaseTtlMs)
    throw new RangeError('Agent run 租约时间配置无效')
  return { leaseTtlMs, renewIntervalMs }
}

function identityKey(identity: RunIdentity): string {
  return JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])
}

function sessionNumber(sessionId: string): number {
  if (!/^[1-9]\d*$/.test(sessionId)) throw new TypeError('Agent 会话身份无效')
  const value = Number(sessionId)
  if (!Number.isSafeInteger(value)) throw new TypeError('Agent 会话身份无效')
  return value
}

function validateIdentity(identity: RunIdentity): number {
  if (!identity.ownerId || !identity.runId || identity.runId.length > 128)
    throw new TypeError('Agent run 身份无效')
  return sessionNumber(identity.sessionId)
}

/** 为 owner/session 提供 PostgreSQL fencing 租约；自动续租按进程管理，释放按 token 精确匹配。 */
export function createPostgresAgentRunLeasePort(
  pool: Pick<Pool, 'query'>,
  options: AgentRunLeaseOptions = {},
): LeasePort {
  const { leaseTtlMs, renewIntervalMs } = validateOptions(options)
  const active = new Map<string, ActiveLease>()

  const stopRenewal = (state: ActiveLease) => {
    state.stopped = true
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
  }

  const scheduleRenewal = (key: string, state: ActiveLease) => {
    if (state.stopped) return
    state.timer = setTimeout(() => {
      state.timer = null
      if (state.stopped) return
      const sessionId = sessionNumber(state.identity.sessionId)
      const renewal = pool.query(
        `UPDATE agent_run_leases
         SET expires_at = clock_timestamp() + ($6 * INTERVAL '1 millisecond'),
             updated_at = clock_timestamp()
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3
           AND token = $4 AND fence = $5 AND expires_at > clock_timestamp()
         RETURNING fence`,
        [state.identity.ownerId, sessionId, state.identity.runId, state.lease.token,
          state.lease.fence, leaseTtlMs],
      ).then((result) => {
        if (result.rowCount !== 1) stopRenewal(state)
      }).catch(() => {
        // 续租失败交由 assert() 检出，不能继续续租已丢失的租约。
        stopRenewal(state)
      }).finally(() => {
        state.renewal = null
        if (!state.stopped && active.get(key) === state) scheduleRenewal(key, state)
      })
      state.renewal = renewal
    }, renewIntervalMs)
    state.timer.unref?.()
  }

  return {
    async acquire(identity) {
      const sessionId = validateIdentity(identity)
      const token = randomUUID()
      const result = await pool.query<{ fence: number | string }>(
        `INSERT INTO agent_run_leases (
           user_id, session_id, run_id, token, fence, expires_at, created_at, updated_at
         )
         SELECT $1, session.id, $3, $4, 1,
                clock_timestamp() + ($5 * INTERVAL '1 millisecond'),
                clock_timestamp(), clock_timestamp()
         FROM conversation_sessions AS session
         WHERE session.id = $2 AND session.user_id = $1
         ON CONFLICT (user_id, session_id) DO UPDATE SET
           run_id = EXCLUDED.run_id,
           token = EXCLUDED.token,
           fence = agent_run_leases.fence + 1,
           expires_at = clock_timestamp() + ($5 * INTERVAL '1 millisecond'),
           updated_at = clock_timestamp()
         WHERE agent_run_leases.expires_at <= clock_timestamp()
         RETURNING fence`,
        [identity.ownerId, sessionId, identity.runId, token, leaseTtlMs],
      )
      const row = result.rows[0]
      if (!row) return null
      const key = identityKey(identity)
      const previous = active.get(key)
      if (previous) stopRenewal(previous)
      const fence = Number(row.fence)
      if (!Number.isSafeInteger(fence) || fence < 1)
        throw new RangeError('Agent run fencing 序号超出安全范围')
      const lease = { token, fence }
      const state: ActiveLease = { identity: { ...identity }, lease, timer: null, stopped: false, renewal: null }
      active.set(key, state)
      scheduleRenewal(key, state)
      return lease
    },

    async assert(identity, lease) {
      const sessionId = validateIdentity(identity)
      const result = await pool.query(
        `SELECT 1
         FROM agent_run_leases AS lease
         JOIN conversation_sessions AS session
           ON session.id = lease.session_id AND session.user_id = lease.user_id
         WHERE lease.user_id = $1 AND lease.session_id = $2 AND lease.run_id = $3
           AND lease.token = $4 AND lease.fence = $5
           AND lease.expires_at > clock_timestamp()`,
        [identity.ownerId, sessionId, identity.runId, lease.token, lease.fence],
      )
      if (result.rowCount !== 1) throw new RunStoreRejected('lease_lost')
    },

    async release(identity, lease) {
      const sessionId = validateIdentity(identity)
      const key = identityKey(identity)
      const state = active.get(key)
      if (state && state.lease.token === lease.token && state.lease.fence === lease.fence) {
        stopRenewal(state)
        if (state.renewal) await state.renewal
      }
      await pool.query(
        `UPDATE agent_run_leases
         SET expires_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3
           AND token = $4 AND fence = $5`,
        [identity.ownerId, sessionId, identity.runId, lease.token, lease.fence],
      )
      if (state && active.get(key) === state) active.delete(key)
    },
  }
}
