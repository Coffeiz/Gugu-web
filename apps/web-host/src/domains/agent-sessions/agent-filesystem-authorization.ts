import { createHmac } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { withPostgresTransaction } from '../../adapters/postgres-transaction.js'

const SUBJECT_TYPE = 'session'
const AUTHORIZATION_SCOPE = 'user_sandbox'
const AUTHORIZATION_PERMISSION = 'read_write'
const CONFIRMATION_TTL_MINUTES = 10

export interface FilesystemAuthorizationConfirmationPort {
  revoke(ownerId: string, summary: string, identity: string): Promise<boolean>
  createPending(ownerId: string, summary: string, identity: string, ttlMinutes: number): Promise<string | null>
  redeem(ownerId: string, code: string): Promise<boolean>
  hasGrant(ownerId: string, summary: string, identity: string): Promise<boolean>
}

export const unavailableFilesystemAuthorizationConfirmations: FilesystemAuthorizationConfirmationPort = {
  async revoke() { return false },
  async createPending() { return null },
  async redeem() { return false },
  async hasGrant() { return false },
}

export interface AgentFilesystemAuthorizationRuntime {
  enabled(): boolean
  secretKey: string
  terminateActivePty(terminalId: string): Promise<void>
  now?(): Date
}

export class AgentFilesystemAuthorizationError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'AgentFilesystemAuthorizationError'
  }
}

interface SessionRow extends QueryResultRow {
  id: number
  title: string | null
}

interface GrantRow extends QueryResultRow {
  id: number
}

function sessionSummary(session: SessionRow): string {
  return `允许会话「${session.title || '当前会话'}」读写整个用户沙箱（包含 /workspace、/personal、/project）`
}

function confirmationIdentity(sessionId: number): string {
  return `session:filesystem:${sessionId}`
}

function fingerprint(value: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(value, 'utf8').digest('hex')
}

async function findOwnedSession(
  queryable: Pick<Pool, 'query'> | PoolClient,
  ownerId: string,
  sessionId: number,
  lock = false,
): Promise<SessionRow | null> {
  const result = await queryable.query<SessionRow>(
    `SELECT id, title FROM conversation_sessions
     WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [sessionId, ownerId],
  )
  return result.rows[0] ?? null
}

async function activeGrant(
  queryable: Pick<Pool, 'query'> | PoolClient,
  ownerId: string,
  sessionId: number,
  now: Date,
  lock = false,
): Promise<GrantRow | null> {
  const result = await queryable.query<GrantRow>(
    `SELECT id FROM filesystem_authorization_grants
     WHERE user_id = $1 AND subject_type = $2 AND subject_id = $3
       AND scope = $4 AND permission = $5 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > $6)
     ORDER BY id DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [ownerId, SUBJECT_TYPE, String(sessionId), AUTHORIZATION_SCOPE, AUTHORIZATION_PERMISSION, now],
  )
  return result.rows[0] ?? null
}

async function appendSecurityEvent(
  client: PoolClient,
  runtime: AgentFilesystemAuthorizationRuntime,
  ownerId: string,
  sessionId: number,
  outcome: 'requested' | 'granted' | 'revoked',
  grantId?: number,
): Promise<void> {
  const occurredAt = runtime.now?.() ?? new Date()
  const metadata: Record<string, string> = {
    subject_type: SUBJECT_TYPE,
    subject_id: String(sessionId),
    scope: AUTHORIZATION_SCOPE,
    operation: 'authorization',
    outcome,
    source: 'user',
  }
  if (grantId !== undefined) metadata.grant_id = String(grantId)
  await client.query(
    `INSERT INTO security_events (
       user_id, event_type, resource_type, resource_fingerprint, owner_fingerprint,
       client_fingerprint, ip_fingerprint, user_agent_fingerprint, action, reason_code,
       metadata_json, occurred_at, expires_at
     ) VALUES ($1, 'filesystem.authorization', 'filesystem:session', $2, NULL,
               NULL, NULL, NULL, 'logged', $3, $4::jsonb, $5::timestamptz,
               $5::timestamptz + interval '90 days')`,
    [ownerId, fingerprint(String(sessionId), runtime.secretKey), outcome, JSON.stringify(metadata), occurredAt],
  )
}

function notFound(): AgentFilesystemAuthorizationError {
  return new AgentFilesystemAuthorizationError(404, '会话不存在')
}

function ensureEnabled(runtime: AgentFilesystemAuthorizationRuntime): void {
  if (!runtime.enabled())
    throw new AgentFilesystemAuthorizationError(409, '完整用户沙箱授权功能当前未开启')
}

