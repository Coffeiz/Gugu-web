import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { ImActor } from '@gugu/core/im/access'
import { normalizeFileOwnerId } from '../../../files/store.js'
import type { ImAttachmentScope } from '../inbound/attachments.js'
import { imAttachmentScopeKey } from '../inbound/attachments.js'
import { createImInboundEnvelope } from '../inbound/envelope.js'
import { imConversationDigest, imConversationFingerprint, imConversationScopeHash } from './identity.js'

export class ImRunScopeError extends Error { constructor() { super('IM 运行投递范围不可用'); this.name = 'ImRunScopeError' } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const positive = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647
/** 只读来源证明，不授予工具/投递/取消权限；调用方必须另行验证具体动作授权。 */
function createImRunSourceProofUnchecked(options: { pool: Pick<Pool, 'query'>; secretKey: string; identity: RunIdentity;
  scope: ImAttachmentScope; messageIds: readonly string[]; payload: Readonly<Record<string, unknown>> }) {
  const identity = Object.freeze({ ...options.identity }), scope = Object.freeze({ ...options.scope })
  const ids = [...options.messageIds], payload = structuredClone(options.payload), binding = Object.freeze({ ownerId: scope.ownerId, platform: scope.platform, botId: scope.botId })
  try {
    imAttachmentScopeKey(scope)
    if (!options.secretKey || normalizeFileOwnerId(identity.ownerId) !== identity.ownerId || identity.ownerId !== scope.ownerId || !positive(identity.sessionId) || !identity.runId
      || !ids.length || ids.length > 128 || ids.some(id => !positive(id)) || new Set(ids).size !== ids.length
      || payload.owner_user_id !== scope.ownerId || payload.platform !== scope.platform || payload.bot_id !== scope.botId
      || payload.chat_type !== scope.chatType || payload.platform_user_id !== scope.platformUserId || scope.chatType === 'group' && payload.chat_id !== scope.chatId) throw new ImRunScopeError()
  } catch { throw new ImRunScopeError() }
  const facts = Array.isArray(payload._batch_messages) ? payload._batch_messages : [payload]
  if (facts.length !== ids.length || facts.some(fact => !object(fact))) throw new ImRunScopeError()
  const envelope = createImInboundEnvelope(options.secretKey)
  const native = (value: Readonly<Record<string, unknown>>) => value.platform_message_id ?? value.message_id
  if (native(facts.at(-1) as Record<string, unknown>) !== native(payload)
    || (facts.at(-1) as Record<string, unknown>).platform_user_id !== payload.platform_user_id
    // 私聊聚合规范化chat_id=null，原始平台事实仍保留原生私聊chat ID；实际范围由sender证明。
    || scope.chatType === 'group' && (facts.at(-1) as Record<string, unknown>).chat_id !== payload.chat_id) throw new ImRunScopeError()
  return { identity, scope, ids, payload, binding, async read(): Promise<{ watermark: number; sourceEventIds: string[]; sourceMessageIds: string[]; sourceEventIdsComplete: boolean }> {
    try {
      const rows = (await options.pool.query<Record<string, unknown>>(`SELECT m.id::text,m.conversation_seq::text,m.platform_user_id,m.im_platform_message_id,
        r.scope_hash,r.event_hash,r.fingerprint,r.sealed_payload
        FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
        JOIN gugu_im_inbound_receipts r ON r.user_id=s.user_id AND r.session_id=s.id AND r.message_id=m.id
        WHERE s.id=$2 AND m.id=ANY($3::integer[]) AND m.run_id=$4 AND m.role='user'
          AND r.run_id=$4 AND r.state='dispatched' AND r.platform=$5 AND r.bot_id=$6 AND r.chat_type=$7 AND m.chat_type=$7
          AND ($7='group' AND s.source=$5 AND s.bot_id=$6 AND s.chat_type='group' AND s.chat_id=$8
            OR $7='c2c' AND m.platform_user_id=$9 AND s.chat_id IS NULL AND (s.chat_type='c2c' OR s.chat_type IS NULL)
              AND (s.source='web' OR s.source IS NULL OR s.source=$5 AND s.bot_id=$6))`,
      [identity.ownerId, identity.sessionId, ids, identity.runId, scope.platform, scope.botId, scope.chatType, scope.chatId, scope.platformUserId])).rows
      const byId = new Map(rows.map(row => [String(row.id), row]))
      if (rows.length !== ids.length || byId.size !== ids.length) throw new ImRunScopeError()
      const sourceEventIds: string[] = []
      for (const [index, id] of ids.entries()) {
        const row = byId.get(id), fact = facts[index] as Record<string, unknown>
        if (!row || !object(row.sealed_payload) || !Number.isSafeInteger(Number(row.conversation_seq)) || Number(row.conversation_seq) < 1) throw new ImRunScopeError()
        const stored = envelope.open(binding, row.sealed_payload)
        if (typeof stored._node_stream_event_id === 'string' && /^\d+-\d+$/.test(stored._node_stream_event_id)) sourceEventIds.push(stored._node_stream_event_id)
        const scopeHash = imConversationScopeHash(options.secretKey, binding, stored)
        const attachments = Array.isArray(stored.attachments) ? stored.attachments.map(item => typeof item === 'string' ? item : object(item) ? item.attach_id : null) : []
        if (attachments.some(id => typeof id !== 'string') || row.scope_hash !== scopeHash
          || row.event_hash !== imConversationDigest(options.secretKey, [scopeHash, stored.platform_user_id, stored._pending_ask_resume_id || stored.platform_message_id || stored.message_id])
          || row.fingerprint !== imConversationFingerprint(options.secretKey, scopeHash, stored, attachments as string[])
          || stored.platform_user_id !== row.platform_user_id || fact.platform_user_id !== row.platform_user_id
          || native(stored) !== native(fact) || stored.context_token !== fact.context_token || stored.chat_id !== fact.chat_id
          || stored.text !== fact.text || (stored.quoted_text ?? null) !== (fact.quoted_text ?? null)
          || stored.chat_type !== scope.chatType || scope.chatType === 'group' && stored.chat_id !== scope.chatId
          || fact._early_message_id !== undefined && String(fact._early_message_id) !== id
          || fact.conversation_seq !== undefined && Number(fact.conversation_seq) !== Number(row.conversation_seq)) throw new ImRunScopeError()
        if (scope.platform === 'wechat') {
          if (row.im_platform_message_id !== null || stored.message_id !== stored.context_token) throw new ImRunScopeError()
        } else if (typeof native(stored) !== 'string' || !native(stored) || row.im_platform_message_id !== native(stored)
          || scope.platform === 'telegram' && !/^[1-9]\d*$/.test(String(native(stored)))) throw new ImRunScopeError()
      }
      return { watermark: Math.max(...rows.map(row => Number(row.conversation_seq))),
        sourceEventIds, sourceEventIdsComplete: sourceEventIds.length === ids.length,
        sourceMessageIds: scope.platform === 'wechat' ? [] : ids.map(id => String(byId.get(id)!.im_platform_message_id)) }
    } catch { throw new ImRunScopeError() }
  } }
}

export function createImRunSourceProof(options:Parameters<typeof createImRunSourceProofUnchecked>[0]){
 try{return createImRunSourceProofUnchecked(options)}catch{throw new ImRunScopeError()}
}

/** 出站始终要求真实actor和当前权限，读取密封证明前后各复核一次；不能用于Web owner取消授权。 */
export function createImRunScope(options: Parameters<typeof createImRunSourceProof>[0] & {
  actor:ImActor;authorize():Promise<boolean>
}){
 try{
  const actor=structuredClone(options.actor),scope=options.scope
  if(typeof options.authorize!=='function'||actor.ownerId!==scope.ownerId||actor.botId!==scope.botId||actor.platform!==scope.platform
   ||actor.chatType!==scope.chatType||actor.chatId!==scope.chatId||actor.platformUserId!==scope.platformUserId)throw new ImRunScopeError()
  const proof=createImRunSourceProof(options)
  return{...proof,actor,async read(){try{
   if(await options.authorize()!==true)throw new ImRunScopeError()
   const facts=await proof.read()
   if(await options.authorize()!==true)throw new ImRunScopeError()
   return facts
  }catch{throw new ImRunScopeError()}}}
 }catch{throw new ImRunScopeError()}
}
