import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { createConfirmationGate, type ConfirmationBinding, type ConfirmationTargetSnapshot } from '@gugu/core/tools'
import type { RunIdentity } from '@gugu/core/agent'
import type { Database } from '@gugu/core/data'
import { sql, type Transaction } from 'kysely'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import type { AgentDispatchLease } from '../run/dispatch.js'
import type { createPostgresTrustedIntentStore } from '../interactions/intents.js'
import type { TrustedPromptIntent } from '../interactions/prompts.js'
import type { ConfirmationContext } from './identity.js'

type TrustedIntentStore = ReturnType<typeof createPostgresTrustedIntentStore>

export interface WebAgentConfirmationDescription {
  summary: string
  context?: ConfirmationContext
}

export interface WebAgentToolConfirmationOptions {
  pool: Pick<Pool, 'connect'>
  intents: TrustedIntentStore
  lease: AgentDispatchLease
  action: string
  imOwnerAuthorized?: boolean
  ttlMinutes?: number
  now?: () => number
  /** 必须复核当前 owner 权限与 lease，并返回权限版本；无权限时返回 null。 */
  authorize(binding: ConfirmationBinding, signal: AbortSignal): Promise<string | null>
  /** 与业务事务共用的权限复核，返回值必须等于准备阶段的权限版本。 */
  authorizeInTransaction(tx: Transaction<Database>, binding: ConfirmationBinding, signal: AbortSignal): Promise<string | null>
  /** 摘要只使用 Host 读取的业务信息；目标 ID 与版本始终来自 Core 快照。 */
  describe(binding: ConfirmationBinding, snapshot: ConfirmationTargetSnapshot, signal: AbortSignal): Promise<WebAgentConfirmationDescription>
}

function sameRun(left: RunIdentity, right: RunIdentity): boolean {
  return left.ownerId === right.ownerId && left.sessionId === right.sessionId && left.runId === right.runId
}

interface ConfirmationAuthorityRow {
  security_version: number | string | null
  is_active: boolean
  account_status: string | null
}

/** 固定运行身份，并在确认准备和领域事务中复核账号、会话及当前执行租约。 */
export function createWebAgentConfirmationAuthorization(options: {
  pool: Pick<Pool, 'query'>
  lease: AgentDispatchLease
  accessVersion(identity: RunIdentity): Promise<string>
}) {
  const identity = Object.freeze({ ...options.lease.identity })
  const authorized = (binding: RunIdentity) => binding.ownerId === identity.ownerId
    && binding.sessionId === identity.sessionId && binding.runId === identity.runId
  const epoch = async (row: ConfirmationAuthorityRow, signal: AbortSignal) => {
    if (!row.is_active || (row.account_status ?? 'active') !== 'active') return null
    const accessVersion = await options.accessVersion(identity)
    signal.throwIfAborted()
    if (!accessVersion || accessVersion.length > 192) return null
    return `${String(row.security_version ?? 0)}:${accessVersion}`
  }
  const select = `SELECT u.security_version,u.is_active,u.account_status
    FROM users u
    JOIN conversation_sessions s ON s.user_id=u.id AND s.id=$2 AND s.active_run_id=$3
    JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id AND d.run_id=s.active_run_id
      AND d.state='selected' AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()
    WHERE u.id=$1 AND EXISTS (SELECT 1 FROM agent_run_leases l
      WHERE l.user_id=s.user_id AND l.session_id=s.id AND l.run_id=s.active_run_id AND l.expires_at>clock_timestamp())`
  return {
    async authorize(binding: ConfirmationBinding, signal: AbortSignal): Promise<string | null> {
      signal.throwIfAborted()
      if (!authorized(binding)) return null
      const result = await options.pool.query<ConfirmationAuthorityRow>(select,
        [identity.ownerId, identity.sessionId, identity.runId, options.lease.token, options.lease.fence])
      signal.throwIfAborted()
      const row = result.rows[0]
      return row ? epoch(row, signal) : null
    },
    async authorizeInTransaction(tx: Transaction<Database>, binding: RunIdentity, signal: AbortSignal): Promise<string | null> {
      signal.throwIfAborted()
      if (!authorized(binding)) return null
      const result = await sql<ConfirmationAuthorityRow>`SELECT u.security_version,u.is_active,u.account_status
        FROM users u
        JOIN conversation_sessions s ON s.user_id=u.id AND s.id=${identity.sessionId} AND s.active_run_id=${identity.runId}
        JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id AND d.run_id=s.active_run_id
          AND d.state='selected' AND d.token=${options.lease.token} AND d.fence=${options.lease.fence} AND d.lease_expires_at>clock_timestamp()
        WHERE u.id=${identity.ownerId} AND EXISTS (SELECT 1 FROM agent_run_leases l
          WHERE l.user_id=s.user_id AND l.session_id=s.id AND l.run_id=s.active_run_id AND l.expires_at>clock_timestamp())`.execute(tx)
      signal.throwIfAborted()
      const row = result.rows[0]
      return row ? epoch(row, signal) : null
    },
  }
}

