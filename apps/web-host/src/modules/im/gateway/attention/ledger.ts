import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { RunIdentity, PortableValue } from '@gugu/core/agent'
import type { ImAttentionAcceptedFacts } from './snapshot.js'
import type { BotReplyFact } from '@gugu/core/im/attention/types'

export interface ImDeliveryEvidenceScope { ownerId: string; botId: string; platform: 'feishu' | 'qq' | 'telegram' | 'wechat'; chatType: 'group' | 'c2c'; chatId: string | null }
export interface ImDeliveryLedgerContext {
  readonly scope: ImDeliveryEvidenceScope
  /** 可信原Run发起者；不采用sender或模型返回的角色。 */
  readonly recipientSenderId: string | null
  readonly sourceAttentionKind?: string | null
  readonly proactive?: boolean
}
const failure = () => new Error('IM 送达事实不可用')
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const bounded = (v: unknown, n = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= n && !/[\u0000-\u001f]/u.test(v)
function normalized(scope: ImDeliveryEvidenceScope) {
  if (!/^[a-f0-9-]{36}$/u.test(scope.ownerId) || !/^[1-9]\d*$/u.test(scope.botId) || !['feishu','qq','telegram','wechat'].includes(scope.platform)
    || !['group','c2c'].includes(scope.chatType) || (scope.chatType === 'group' ? !bounded(scope.chatId) : scope.chatId !== null)) throw failure()
  return { ownerId: scope.ownerId, botId: scope.botId, platform: scope.platform, chatType: scope.chatType, chatId: scope.chatId }
}
/** 凭据与context token不属于本契约；只允许正式sender的可见逻辑正文及平台回执。 */
export function createImAcceptedEvidenceCodec(secretKey: string, context: ImDeliveryLedgerContext) {
  const scope = normalized(context.scope)
  if (!secretKey || context.recipientSenderId !== null && !bounded(context.recipientSenderId)) throw failure()
  const recipientSenderId = context.recipientSenderId, sourceAttentionKind = context.sourceAttentionKind ?? null, proactive = context.proactive === true
  if (sourceAttentionKind !== null && !['ALLOW_RUN','DIRECT','CONTINUE','CAPABILITY_ACTION','MEMBER_ACTIVE','PROACTIVE','EXCLUDED','PASSIVE','member_CONTINUE','member_ACTIVE','proactive','autonomous'].includes(sourceAttentionKind)) throw failure()
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secretKey), Buffer.alloc(0), Buffer.from('gugu-im-accepted-evidence-v1'), 32))
  const scopeHash = createHmac('sha256', key).update(JSON.stringify(scope)).digest('hex')
  const aad = (identity: RunIdentity, deliveryKey: string, attempt: string) => {
    if (identity.ownerId !== scope.ownerId) throw failure()
    return Buffer.from(JSON.stringify([1,scope,identity.sessionId,identity.runId,deliveryKey,attempt]))
  }
  const validate = (value: unknown): Record<string, unknown> | null => {
    if (value === undefined || value === null) return null
    if (!object(value) || Object.keys(value).some(k => !['v','scope','recipient','kind','platformMessageIds','sourceMessageIds','sourceEventIds','coverage','text','contentHash'].includes(k))
      || value.v !== 1 || !object(value.scope) || Object.keys(value.scope).some(k => !['ownerId','botId','platform','chatType','chatId'].includes(k))
      || JSON.stringify(normalized(value.scope as unknown as ImDeliveryEvidenceScope)) !== JSON.stringify(scope)
      || !bounded(value.recipient) || !['text','artifact','interaction'].includes(String(value.kind))
      || scope.chatType === 'group' && value.recipient !== scope.chatId
      || !object(value.coverage) || typeof value.coverage.nativeMessageIds !== 'boolean' || typeof value.coverage.sourceEventIds !== 'boolean') throw failure()
    for (const k of ['platformMessageIds','sourceMessageIds','sourceEventIds']) {
      const ids = value[k]
      if (!Array.isArray(ids) || ids.length > 128 || ids.some(id => !bounded(id)) || new Set(ids).size !== ids.length) throw failure()
    }
    if ((value.sourceEventIds as string[]).some(id => !/^\d+-\d+$/u.test(id))
      || value.coverage.nativeMessageIds && !(value.platformMessageIds as string[]).length
      || value.coverage.sourceEventIds && !(value.sourceEventIds as string[]).length
      || scope.platform === 'wechat' && ((value.platformMessageIds as string[]).length || (value.sourceMessageIds as string[]).length || value.coverage.nativeMessageIds)) throw failure()
    if (value.text !== undefined && (typeof value.text !== 'string' || Buffer.byteLength(value.text) > 48000)) throw failure()
    if (value.contentHash !== undefined && (typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.contentHash))) throw failure()
    if (typeof value.text === 'string' && createHash('sha256').update(value.text).digest('hex') !== value.contentHash) throw failure()
    return value
  }
  return { scopeHash,
    seal(identity: RunIdentity, deliveryKey: string, attempt: string, evidence?: PortableValue) {
      const value = validate(evidence)
      const json = JSON.stringify({ evidence: value, recipientSenderId,sourceAttentionKind,proactive })
      if (Buffer.byteLength(json) > 65536) throw failure()
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(aad(identity,deliveryKey,attempt))
      return { nonce, payload: Buffer.concat([cipher.update(json),cipher.final(),cipher.getAuthTag()]) }
    },
    open(identity: RunIdentity, deliveryKey: string, attempt: string, nonce: Buffer, payload: Buffer) {
      try {
        if (nonce.length !== 12 || payload.length < 16 || payload.length > 65552) throw failure()
        const cipher = createDecipheriv('aes-256-gcm',key,nonce); cipher.setAAD(aad(identity,deliveryKey,attempt)); cipher.setAuthTag(payload.subarray(-16))
        const value: unknown = JSON.parse(Buffer.concat([cipher.update(payload.subarray(0,-16)),cipher.final()]).toString('utf8'))
        if (!object(value) || value.recipientSenderId !== null && !bounded(value.recipientSenderId) || typeof value.proactive !== 'boolean'
          || value.sourceAttentionKind !== null && !bounded(value.sourceAttentionKind)) throw failure()
        return { evidence: validate(value.evidence), recipientSenderId: value.recipientSenderId as string | null,
          sourceAttentionKind: value.sourceAttentionKind as string | null, proactive: value.proactive }
      } catch { throw failure() }
    },
  }
}

