import { createHmac } from 'node:crypto'
import { stableJson } from '@gugu/core/agent'
import type { NodeImBotBinding } from '../inbound/inbox.js'

/** 与现有入站收据保持同一HMAC契约；不得改作日志指纹或输出原生事件/凭据。 */
export const imConversationDigest = (secretKey: string, value: unknown) => createHmac('sha256', secretKey).update('gugu-im-conversation-v1\0').update(stableJson(value)).digest('hex')
export function imConversationScopeHash(secretKey: string, binding: NodeImBotBinding, payload: Readonly<Record<string, unknown>>) {
  return imConversationDigest(secretKey, [binding.ownerId, binding.platform, binding.botId, payload.chat_type,
    payload.chat_type === 'group' ? payload.chat_id : payload.platform_user_id])
}
export function imConversationFingerprint(secretKey: string, scopeHash: string, payload: Readonly<Record<string, unknown>>, attachmentIds: readonly string[]) {
  return imConversationDigest(secretKey, [scopeHash, payload.platform_user_id, payload.text, payload.quoted_text ?? null, attachmentIds,
    payload.platform_message_id ?? payload.message_id, payload.reply_to_platform_message_id ?? null])
}