function checkedTargets(snapshot: ConfirmationTargetSnapshot): Record<string, readonly (number | string)[]> {
  if (!/^[a-f0-9]{64}$/u.test(snapshot.targetsDigest) || !/^[a-f0-9]{64}$/u.test(snapshot.versionsDigest))
    throw new TypeError('可信确认目标快照无效')
  const numeric = Object.entries(snapshot.targetIds ?? {})
  const strings = Object.entries(snapshot.targetRefs ?? {})
  for (const [kind, ids] of numeric) {
    if (!kind.trim() || !Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length)
      throw new TypeError('可信确认目标 ID 无效')
  }
  for (const [kind, refs] of strings) {
    if (!kind.trim() || Object.hasOwn(snapshot.targetIds ?? {}, kind) || !Array.isArray(refs)
      || refs.some(ref => typeof ref !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(ref)) || new Set(refs).size !== refs.length)
      throw new TypeError('可信确认目标引用无效')
  }
  const entries: Array<[string, readonly (number | string)[]]> = [...numeric, ...strings]
  if (!entries.some(([, ids]) => ids.length)) throw new TypeError('可信确认目标快照为空')
  return Object.fromEntries(entries.map(([kind, ids]) => [kind, [...ids]]))
}

/**
 * 把 Core 确认 gate 接到 Web 的加密意图仓储和 PostgreSQL 一次性 claim。
 * 生产调用方必须提供会话权限复核和基于同一事务的再授权，不能传恒真回调。
 */
