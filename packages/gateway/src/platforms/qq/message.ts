import { asciiDecimalDigits, decimalDigitPattern } from '@gugu/core/shared/unicode-decimal'

type ObjectValue = Record<string, unknown>
type MentionFact = boolean | null
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
function invalid(): never { throw new TypeError('QQ 消息格式无效') }
function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return invalid()
}
const facePattern = '<faceType=(?<face_type>[^,>]+),faceId="(?<face_id>[^"]*)",ext="(?<ext>[^"]*)">'
const faceRegex = () => new RegExp(facePattern, 'gu')
export interface QqEmojiRef { face_type: string; face_id: string }
export function extractQqFaces(value: string): QqEmojiRef[] {
  return [...value.matchAll(faceRegex())].map(match => ({ face_type: match.groups!.face_type!, face_id: match.groups!.face_id! }))
}
export function normalizeQqFaces(value: string): string {
  return value.replace(faceRegex(), (...args: unknown[]) => {
    const groups = args.at(-1) as Record<string, string>
    if (groups.ext) {
      try {
        const binary = atob(groups.ext + '='.repeat((4 - groups.ext.length % 4) % 4))
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))))
        if (object(parsed)) { const label = text(parsed.text || '').trim(); if (label) return label }
      } catch { /* 协议ext无效时保留固定历史占位，不输出原始编码。 */ }
    }
    return '[QQ表情]'
  })
}
export function normalizeQqAttachmentPlaceholders(value: string, attachments: readonly unknown[]): string {
  if (!attachments.length) return value
  const pattern = new RegExp(`<attachmentType="(?<mime>[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+)",attachmentIndex=(?<index>${decimalDigitPattern}+),description="[^"]*">`, 'gu')
  const normalized = value.replace(pattern, (match, ...args: unknown[]) => {
    const groups = args.at(-1) as Record<string, string>, index = Number(asciiDecimalDigits(groups.index!))
    if (!Number.isSafeInteger(index) || index >= attachments.length) return match
    const attachment = attachments[index]
    if (!object(attachment)) return match
    const mime = text(attachment.content_type || attachment.mime || attachment.type || '').split(';', 1)[0]!.trim().toLowerCase()
    return mime === groups.mime!.toLowerCase() ? '' : match
  })
  return normalized === value ? value : normalized.trim()
}
function sceneValue(data: ObjectValue, key: string): string {
  const ext = object(data.message_scene) && Array.isArray(data.message_scene.ext) ? data.message_scene.ext : []
  for (const item of ext) {
    if (typeof item === 'string' && item.startsWith(key + '=')) return item.slice(key.length + 1).trim()
    if (object(item) && item.key === key) return text(item.value || '').trim()
    if (object(item) && key in item) return text(item[key] || '').trim()
  }
  return ''
}
function collectMedia(value: unknown): ObjectValue[] {
  const result: ObjectValue[] = []; let visited = 0
  function walk(item: unknown, depth: number): void {
    if (++visited > 10000 || depth > 64) return invalid()
    if (Array.isArray(item)) { for (const child of item) walk(child, depth + 1); return }
    if (!object(item)) return
    const url = item.url || item.file_url || item.download_url || item.downloadUrl || item.href || item.file || item.image_url || item.origin_url || item.preview_url
    if (typeof url === 'string' && url) result.push({ url, filename: item.filename || item.file_name || item.name || '引用图片.jpg', content_type: item.content_type || item.type })
    for (const child of Object.values(item)) walk(child, depth + 1)
  }
  walk(value, 0)
  return result
}
function directQuote(data: ObjectValue): { text: string; attachments: ObjectValue[] } {
  let element = [data.message_reference, data.reference, data.quote].find(object)
  if (!element) {
    const elements = Array.isArray(data.msg_elements) ? data.msg_elements.filter(object) : []
    const reference = sceneValue(data, 'ref_msg_idx') || sceneValue(data, 'msg_ref_idx')
    if (reference) element = elements.find(item => text(item.msg_idx) === reference) || elements.find(item => text(item.msg_idx) !== sceneValue(data, 'msg_idx'))
  }
  if (!element) return { text: '', attachments: [] }
  const body = text(element.content || element.text || '').trim().replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  const items = [...(Array.isArray(element.attachments) ? element.attachments.filter(object) : []), ...collectMedia(element)]
  const seen = new Set<unknown>()
  const attachments = items.filter(item => {
    if (item.url && seen.has(item.url)) return false
    if (item.url) seen.add(item.url)
    return true
  }).map(item => ({ ...item }))
  return { text: body, attachments }
}
function mentions(data: ObjectValue, group: boolean) {
  if (!group) return { current: false, otherBot: false, otherMember: false, unresolved: false, botId: '' }
  if (!Array.isArray(data.mentions)) return { current: null, otherBot: null, otherMember: null, unresolved: false, botId: '' }
  let current = false, otherBot = false, otherMember = false, unresolved = false, botId = ''
  for (const item of data.mentions) {
    if (!object(item) || typeof item.bot !== 'boolean') { unresolved = true; continue }
    if (item.bot) {
      if (item.is_you === true) {
        current = true
        if (!botId) botId = text(item.id || item.user_openid || item.member_openid || item.openid || '')
      } else if (item.is_you === false) otherBot = true
      else unresolved = true
    } else otherMember = true
  }
  const unknownOnly = unresolved && !current && !otherBot && !otherMember
  return { current: unknownOnly ? null : current, otherBot: unknownOnly ? null : otherBot, otherMember: unknownOnly ? null : otherMember, unresolved, botId }
}
export function qqPlatformSentMs(data: ObjectValue): number | null {
  const value = data.timestamp
  let parsed: number
  if (typeof value === 'number') parsed = Math.trunc(value)
  else if (typeof value === 'string') {
    const normalized = asciiDecimalDigits(value.trim())
    if (!/^[+-]?\d(?:_?\d)*$/.test(normalized)) return null
    parsed = Number(normalized.replaceAll('_', ''))
  } else return null
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  const result = parsed < 10000000000 ? parsed * 1000 : parsed
  return Number.isSafeInteger(result) ? result : null
}
export interface QqMediaRequirement { source: 'message' | 'quote'; attachmentIndex: number; sourcePlatformMessageId: string | null; item: ObjectValue }
export interface QqInboundPayload extends ObjectValue {
  platform: 'qq'; channel_id: string; bot_id: string; owner_user_id: string; platform_user_id: string; platform_user_name: string | null
  platform_bot_user_id: string | null; message_id: string; platform_message_id: string; platform_sent_ms: number | null
  chat_type: 'group' | 'c2c'; chat_id?: string; text: string; attention_raw_text: string; quoted_text: string | null
  attachments: string[]; emoji_refs: QqEmojiRef[]; qq_face_marker: boolean
  bot_mentioned: boolean; group_mentioned: boolean; native_bot_mentioned: MentionFact; mentions_other_bot: MentionFact
  mentions_other_member: MentionFact; has_unresolved_mention: boolean
  reply_to_platform_message_id: string | null; reply_target_sender_id: string | null; reply_target_is_bot: MentionFact
}
export interface ParsedQqMessage {
  payload: QqInboundPayload
  rawText: string
  preflight: ObjectValue
  mediaItems: QqMediaRequirement[]
  /** Host用完整scope查询引用索引，不能按裸ref ID跨群或跨Bot查找。 */
  quoteRequest: { referenceIndex: string; chatType: 'group' | 'c2c'; chatId: string; senderId: string; contentRequired: boolean } | null
  /** 含正文/签名URL，只能在前置安全检查后交给受控索引，不能日志或明文跨端同步。 */
  indexEntry: ObjectValue
  splitFace: { waitForImage: boolean; faceOnly: boolean; emojiRefs: QqEmojiRef[] }
}

