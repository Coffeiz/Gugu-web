import { ImGatewayAdmissionError, imAdmissionKeys, requireImAdmissionId as id } from '@gugu/gateway'
export { ImGatewayAdmissionError } from '@gugu/gateway'
import { createHmac, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { stableJson } from '@gugu/core/agent'
import type { ImPreflightScope } from '@gugu/gateway'
import { normalizeOwnerId } from '../../../../shared/owner-context.js'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import type { NodeImBotBinding } from './inbox.js'

export interface ImGatewayAdmissionInput {
  scope: ImPreflightScope; text: string; hasPendingMedia: boolean
  quotedText?: string | null
  /** 仅原生file/resource/message标识；临时URL、context token和下载凭据不进入语义指纹。 */
  mediaIds?: readonly string[]
}
export type ImGatewayAdmission = { status: 'first'; token: string; receivedAt: string; controlEventId: string }
  | { status: 'admitted' | 'consumed'; receivedAt: string; controlEventId: string }
export interface ImGatewayAdmissionPort {
  begin(input: ImGatewayAdmissionInput): Promise<ImGatewayAdmission>
  finish(scope: ImPreflightScope, token: string, result: 'enqueue' | 'consumed'): Promise<void>
  markUnknown(scope: ImPreflightScope, token: string): Promise<void>
}
/** 永久保存控制分流事实；不保存正文/凭据、不按短TTL重新解释旧事件、不自动重做不确定副作用。 */
export function createPostgresImGatewayAdmission(options: {
  pool: Pick<Pool, 'connect'>; secretKey: string
  supportedPlatforms(): readonly string[] | Promise<readonly string[]>
}) {
  if (!options.secretKey) throw new ImGatewayAdmissionError('invalid_input')
  const digest = (value: unknown) => createHmac('sha256', options.secretKey).update('gugu-im-gateway-admission-v1\0').update(stableJson(value)).digest('hex')
  const safe = (error: unknown) => error instanceof ImGatewayAdmissionError ? error : new ImGatewayAdmissionError('unavailable')
  function key(scope: ImPreflightScope) {
    try {
      const owner = normalizeOwnerId(scope.ownerId), bot = Number(scope.botId)
      if (owner !== scope.ownerId || !/^[1-9]\d*$/u.test(scope.botId) || !Number.isSafeInteger(bot) || bot > 2147483647)
        throw new Error()
      const { scopeHash, eventHash } = imAdmissionKeys(scope, digest)
      return [owner, scope.platform, bot, scope.chatType, scopeHash, eventHash] as const
    } catch { throw new ImGatewayAdmissionError('invalid_input') }
  }
  async function change(scope: ImPreflightScope, token: string, state: 'admitted' | 'consumed' | 'unknown') {
    const parameters = key(scope); id(token, 128)
    try {
      await withPostgresTransaction(options.pool, async client => {
        const updated = await client.query(`UPDATE gugu_im_gateway_admissions SET state=$8,token=NULL,updated_at=clock_timestamp()
          WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND chat_type=$4 AND scope_hash=$5 AND event_hash=$6 AND token=$7 AND state='pending'`,
        [...parameters, token, state])
        if (updated.rowCount !== 1) throw new ImGatewayAdmissionError('conflict')
      }, safe)
    } catch (error) { throw safe(error) }
  }
  return {
    async begin(input: ImGatewayAdmissionInput): Promise<ImGatewayAdmission> {
      const parameters = key(input.scope)
      const controlEventId = digest(['control-event', ...parameters])
      if (typeof input.text !== 'string' || input.text.length > 1_048_576 || typeof input.hasPendingMedia !== 'boolean'
        || input.quotedText != null && (typeof input.quotedText !== 'string' || input.quotedText.length > 1_048_576)
        || input.mediaIds !== undefined && (!Array.isArray(input.mediaIds) || input.mediaIds.length > 256)) throw new ImGatewayAdmissionError('invalid_input')
      const media = (input.mediaIds ?? []).map(value => id(value))
      const fingerprint = digest([input.text, input.quotedText ?? null, input.hasPendingMedia, media])
      try {
        if (!(await options.supportedPlatforms()).includes(input.scope.platform)) throw new ImGatewayAdmissionError('unauthorized')
        return await withPostgresTransaction(options.pool, async client => {
          const authorized = await client.query(`SELECT 1 FROM user_bots b JOIN users u ON u.id=b.user_id
            WHERE b.id=$3 AND b.user_id=$1 AND b.platform=$2 AND b.enabled IS TRUE AND u.is_active IS TRUE
              AND COALESCE(u.account_status,'active')='active'
              AND ($4::text<>'group' OR CASE WHEN b.platform='feishu' THEN b.feishu_group_chat_enabled IS DISTINCT FROM FALSE
                WHEN b.platform IN ('qq','telegram') THEN b.group_chat_enabled IS TRUE ELSE FALSE END)`, parameters.slice(0, 4))
          if (authorized.rowCount !== 1) throw new ImGatewayAdmissionError('unauthorized')
          const token = randomUUID()
          const inserted = await client.query<{ received_at: string }>(`INSERT INTO gugu_im_gateway_admissions
            (user_id,platform,bot_id,chat_type,scope_hash,event_hash,fingerprint,state,token)
            VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8) ON CONFLICT DO NOTHING RETURNING first_received_at::text AS received_at`, [...parameters, fingerprint, token])
          if (inserted.rowCount === 1) {
            const receivedAt = id(inserted.rows[0]?.received_at, 128)
            return { status: 'first' as const, token, receivedAt, controlEventId }
          }
          const selected = await client.query<{ fingerprint: string; state: string; received_at: string }>(`SELECT fingerprint,state,first_received_at::text AS received_at FROM gugu_im_gateway_admissions
            WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND chat_type=$4 AND scope_hash=$5 AND event_hash=$6 FOR UPDATE`, [...parameters])
          if (selected.rows.length !== 1) throw new ImGatewayAdmissionError('conflict')
          const row = selected.rows[0]!
          if (row.fingerprint !== fingerprint) throw new ImGatewayAdmissionError('conflict')
          if (row.state === 'pending' || row.state === 'unknown') throw new ImGatewayAdmissionError(row.state)
          if (row.state !== 'admitted' && row.state !== 'consumed') throw new ImGatewayAdmissionError('conflict')
          return { status: row.state, receivedAt: id(row.received_at, 128), controlEventId }
        }, safe)
      } catch (error) { throw safe(error) }
    },
    finish(scope: ImPreflightScope, token: string, result: 'enqueue' | 'consumed') {
      if (!['enqueue', 'consumed'].includes(result)) throw new ImGatewayAdmissionError('invalid_input')
      return change(scope, token, result === 'enqueue' ? 'admitted' : 'consumed')
    },
    markUnknown: (scope: ImPreflightScope, token: string) => change(scope, token, 'unknown'),
    /** 供Gateway健康观察；pending与unknown均不能自动重新执行控制。 */
    async health(binding: NodeImBotBinding): Promise<{ pending: number; unknown: number }> {
      const parameters = key({ ...binding, chatType: 'c2c', chatId: null, platformUserId: 'health', eventId: 'health' })
      try {
        return await withPostgresTransaction(options.pool, async client => {
          const rows = await client.query<{ state: string; count: string }>(`SELECT state,count(*)::text AS count FROM gugu_im_gateway_admissions
            WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND state IN ('pending','unknown') GROUP BY state`, parameters.slice(0, 3))
          const count = (state: string) => {
            const value = Number(rows.rows.find(row => row.state === state)?.count ?? 0)
            if (!Number.isSafeInteger(value) || value < 0) throw new ImGatewayAdmissionError('unavailable')
            return value
          }
          return { pending: count('pending'), unknown: count('unknown') }
        }, safe)
      } catch (error) { throw safe(error) }
    },
  }
}