/** 与 Python 会话路由保持一致的所有者隔离、确认和授权生命周期。 */
export function createAgentSessionFilesystemAuthorization(
  pool: Pool,
  confirmations: FilesystemAuthorizationConfirmationPort,
  runtime: AgentFilesystemAuthorizationRuntime,
) {
  return {
    async request(ownerId: string, sessionId: number): Promise<unknown> {
      const session = await findOwnedSession(pool, ownerId, sessionId)
      if (!session) throw notFound()
      ensureEnabled(runtime)
      const now = runtime.now?.() ?? new Date()
      if (await activeGrant(pool, ownerId, sessionId, now))
        return { status: 'authorized', session_id: sessionId }

      const summary = sessionSummary(session)
      const identity = confirmationIdentity(sessionId)
      // 清理旧确认状态，避免新申请被误判为已经授权。
      await confirmations.revoke(ownerId, summary, identity)
      const code = await confirmations.createPending(
        ownerId, summary, identity, CONFIRMATION_TTL_MINUTES,
      )
      if (!code)
        throw new AgentFilesystemAuthorizationError(503, '确认服务暂不可用，请稍后重试')

      await withPostgresTransaction(pool, async (client) => {
        const owned = await findOwnedSession(client, ownerId, sessionId, true)
        if (!owned) throw notFound()
        await appendSecurityEvent(client, runtime, ownerId, sessionId, 'requested')
      })
      return {
        status: 'waiting_confirmation',
        needs_confirm: true,
        summary,
        instruction: '确认后，该会话中的 Shell 每次运行都可读写用户沙箱；不包含宿主机目录。',
        authorization_ttl_minutes: CONFIRMATION_TTL_MINUTES,
        confirm_code: code,
      }
    },

    async confirm(ownerId: string, sessionId: number, confirmCode: string): Promise<unknown> {
      const session = await findOwnedSession(pool, ownerId, sessionId)
      if (!session) throw notFound()
      ensureEnabled(runtime)
      const summary = sessionSummary(session)
      const identity = confirmationIdentity(sessionId)
      if (!await confirmations.redeem(ownerId, confirmCode)
        || !await confirmations.hasGrant(ownerId, summary, identity)) {
        throw new AgentFilesystemAuthorizationError(400, '授权确认已失效或不匹配，请重新确认')
      }

      return withPostgresTransaction(pool, async (client) => {
        const owned = await findOwnedSession(client, ownerId, sessionId, true)
        if (!owned) throw notFound()
        const current = runtime.now?.() ?? new Date()
        const existing = await activeGrant(client, ownerId, sessionId, current, true)
        if (existing)
          return { status: 'authorized', session_id: sessionId, grant_id: existing.id }
        const inserted = await client.query<GrantRow>(
          `INSERT INTO filesystem_authorization_grants (
             user_id, subject_type, subject_id, scope, permission, granted_by,
             granted_at, expires_at, revoked_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'user', $6, NULL, NULL, $6, $6)
           RETURNING id`,
          [ownerId, SUBJECT_TYPE, String(sessionId), AUTHORIZATION_SCOPE, AUTHORIZATION_PERMISSION, current],
        )
        const grantId = inserted.rows[0]?.id
        if (!grantId) throw new Error('Filesystem authorization grant insert failed')
        await appendSecurityEvent(client, runtime, ownerId, sessionId, 'granted', grantId)
        return { status: 'authorized', session_id: sessionId, grant_id: grantId }
      })
    },

    async revoke(ownerId: string, sessionId: number): Promise<unknown> {
      const session = await findOwnedSession(pool, ownerId, sessionId)
      if (!session) throw notFound()
      const summary = sessionSummary(session)
      await confirmations.revoke(ownerId, summary, confirmationIdentity(sessionId))

      const revoked = await withPostgresTransaction(pool, async (client) => {
        const owned = await findOwnedSession(client, ownerId, sessionId, true)
        if (!owned) throw notFound()
        const now = runtime.now?.() ?? new Date()
        const grant = await activeGrant(client, ownerId, sessionId, now, true)
        if (!grant) return false
        const terminals = await client.query<{ id: string } & QueryResultRow>(
          `SELECT id::text AS id FROM terminal_sessions
           WHERE owner_id = $1 AND session_id = $2 AND mode = 'interactive-pty'
             AND closed_at IS NULL`,
          [ownerId, sessionId],
        )
        for (const terminal of terminals.rows)
          await runtime.terminateActivePty(terminal.id)
        await client.query(
          `UPDATE terminal_sessions
           SET status = 'terminated', pty_pid = NULL, pty_sandbox_id = NULL,
               pty_cols = NULL, pty_rows = NULL, closed_at = $3, updated_at = $3
           WHERE owner_id = $1 AND session_id = $2 AND mode = 'interactive-pty'
             AND closed_at IS NULL`,
          [ownerId, sessionId, now],
        )
        await client.query(
          'UPDATE filesystem_authorization_grants SET revoked_at = $2, updated_at = $2 WHERE id = $1',
          [grant.id, now],
        )
        await appendSecurityEvent(client, runtime, ownerId, sessionId, 'revoked', grant.id)
        return true
      })
      return { status: 'revoked', session_id: sessionId, revoked }
    },
  }
}