/** WS回调已验证事件来源后调用；群策略、绑定码、引用存储、媒体与分离表情关联留Host。 */
export function parseQqMessage(eventType: string, raw: unknown, options: { botId: string; ownerId: string }): ParsedQqMessage | null {
  if (!['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(eventType) || !object(raw)) return null
  if (!options.botId || !options.ownerId) return invalid()
  const group = eventType !== 'C2C_MESSAGE_CREATE', author = object(raw.author) ? raw.author : {}
  const senderId = text(author.user_openid || (group ? author.member_openid : '') || author.id || '')
  const senderName = text(author.username || author.nickname || '').trim(), chatId = group ? text(raw.group_openid) : ''
  const messageId = text(raw.id || '')
  if (!senderId || !messageId || group && !chatId) return null
  const rawText = text(raw.content || '').trim(), rawAttachments = Array.isArray(raw.attachments) ? raw.attachments : []
  const emojiRefs = extractQqFaces(rawText), faceOnly = emojiRefs.length > 0 && !rawText.replace(faceRegex(), '').trim()
  let body = normalizeQqAttachmentPlaceholders(normalizeQqFaces(rawText), rawAttachments)
  const preflightBody = body, quote = directQuote(raw), reference = sceneValue(raw, 'ref_msg_idx')
  let quotedText = normalizeQqFaces(normalizeQqAttachmentPlaceholders(quote.text, quote.attachments))
  if (quote.attachments.length && quotedText === '[QQ表情]') quotedText = ''
  const mediaItems: QqMediaRequirement[] = []
  rawAttachments.forEach((item, index) => {
    if (object(item)) mediaItems.push({ source: 'message', attachmentIndex: index, sourcePlatformMessageId: null, item: { ...item, ...(emojiRefs.length ? { qq_face: true } : {}) } })
  })
  quote.attachments.forEach((item, index) => {
    const sourceId = reference || text(item.source_platform_message_id) || null
    mediaItems.push({ source: 'quote', attachmentIndex: index, sourcePlatformMessageId: sourceId,
      item: { ...item, quoted: true, source_platform_message_id: sourceId, source_attachment_index: index } })
  })
  const waitForImage = faceOnly && !mediaItems.length && !quotedText && emojiRefs.every(item => item.face_type === '6')
  if (emojiRefs.length && mediaItems.length) body = normalizeQqFaces(rawText.replace(faceRegex(), '').trim())
  if (faceOnly && !mediaItems.length && !body.trim()) body = '[QQ表情]'
  if (!body && !mediaItems.length && !quotedText && !reference) return null
  const facts = mentions(raw, group), chatType = group ? 'group' : 'c2c', platformMessageId = sceneValue(raw, 'msg_idx') || messageId
  const payload: QqInboundPayload = { platform: 'qq', channel_id: options.botId, bot_id: options.botId, owner_user_id: options.ownerId,
    platform_user_id: senderId, platform_user_name: senderName || null, platform_bot_user_id: facts.botId || null,
    message_id: messageId, platform_message_id: platformMessageId, platform_sent_ms: qqPlatformSentMs(raw), chat_type: chatType, ...(group ? { chat_id: chatId } : {}),
    text: body, attention_raw_text: body, quoted_text: quotedText || null, attachments: [], emoji_refs: faceOnly ? emojiRefs : [], qq_face_marker: emojiRefs.length > 0,
    bot_mentioned: facts.current === true, group_mentioned: facts.current === true, native_bot_mentioned: facts.current, mentions_other_bot: facts.otherBot,
    mentions_other_member: facts.otherMember, has_unresolved_mention: facts.unresolved, reply_to_platform_message_id: reference || null,
    reply_target_sender_id: null, reply_target_is_bot: null }
  return { payload, rawText, mediaItems, splitFace: { waitForImage, faceOnly, emojiRefs },
    preflight: { platform: 'qq', channel_id: options.botId, owner_user_id: options.ownerId, platform_user_id: senderId, message_id: messageId,
      chat_type: chatType, chat_id: chatId || null, text: preflightBody, raw_text: rawText, attachments: rawAttachments.length ? [{ pending_media: true }] : [], emoji_refs: faceOnly ? emojiRefs : [] },
    quoteRequest: reference ? { referenceIndex: reference, chatType, chatId, senderId, contentRequired: !quotedText && !quote.attachments.length } : null,
    indexEntry: { message_index: platformMessageId, message_id: messageId, sender_id: senderId, sender_is_bot: typeof author.bot === 'boolean' ? author.bot : null,
      sender_name: senderName, content: Array.from(normalizeQqAttachmentPlaceholders(rawText, rawAttachments)).slice(0, 200).join(''),
      attachments: rawAttachments.filter(object).map(item => Object.fromEntries(['url', 'filename', 'content_type', 'file_url', 'download_url'].filter(key => item[key]).map(key => [key, item[key]]))), timestamp: text(raw.timestamp) } }
}