/** 密文证据来自同一accepted收据事务。覆盖未知/历史旧收据拒绝提供完整负证据。 */
export function createPostgresImAcceptedFactsReader(options: { pool: Pick<Pool,'query'>; secretKey: string }): ImAttentionAcceptedFacts {
  return { async read(scope, watermarkMs, messages, signal) {
    try {
      signal.throwIfAborted()
      if (!messages.length || !Number.isSafeInteger(watermarkMs)) throw failure()
      const maxTime = Math.max(watermarkMs,...messages.map(m => m.eventReceivedMs))
      const codec = createImAcceptedEvidenceCodec(options.secretKey, { scope: { ...scope, chatType:'group',chatId:scope.groupId },recipientSenderId:null })
      // 当前真实Bot、账户和群开关；外层snapshot的会话检查不能代替本reader自身边界。
      const auth = await options.pool.query(`SELECT 1 FROM user_bots b JOIN users u ON u.id=b.user_id
        WHERE b.user_id=$1 AND b.id=$2::integer AND b.platform=$3 AND b.enabled IS TRUE AND u.is_active IS TRUE
          AND COALESCE(u.account_status,'active')='active'
          AND (CASE WHEN b.platform='feishu' THEN b.feishu_group_chat_enabled IS DISTINCT FROM FALSE
            WHEN b.platform IN ('qq','telegram') THEN b.group_chat_enabled IS TRUE ELSE FALSE END)`,[scope.ownerId,scope.botId,scope.platform])
      if (auth.rows.length !== 1) throw failure()
      // 未升级的旧外层投递收据没有可验证phase/证据，不能宣称完整；内部飞书网络操作不算外层消息。
      const legacy = await options.pool.query(`SELECT 1 FROM gugu_im_delivery_receipts r JOIN conversation_sessions s ON s.id=r.session_id AND s.user_id=r.user_id
        LEFT JOIN gugu_im_accepted_delivery_facts f ON f.user_id=r.user_id AND f.session_id=r.session_id AND f.run_id=r.run_id AND f.delivery_key=r.delivery_key
        WHERE r.user_id=$1 AND s.source=$3 AND s.bot_id=$2::text AND s.chat_type='group' AND s.chat_id=$4
          AND r.delivery_key NOT LIKE 'feishu:%' AND (r.state IN ('pending','unknown')
            OR r.state='accepted' AND (f.delivery_key IS NULL OR f.scope_hash<>$5)) LIMIT 1`,[scope.ownerId,scope.botId,scope.platform,scope.groupId,codec.scopeHash])
      if (legacy.rows.length) throw failure()
      const rows = await options.pool.query<{session_id:number;run_id:string;delivery_key:string;attempt_id:string;nonce:Buffer;payload:Buffer;sent_ms:string;known_ms:string;final_event_sequence:string|null}>(`SELECT f.session_id,f.run_id,f.delivery_key,f.attempt_id,f.nonce,f.payload,
        (extract(epoch FROM f.accepted_at)*1000)::text AS sent_ms,(extract(epoch FROM f.final_confirmed_at)*1000)::text AS known_ms,f.final_event_sequence
        FROM gugu_im_accepted_delivery_facts f JOIN gugu_im_delivery_receipts r USING(user_id,session_id,run_id,delivery_key)
        WHERE f.user_id=$1 AND f.scope_hash=$2 AND r.state='accepted' AND r.attempt_id=f.attempt_id
          AND f.accepted_at<=to_timestamp($3::numeric/1000) AND f.final_confirmed_at<=to_timestamp($3::numeric/1000) AND f.final_event_sequence IS NOT NULL
        ORDER BY f.accepted_at DESC,f.run_id,f.delivery_key LIMIT 10001`,[scope.ownerId,codec.scopeHash,maxTime])
      if (rows.rows.length > 10000) throw failure()
      const finals = rows.rows.map(row => {
        const opened = codec.open({ownerId:scope.ownerId,sessionId:String(row.session_id),runId:row.run_id},row.delivery_key,row.attempt_id,row.nonce,row.payload)
        const e = opened.evidence
        if (!e || e.kind !== 'text' || typeof e.text !== 'string' || !object(e.coverage) || e.coverage.nativeMessageIds !== true || e.coverage.sourceEventIds !== true) throw failure()
        return { row, opened, evidence:e, time:Number(row.sent_ms),knownTime:Number(row.known_ms) }
      })
      const selected = new Set(finals.filter(f => f.time <= watermarkMs && f.knownTime <= watermarkMs).slice(0,32))
      for (const m of messages) {
        const activation = finals.find(f => f.opened.recipientSenderId === m.senderId && f.time <= m.eventReceivedMs && f.knownTime <= m.eventReceivedMs
          && ['DIRECT','member_CONTINUE','CAPABILITY_ACTION','member_ACTIVE','proactive','autonomous'].includes(f.opened.sourceAttentionKind ?? ''))
        if (activation) selected.add(activation)
        if (m.replyToPlatformMessageId) for (const f of finals) if (f.time <= m.eventReceivedMs && f.knownTime <= m.eventReceivedMs && f.opened.recipientSenderId === m.senderId
          && (f.evidence.platformMessageIds as string[]).includes(m.replyToPlatformMessageId)) selected.add(f)
      }
      const result: BotReplyFact[] = []
      for (const f of selected) for (const id of f.evidence.platformMessageIds as string[]) result.push({ platformMessageId:id,sentAtMs:f.time,
        recipientSenderId:f.opened.recipientSenderId,accepted:true,proactive:f.opened.proactive,sourceAttentionKind:f.opened.sourceAttentionKind,
        finalText:f.evidence.text as string,deliveryId:f.row.delivery_key })
      signal.throwIfAborted()
      return result
    } catch { throw failure() }
  } }
}
