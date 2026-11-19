import { createHmac, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { stableJson, type CanonicalRunPreparationPorts, type RunIdentity } from '@gugu/core/agent'
import type { ImReactionPort } from '@gugu/core/im/reaction-tool'
import type { ImActor, ImBotAccess } from '@gugu/core/im/access'
import { agentDispatchSource, decryptAgentDispatchInput, type AgentDispatchLease } from '../../../agent/run/dispatch.js'
import { imActorInputForDispatch, type ImAgentReconstructorOptions } from '../agent/reconstruct.js'
import type { createPostgresImAccess } from '../inbound/access.js'
import type { NodeImBotBinding } from '../inbound/inbox.js'
import type { GatewayPlatformSender } from '../platform-connections.js'

/** 独立工具收据，不能借用包围整个Runner的投递锁，否则工具会与自身投递进程争锁。 */
export function createPostgresImReaction(options: {
  pool: Pick<Pool, 'query'>; secretKey: string; lease: AgentDispatchLease
  actor: ImActor; bot: ImBotAccess; access: ReturnType<typeof createPostgresImAccess>
  configuration: CanonicalRunPreparationPorts['configuration']
  readRoute: ImAgentReconstructorOptions['readRoute']
  sender(binding: NodeImBotBinding): GatewayPlatformSender | null
}): ImReactionPort {
  const lease = structuredClone(options.lease), identity = lease.identity, actor = structuredClone(options.actor), bot = structuredClone(options.bot)
  if (!options.secretKey || typeof options.configuration !== 'function' || lease.input.v !== 3 || agentDispatchSource(lease.input) !== 'im' || lease.input.im.platform !== 'feishu'
    || actor.platform !== 'feishu' || actor.ownerId !== identity.ownerId || actor.botId !== lease.input.im.botId
    || actor.chatType !== lease.input.im.chatType || actor.chatId !== lease.input.im.chatId || actor.platformUserId !== lease.input.im.platformUserId
    || bot.ownerId !== actor.ownerId || bot.id !== actor.botId || bot.platform !== actor.platform) throw new TypeError('飞书表情运行绑定无效')
  const dispatchInput = lease.input
  const hmac = (value: unknown) => createHmac('sha256', options.secretKey).update('gugu-im-reaction-v1\0').update(stableJson(value)).digest('hex')
  const binding: NodeImBotBinding = { ownerId: actor.ownerId, botId: actor.botId, platform: 'feishu' }
  const same = (target: RunIdentity) => target.ownerId === identity.ownerId && target.sessionId === identity.sessionId && target.runId === identity.runId
  async function target(requested: RunIdentity, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted()
    if (!same(requested) || !await options.access.authorizeDelivery(actor, bot)) return null
    const config = await options.configuration(identity, signal ?? new AbortController().signal)
    if (config.source !== 'feishu' || config.identity.ownerId !== identity.ownerId || config.identity.subject.kind !== 'session'
      || config.identity.subject.id !== identity.sessionId || !config.toolNames.includes('react')) return null
    const result = await options.pool.query(`SELECT d.nonce,d.payload,m.im_platform_message_id,m.platform_user_id FROM agent_run_dispatch d
      JOIN conversation_sessions s ON s.id=d.session_id AND s.user_id=d.user_id
      JOIN conversation_messages m ON m.id=$6 AND m.session_id=s.id AND m.run_id=d.run_id AND m.role='user'
      JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id AND r.run_id=m.run_id
      WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND s.active_run_id=$3
        AND d.state='selected' AND d.cancel_requested IS FALSE AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()
        AND r.platform=$7 AND r.bot_id=$8 AND r.chat_type=$9 AND r.state='dispatched' AND m.chat_type=$9
        AND ($9='group' AND s.source=$7 AND s.bot_id=$8::text AND s.chat_type='group' AND s.chat_id=$10
          OR $9='c2c' AND m.platform_user_id=$11)`,
    [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence, dispatchInput.userMessageId,
      actor.platform, actor.botId, actor.chatType, actor.chatId, actor.platformUserId])
    if (result.rows.length !== 1) return null
    const row = result.rows[0]!, current = decryptAgentDispatchInput(options.secretKey, identity, row.nonce, row.payload)
    if (stableJson(current) !== stableJson(dispatchInput)) return null
    const route = await options.readRoute(identity)
    if (!route) return null
    const input = imActorInputForDispatch({ identity, input: dispatchInput }, route)
    if (!await options.access.authorizeTool(input, 'react')) return null
    const messageId = route.payload.message_id
    if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(messageId)
      || route.payload.platform_message_id !== messageId || row.im_platform_message_id !== messageId
      || row.platform_user_id !== actor.platformUserId) return null
    signal?.throwIfAborted()
    return messageId
  }
  function scope(input: { identity: RunIdentity; roundId: string; toolCallId: string; emoji: string }) {
    if (!same(input.identity) || !input.roundId || input.roundId.length > 256 || !input.toolCallId || input.toolCallId.length > 1024
      || !['THUMBSUP', 'HEART', 'THANKS', 'LAUGH', 'WOW', 'CRY', 'THINKING', 'PARTY', 'OK', 'DONE'].includes(input.emoji)) throw new TypeError('飞书表情调用无效')
    return [identity.ownerId, identity.sessionId, identity.runId, hmac([input.roundId, input.toolCallId])]
  }
  return {
    async react(input) {
      try {
        const values = scope(input), messageId = await target(input.identity, input.signal)
        if (!messageId) return 'rejected'
        const wire = options.sender(binding)
        if (wire?.platform !== 'feishu') return 'rejected'
        const fingerprint = hmac([messageId, input.emoji]), attempt = randomUUID()
        const result = await options.pool.query(`INSERT INTO gugu_im_reaction_receipts(user_id,session_id,run_id,call_hash,fingerprint,attempt_id,state)
          VALUES($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT(user_id,session_id,run_id,call_hash) DO UPDATE SET
            state=CASE WHEN gugu_im_reaction_receipts.state='rejected' THEN 'pending' ELSE gugu_im_reaction_receipts.state END,
            attempt_id=CASE WHEN gugu_im_reaction_receipts.state='rejected' THEN EXCLUDED.attempt_id ELSE gugu_im_reaction_receipts.attempt_id END
          WHERE gugu_im_reaction_receipts.fingerprint=EXCLUDED.fingerprint RETURNING state,attempt_id`, [...values, fingerprint, attempt])
        const receipt = result.rows[0]
        if (!receipt) return 'unknown'
        if (receipt.state === 'accepted') return 'accepted'
        if (receipt.state !== 'pending' || receipt.attempt_id !== attempt) return 'unknown'
        let outcome: 'accepted' | 'rejected' | 'unknown' = 'unknown'
        try {
          outcome = (await wire.sender.react(messageId, input.emoji, input.signal,
            async () => await target(input.identity, input.signal) === messageId)).outcome
        } catch { /* 已登记意图后的异常一律保留未知，不把原始异常传给模型。 */ }
        const settled = await options.pool.query(`UPDATE gugu_im_reaction_receipts SET state=$6
          WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND call_hash=$4 AND attempt_id=$5 AND state='pending' RETURNING state`,
        [...values, attempt, outcome])
        return settled.rowCount === 1 ? outcome : 'unknown'
      } catch { input.signal.throwIfAborted(); return 'unknown' }
    },
    async recover(input) {
      try {
        const values = scope(input), messageId = await target(input.identity)
        if (!messageId) return 'unknown'
        const row = (await options.pool.query(`SELECT state FROM gugu_im_reaction_receipts
          WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND call_hash=$4 AND fingerprint=$5`, [...values, hmac([messageId, input.emoji])])).rows[0]
        return row?.state === 'accepted' ? 'accepted' : row?.state === 'rejected' ? 'rejected' : 'unknown'
      } catch { return 'unknown' }
    },
  }
}
