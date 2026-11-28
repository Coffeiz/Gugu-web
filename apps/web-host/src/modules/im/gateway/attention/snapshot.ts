import type { Pool } from 'pg'
import { attentionMessageFromPayload } from '@gugu/core/im/attention/message'
import type { AttentionMessage, AttentionSnapshot, BotReplyFact } from '@gugu/core/im/attention/types'
import type { RedisCommandClient } from '../../../../workers/redis-stream-queue.js'
import { createImInboundEnvelope } from '../inbound/envelope.js'
import { nodeImAttentionKeys } from '../inbound/inbox.js'
import type { ImPendingAskScope } from '@gugu/gateway'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = () => new Error('群注意力上下文不可用')
const maxRows = 10_000
export interface ImAttentionAcceptedFacts {
  /** 必须来自平台accepted持久事实；assistant历史、pending/unknown收据均不构成事实。 */
  read(scope: ImPendingAskScope, watermarkMs: number, messages: readonly AttentionMessage[], signal: AbortSignal): Promise<readonly BotReplyFact[]>
}
interface InboundRow { id: number; event_ms: string; sealed_payload: unknown }

/** 真实当前Bot/会话授权 + PG已密封用户事实 + Node加密短窗；未知覆盖不能制造负证据。 */
export function createPostgresRedisImAttentionSnapshot(options: {
  pool: Pick<Pool, 'query'>; redis: RedisCommandClient; secretKey: string; postgresInbox?: boolean
  acceptedFacts?: ImAttentionAcceptedFacts
}) {
  const envelope = createImInboundEnvelope(options.secretKey)
  async function authorize(scope: ImPendingAskScope, sessionId: number): Promise<boolean> {
    if (!scope.ownerId || !/^[1-9]\d*$/u.test(scope.botId) || !['qq', 'feishu', 'telegram'].includes(scope.platform)
      || !scope.groupId || !Number.isSafeInteger(sessionId) || sessionId < 1) throw invalid()
    const rows = await options.pool.query(`SELECT 1 FROM user_bots b
      JOIN users u ON u.id=b.user_id
      JOIN conversation_sessions s ON s.user_id=b.user_id AND s.source=b.platform AND s.bot_id=b.id::text
      WHERE b.user_id=$1 AND b.id=$2::integer AND b.platform=$3 AND b.enabled IS TRUE
        AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
        AND (CASE WHEN b.platform='feishu' THEN COALESCE(b.feishu_group_chat_enabled,true) ELSE b.group_chat_enabled END) IS TRUE
        AND s.id=$4 AND s.chat_type='group' AND s.chat_id=$5`, [scope.ownerId, scope.botId, scope.platform, sessionId, scope.groupId])
    return rows.rows.length === 1
  }
  return {
    async load(input: { scope: ImPendingAskScope; sessionId: number; messages: readonly AttentionMessage[]; watermarkMs: number }, signal: AbortSignal): Promise<AttentionSnapshot> {
      const { scope, messages, sessionId, watermarkMs } = input
      signal.throwIfAborted()
      if (!Number.isSafeInteger(watermarkMs) || watermarkMs < 600_000 || !messages.length
        || messages.some(m => m.platform !== scope.platform || m.botId !== scope.botId || m.groupId !== scope.groupId || m.eventReceivedMs > watermarkMs)) throw invalid()
      if (!await authorize(scope, sessionId)) throw invalid()
      const binding = { ownerId: scope.ownerId, botId: scope.botId, platform: scope.platform }
      const cutoff = watermarkMs - 600_000, currentIds = new Set(messages.map(m => m.eventId))
      const nativeKey = (m: AttentionMessage) => JSON.stringify([m.senderId, m.platformMessageId])
      const currentNative = new Set(messages.filter(m => m.platformMessageId).map(nativeKey))
      const history = new Map<string, AttentionMessage>()
      let complete = true, windowTruncated = false
      const scoped = (payload: Record<string, unknown>) => payload.platform === scope.platform && payload.bot_id === scope.botId
        && payload.owner_user_id === scope.ownerId && payload.chat_type === 'group' && payload.chat_id === scope.groupId
      const add = (eventId: string, payload: Record<string, unknown>, historyId?: string) => {
        if (!scoped(payload)) throw invalid()
        if (currentIds.has(eventId)) return
        const parsed = attentionMessageFromPayload(eventId, payload)
        const message = historyId ? { ...parsed, eventId: historyId } : parsed
        if (message.eventReceivedMs < cutoff || message.eventReceivedMs > watermarkMs || currentNative.has(nativeKey(message))) return
        history.set(message.platformMessageId ? nativeKey(message) : message.eventId, message)
      }
      try {
        // 查询边界是真实会话和用户消息收据，不从模型提供的session/group读取历史。
        const rows = await options.pool.query<InboundRow>(`SELECT m.id,m.im_event_received_ms::text AS event_ms,r.sealed_payload
          FROM conversation_messages m JOIN gugu_im_inbound_receipts r ON r.message_id=m.id AND r.session_id=m.session_id
          WHERE r.user_id=$1 AND r.platform=$2 AND r.bot_id=$3 AND r.chat_type='group' AND r.session_id=$4
            AND m.role='user' AND m.im_event_received_ms >= $5 AND m.im_event_received_ms <= $6
          ORDER BY m.im_event_received_ms,m.conversation_seq,m.id LIMIT 10001`, [scope.ownerId, scope.platform, scope.botId, sessionId, cutoff, watermarkMs])
        if (rows.rows.length > maxRows) { complete = false; windowTruncated = true }
        for (const row of rows.rows.slice(0, maxRows)) {
          if (!object(row.sealed_payload)) throw invalid()
          const payload = envelope.open(binding, row.sealed_payload)
          // 旧收据只保存了原时间而没有完整Stream ID。db前缀明确是历史身份，绝不作为可运行候选。
          const received = Number(row.event_ms)
          if (!Number.isSafeInteger(received) || received <= 0) throw invalid()
          // 仅收据密文中的Host覆盖字段可信；persistLocked会覆盖/删除平台同名字段。
          const original = payload._node_stream_event_id
          if (typeof original === 'string' && /^\d+-\d+$/u.test(original) && Number(original.split('-')[0]) === received) add(original, payload)
          else add(`${received}-0`, payload, `db:${row.id}`)
        }
      } catch { complete = false }
      try {
        if (options.postgresInbox) {
          const rows = await options.pool.query<{ id: string; payload: Record<string, unknown>; first_ms: string | null }>(`
            SELECT received_ms || '-' || id AS id,payload,
              (SELECT min(received_ms) FROM gugu_im_inbound_queue
                WHERE user_id=$1 AND bot_id=$2 AND platform=$3 AND group_id=$4
                  AND payload IS NOT NULL
                  AND $5::bigint >= floor(extract(epoch FROM clock_timestamp() - interval '30 minutes') * 1000)) AS first_ms
            FROM gugu_im_inbound_queue
            WHERE user_id=$1 AND bot_id=$2 AND platform=$3 AND group_id=$4
              AND received_ms BETWEEN $5 AND $6 AND payload IS NOT NULL
            ORDER BY received_ms,id LIMIT 10001`,
          [scope.ownerId, scope.botId, scope.platform, scope.groupId, cutoff, watermarkMs])
          if (!rows.rows[0]?.first_ms || Number(rows.rows[0].first_ms) > cutoff || rows.rows.length > maxRows) {
            complete = false
            windowTruncated = true
          }
          for (const row of rows.rows.slice(0, maxRows)) add(row.id, envelope.open(binding, row.payload))
        } else {
          const keys = nodeImAttentionKeys(binding, scope.groupId)
          // 同一Lua读取marker及窗口，避免分开读取期间trim造成虚假完整。数量超过cap明确截断。
          const raw = await options.redis.sendCommand(['EVAL', `return {redis.call('GET',KEYS[2]),redis.call('XRANGE',KEYS[1],ARGV[1],ARGV[2],'COUNT',10001)}`,
            '2', keys.stream, keys.start, `${cutoff}-0`, `${watermarkMs}-18446744073709551615`])
          if (!Array.isArray(raw) || !Array.isArray(raw[1])) throw invalid()
          if (typeof raw[0] !== 'string' || !/^\d+$/u.test(raw[0]) || Number(raw[0]) > cutoff) { complete = false; windowTruncated = true }
          if (raw[1].length > maxRows) { complete = false; windowTruncated = true }
          for (const row of raw[1].slice(0, maxRows)) {
            if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[1])) throw invalid()
            const fields = row[1] as unknown[], idx = fields.indexOf('data')
            if (idx < 0 || typeof fields[idx + 1] !== 'string') throw invalid()
            const sealed: unknown = JSON.parse(fields[idx + 1] as string)
            if (!object(sealed)) throw invalid()
            add(row[0], envelope.open(binding, sealed))
          }
        }
      } catch { complete = false; windowTruncated = true }
      let facts: readonly BotReplyFact[] = []
      if (options.acceptedFacts) {
        try {
          const before = Math.min(...messages.map(m => m.eventReceivedMs))
          const latestMessage = Math.max(...messages.map(m => m.eventReceivedMs))
          facts = (await options.acceptedFacts.read(scope, before, [...history.values(), ...messages], signal))
            .filter(fact => fact.accepted === true && Number.isFinite(fact.sentAtMs) && fact.sentAtMs > 0 && fact.sentAtMs <= latestMessage)
        } catch { complete = false }
      } else complete = false
      signal.throwIfAborted()
      if (!await authorize(scope, sessionId)) throw invalid()
      const botReplies: Record<string, BotReplyFact> = Object.create(null) as Record<string, BotReplyFact>
      for (const message of [...history.values(), ...messages]) {
        if (message.replyTargetIsBot !== true || !message.replyToPlatformMessageId || !message.senderId) continue
        const fact = facts.find(f => f.platformMessageId === message.replyToPlatformMessageId && f.recipientSenderId === message.senderId && f.sentAtMs <= message.eventReceivedMs)
        if (fact) botReplies[message.replyToPlatformMessageId] = fact
      }
      return { messages: [...history.values(), ...messages], complete: complete && messages.every(m => !!m.senderId), windowTruncated,
        botReplies, latestAcceptedFinal: [...facts].filter(f => f.sentAtMs <= Math.min(...messages.map(m => m.eventReceivedMs))).sort((a, b) => b.sentAtMs - a.sentAtMs)[0] ?? null,
        acceptedOutboundFacts: facts }
    },
  }
}
