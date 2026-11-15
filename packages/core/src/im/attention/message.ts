import { strip } from '../../shared/values.js'
import { asciiDecimalDigits } from '../../shared/unicode-decimal.js'
import type { AttentionMessage } from './types.js'

export class AttentionInputError extends Error {
  override name = 'AttentionInputError'
}

function streamEventMs(eventId: string): number {
  const separator = eventId.indexOf('-')
  if (separator < 1 || separator === eventId.length - 1) throw new AttentionInputError('Redis Stream event_id 格式无效')
  const parse = (value: string) => {
    const normalized = asciiDecimalDigits(strip(value))
    if (!/^[+-]?\d(?:_?\d)*$/.test(normalized)) throw new AttentionInputError('Redis Stream event_id 缺少可信到达时间')
    return Number(normalized.replaceAll('_', ''))
  }
  const timestamp = parse(eventId.slice(0, separator))
  const sequence = parse(eventId.slice(separator + 1))
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isSafeInteger(sequence)) throw new AttentionInputError('Redis Stream event_id 缺少可信到达时间')
  return timestamp
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = strip(String(value))
  return text || null
}

function optionalMillis(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) return null
  const result = typeof value === 'number' ? Math.trunc(value) : Number(asciiDecimalDigits(strip(String(value))))
  if (!Number.isSafeInteger(result) || result <= 0) return null
  return result < 10_000_000_000 ? result * 1000 : result
}

function mediaKinds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const kinds = new Set<string>()
  const aliases: Record<string, string> = { photo: 'image', picture: 'image', document: 'file', voice: 'audio', animation: 'video' }
  for (const item of value) {
    if (typeof item === 'string') kinds.add('unknown')
    else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>
      const raw = String(record.media_kind || record.media_type || record.type || '').toLowerCase()
      const mime = String(record.mime_type || '').toLowerCase()
      kinds.add(aliases[raw] || raw || mime.split('/', 1)[0] || 'unknown')
    }
  }
  return [...kinds].sort()
}

/** 从 Gateway 规范化负载建立单条可信事实；不读取或记录用户正文。 */
export function attentionMessageFromPayload(eventId: string, payload: Readonly<Record<string, unknown>>): AttentionMessage {
  const received = streamEventMs(String(eventId))
  const rawText = String((Object.hasOwn(payload, 'attention_raw_text') ? payload.attention_raw_text : payload.text) || '')
  const explicit = payload.media_kinds
  const kinds = Array.isArray(explicit) ? [...new Set(explicit.filter(Boolean).map(item => String(item).toLowerCase()))].sort() : mediaKinds(payload.attachments)
  const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null
  const platform = String(payload.platform || '')
  const botId = String(payload.bot_id || payload.channel_id || '')
  const groupId = String(payload.chat_id || '')
  if (!platform || !botId || !groupId) throw new AttentionInputError('注意力门控缺少平台、Bot 或群作用域')
  return {
    eventId: String(eventId), platform, botId, groupId,
    platformMessageId: optionalText(payload.platform_message_id || payload.message_id),
    senderId: optionalText(payload.platform_user_id), eventReceivedMs: received,
    platformSentMs: optionalMillis(Object.hasOwn(payload, 'platform_sent_ms') ? payload.platform_sent_ms : payload._platform_sent_ms),
    rawText, mediaOnly: typeof payload.media_only === 'boolean' ? payload.media_only : !strip(rawText) && kinds.length > 0,
    mediaKinds: kinds, processableMedia: bool(payload.processable_media),
    mentionedCurrentBot: bool(payload.native_bot_mentioned), mentionedOtherBot: bool(payload.mentions_other_bot),
    mentionedOtherMember: bool(payload.mentions_other_member),
    hasUnresolvedMention: payload.has_unresolved_mention === true || (payload.native_bot_mentioned == null && /(?<![A-Za-z0-9_])@[A-Za-z0-9_]+/.test(rawText)),
    replyToPlatformMessageId: optionalText(payload.reply_to_platform_message_id || payload.reply_to_message_id),
    replyTargetSenderId: optionalText(payload.reply_target_sender_id), replyTargetIsBot: bool(payload.reply_target_is_bot),
    quoteText: optionalText(payload.quoted_text), senderIsBot: bool(payload.sender_is_bot), candidateText: rawText,
  }
}
