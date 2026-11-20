import type { Pool } from 'pg'
import { assertDurableCanonical, type CanonicalMessage, type ContextReferenceCodec, type HistoryIdentity, type Json, type MessageEntry, type RunIdentity } from '@gugu/core/agent'
import { normalizeFileOwnerId, isOwnedFileStorageKey } from '../../../files/store.js'
import { imAttachmentScopeKey, type ImAttachmentScope } from '../inbound/attachments.js'

export class ImContextReferenceError extends Error {
  constructor() { super('IM 上下文引用不可用'); this.name = 'ImContextReferenceError' }
}
interface AttachmentRow {
  attach_id: string; name: string; kind: string; ext: string; mime: string | null; size: string | number
  storage_key: string; platform: string; state: string; extra: { im_ingress_scope?: string } | null
}
const positive = (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 2_147_483_647

/**
 * 稳定引用的正式授权边界。与materializer.references组合后，图片由其本地FS端口恢复；
 * 本层只接受已固化Canonical，不把未知inline媒体或推理材料原样写入checkpoint。
 */
export function createImContextReferenceCodec(options: {
  pool: Pick<Pool, 'query'>; identity: RunIdentity; scope: ImAttachmentScope
  /** 必须复核当前Bot、账户、actor和冻结访问版本，不仅检查附件owner。 */
  authorize(signal?: AbortSignal): Promise<boolean>
}): ContextReferenceCodec {
  const identity = Object.freeze({ ...options.identity }), scope = Object.freeze({ ...options.scope })
  let scopeKey: string
  try {
    scopeKey = imAttachmentScopeKey(scope)
    if (normalizeFileOwnerId(identity.ownerId) !== identity.ownerId || scope.ownerId !== identity.ownerId
      || !positive(identity.sessionId) || !identity.runId || typeof options.authorize !== 'function') throw new ImContextReferenceError()
  } catch { throw new ImContextReferenceError() }
  async function authorize(target: HistoryIdentity, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (target.ownerId !== identity.ownerId || target.sessionId !== identity.sessionId
      || 'runId' in target && target.runId !== identity.runId || await options.authorize(signal) !== true) throw new ImContextReferenceError()
    signal?.throwIfAborted()
  }
  const dehydrateBatch: NonNullable<ContextReferenceCodec['dehydrateBatch']> = async (entries, target, signal, timing) => {
    try {
      let started = performance.now()
      const mark = (stage: string) => {
        const end = performance.now()
        timing?.(stage, end - started)
        started = end
      }
      await authorize(target, signal)
      mark('authorize_before')
      const messages = entries.map(entry => structuredClone(entry.message))
      const refs: Record<string, Json>[] = []
      function visit(value: Json, decode = true): void {
        if (Array.isArray(value)) { for (const item of value) visit(item, decode); return }
        if (!value || typeof value !== 'object') return
        if (value.type === 'attachment_ref') {
          if (refs.length >= 12800 || typeof value.attach_id !== 'string' || value.attach_id.length > 256) throw new ImContextReferenceError()
          refs.push(value)
        }
        for (const [key, item] of Object.entries(value)) {
          if (value.type === 'tool-schema' && key === 'schema') continue
          if (value.type === 'tool_result' && key === 'content') {
            if (decode && typeof item === 'string' && /^\s*[\[{]/u.test(item)) {
              let decoded: Json | undefined
              try { decoded = JSON.parse(item) as Json } catch { /* 普通工具文本不是JSON时仍按原文保留。 */ }
              if (decoded && typeof decoded === 'object') visit(decoded, false)
            } else visit(item, false)
          } else visit(item, decode)
        }
      }
      for (const message of messages) {
        signal?.throwIfAborted()
        assertDurableCanonical(message)
        visit(message)
      }
      mark('scan_references')
      // 私聊可能绑定Web会话；由正式入站收据证明本Run的Bot/平台/sender，不能只信session.source。
      const owned = await options.pool.query(`SELECT 1 FROM conversation_sessions s
        WHERE s.user_id=$1 AND s.id=$2 AND EXISTS (
          SELECT 1 FROM gugu_im_inbound_receipts r JOIN conversation_messages m ON m.id=r.message_id AND m.session_id=s.id
          WHERE r.user_id=s.user_id AND r.session_id=s.id AND r.run_id=$3 AND m.run_id=$3 AND r.state='dispatched'
            AND r.platform=$4 AND r.bot_id=$5 AND r.chat_type=$6 AND m.chat_type=$6
            AND ($6='group' AND s.chat_id=$7 AND s.source=$4 AND s.bot_id=$5 AND s.chat_type='group'
              OR $6='c2c' AND m.platform_user_id=$8))`,
      [identity.ownerId, identity.sessionId, identity.runId, scope.platform, scope.botId, scope.chatType, scope.chatId, scope.platformUserId])
      if (owned.rows.length !== 1) throw new ImContextReferenceError()
      mark('receipt_ownership')
      const ids = [...new Set(refs.map(ref => ref.attach_id as string))]
      if (ids.length) {
        const rows = (await options.pool.query<AttachmentRow>(`SELECT a.attach_id,a.name,a.kind,a.ext,a.mime,a.size,a.storage_key,a.platform,a.state,a.extra
          FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id JOIN conversation_sessions s ON s.id=m.session_id
          WHERE a.user_id=$1 AND s.user_id=$1 AND s.id=$2 AND a.attach_id=ANY($3::text[])
            AND a.state='attached' AND a.platform=$4 AND a.extra->>'im_ingress_scope'=$5`,
        [identity.ownerId, identity.sessionId, ids, scope.platform, scopeKey])).rows
        const byId = new Map(rows.map(row => [row.attach_id, row]))
        if (rows.length !== ids.length || byId.size !== ids.length) throw new ImContextReferenceError()
        for (const ref of refs) {
          const row = byId.get(ref.attach_id as string), size = Number(row?.size)
          if (!row || row.state !== 'attached' || row.platform !== scope.platform || row.extra?.im_ingress_scope !== scopeKey
            || !isOwnedFileStorageKey(identity.ownerId, row.storage_key) || !Number.isSafeInteger(size) || size < 1
            || ref.kind !== undefined && ref.kind !== row.kind || ref.mime !== undefined && ref.mime !== row.mime
            || ref.ext !== undefined && ref.ext !== row.ext || ref.name !== undefined && ref.name !== row.name
            || ref.title !== undefined && ref.title !== row.name || ref.size_bytes !== undefined && ref.size_bytes !== size)
            throw new ImContextReferenceError()
        }
      }
      mark('attachment_validation')
      await authorize(target, signal)
      mark('authorize_after')
      return messages
    } catch { throw new ImContextReferenceError() }
  }
  async function convert(entry: MessageEntry, target: HistoryIdentity, signal?: AbortSignal): Promise<CanonicalMessage> {
    return (await dehydrateBatch([entry], target, signal))[0]!
  }
  return { dehydrate: convert, dehydrateBatch, hydrate: convert }
}