export function createWebAgentToolConfirmation(options: WebAgentToolConfirmationOptions) {
  const leaseIdentity = Object.freeze({ ...options.lease.identity })
  const ttlMinutes = options.ttlMinutes ?? 5
  const now = options.now ?? Date.now
  const source = options.lease.input
  const sourceAllowed = source.v === 2 && source.source === 'web'
    || source.v === 3 && source.source === 'im' && source.im.chatType === 'c2c'
      && source.im.platform !== 'wechat' && options.imOwnerAuthorized === true
  if (!sourceAllowed || !options.action.trim() || options.action.length > 128
    || !Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 30
    || typeof options.authorize !== 'function' || typeof options.authorizeInTransaction !== 'function'
    || typeof options.describe !== 'function') throw new TypeError('Web Agent 可信确认能力未完整配置')

  const allowed = (binding: ConfirmationBinding) => binding.ownerId === leaseIdentity.ownerId
    && binding.sessionId === leaseIdentity.sessionId && binding.runId === leaseIdentity.runId
  const authorize = async (binding: ConfirmationBinding, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (!allowed(binding)) return null
    const epoch = await options.authorize(binding, signal)
    signal.throwIfAborted()
    return typeof epoch === 'string' && epoch.length > 0 && epoch.length <= 256 ? epoch : null
  }

  const gate = createConfirmationGate({
    now,
    authorize: async (binding, purpose, action, signal) => purpose === 'action' && action === options.action
      ? authorize(binding, signal) : null,
    async prepare(binding, snapshot, signal) {
      signal.throwIfAborted()
      if (!allowed(binding)) throw new Error('确认运行身份不匹配')
      const targets = checkedTargets(snapshot)
      const description = await options.describe(binding, snapshot, signal)
      signal.throwIfAborted()
      const summary = description.summary.trim()
      if (!summary || summary.length > 1000) throw new TypeError('可信确认摘要无效')
      const authorizationEpoch = await authorize(binding, signal)
      if (!authorizationEpoch) throw new Error('可信确认权限已撤销')
      const createdAt = now()
      if (!Number.isFinite(createdAt)) throw new TypeError('可信确认时间无效')
      const expiresAt = createdAt + ttlMinutes * 60_000
      const intent = {
        schemaVersion: 2 as const,
        binding,
        intentId: randomUUID(),
        interactionId: randomUUID(),
        operationId: randomUUID(),
        purpose: 'action' as const,
        action: options.action,
        targetsDigest: snapshot.targetsDigest,
        versionsDigest: snapshot.versionsDigest,
        authorizationEpoch,
        expiresAt,
      }
      const trusted: TrustedPromptIntent = {
        kind: 'confirmation',
        summary,
        action: options.action,
        targets,
        ...(description.context ? { context: {
          ...description.context,
          targets_digest: snapshot.targetsDigest,
          versions_digest: snapshot.versionsDigest,
        } } : { context: { targets_digest: snapshot.targetsDigest, versions_digest: snapshot.versionsDigest } }),
        ttlMinutes,
        operation: { intent, snapshot: { targetsDigest: snapshot.targetsDigest, versionsDigest: snapshot.versionsDigest,
          targetIds: snapshot.targetIds, targetRefs: snapshot.targetRefs } },
      }
      const request = {
        id: intent.interactionId,
        kind: 'confirmation' as const,
        toolCall: { id: binding.toolCallId, name: binding.toolName, input: {} },
      }
      await withPostgresTransaction(options.pool, client => options.intents.saveIntent(
        client, leaseIdentity, request, trusted, new Date(expiresAt),
      ))
      signal.throwIfAborted()
      return intent
    },
    async load(binding, receipt, signal) {
      signal.throwIfAborted()
      if (!allowed(binding)) return null
      return withPostgresTransaction(options.pool, client => options.intents.loadApprovedOperation(
        client, binding, receipt.interactionId, receipt.receiptId,
      ))
    },
    async inspect(reference, binding, signal) {
      signal.throwIfAborted()
      if (!allowed(binding)) return null
      const operation = await withPostgresTransaction(options.pool, client => options.intents.loadOperation(
        client, binding, reference.interactionId,
      ))
      signal.throwIfAborted()
      return operation ? { targetsDigest: operation.intent.targetsDigest, versionsDigest: operation.intent.versionsDigest } : null
    },
  }, { purpose: 'action', action: options.action })

  return {
    gate,
    async authorizeDirect(tx: Transaction<Database>, binding: ConfirmationBinding, signal: AbortSignal): Promise<boolean> {
      if (!allowed(binding) || binding.toolName !== options.action) return false
      const epoch = await options.authorizeInTransaction(tx, binding, signal)
      signal.throwIfAborted()
      return epoch !== null && epoch.endsWith(`:${options.lease.input.accessVersion}`)
    },
    claim(tx: Transaction<Database>, reference: Parameters<TrustedIntentStore['claimApprovedOperation']>[1], signal: AbortSignal) {
      if (!allowed(reference.binding)) return Promise.resolve(false)
      return options.intents.claimApprovedOperation(tx, reference, signal, async (transaction, candidate, candidateSignal) => {
        candidateSignal.throwIfAborted()
        if (!allowed(candidate.binding)) return false
        const epoch = await options.authorizeInTransaction(transaction, candidate.binding, candidateSignal)
        candidateSignal.throwIfAborted()
        return typeof epoch === 'string' && epoch === candidate.authorizationEpoch
      })
    },
  }
}
