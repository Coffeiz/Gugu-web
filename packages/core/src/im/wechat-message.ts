import { asciiDecimalDigits } from '../shared/unicode-decimal.js'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const truthy = (value: unknown): boolean => object(value) ? Object.keys(value).length > 0 : Array.isArray(value) ? value.length > 0 : Boolean(value)
function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new TypeError('微信消息文本格式无效')
  return value
}
function field(item: ObjectValue, name: string): ObjectValue {
  const value = item[name]
  if (value === undefined || value === null) return {}
  if (!object(value)) throw new TypeError('微信消息项目格式无效')
  return value
}

export interface WechatQuote {
  quotedText: string | null
  /** 原始图片描述含AES材料及CDN参数，只供Host内存使用，不得记录或发给模型。 */
  mediaItems: ObjectValue[]
}

/** iLink通常不给引用原文；保留旧占位，不凭msg_id猜测原文或扩展文件/视频下载。 */
export function extractWechatQuote(refMessage: unknown): WechatQuote {
  if (!object(refMessage)) return { quotedText: null, mediaItems: [] }
  const title = text(refMessage.title).trim()
  const item = refMessage.message_item
  if (!object(item)) return { quotedText: title || null, mediaItems: [] }
  const body = text(field(item, 'text_item').text).trim()
  if (body) return { quotedText: body, mediaItems: [] }
  if (item.type === 3 || truthy(item.voice_item))
    return { quotedText: text(field(item, 'voice_item').text).trim() || '[语音消息]', mediaItems: [] }
  if (item.type === 2 || truthy(item.image_item))
    return { quotedText: '[图片消息]', mediaItems: [{ type: 2, image_item: field(item, 'image_item') }] }
  if (item.type === 4 || truthy(item.file_item)) return { quotedText: '[文件消息]', mediaItems: [] }
  if (item.type === 5 || truthy(item.video_item)) return { quotedText: '[视频消息]', mediaItems: [] }
  return { quotedText: title || '[微信暂不支持消息引用识别]', mediaItems: [] }
}

/** 保留Python int转换语义；超出JS精确整数范围的值拒绝用作消息顺序。 */
export function wechatPlatformSentMs(message: ObjectValue): number | null {
  const value = message.create_time_ms
  if (typeof value !== 'number' && typeof value !== 'string') return null
  let parsed: number
  if (typeof value === 'number') parsed = Math.trunc(value)
  else {
    const normalized = asciiDecimalDigits(value.trim())
    if (!/^[+-]?\d(?:_?\d)*$/.test(normalized)) return null
    parsed = Number(normalized.replaceAll('_', ''))
  }
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export interface WechatInboundPayload extends ObjectValue {
  platform: 'wechat'
  channel_id: string
  bot_id: string
  owner_user_id: string
  platform_user_id: string
  /** 与Python兼容；这是会话秘密，Host持久化前必须加密，禁止作为可见日志/模型输入。 */
  message_id: string
  context_token: string
  platform_sent_ms: number | null
  chat_type: 'group' | 'c2c'
  chat_id?: string
  wechat_group_id: string
  text: string
  quoted_text: string | null
  /** 解析阶段始终为空；只有Host实际下载/解密/授权暂存后才能填真实ID。 */
  attachments: string[]
}
export interface WechatMediaRequirement {
  source: 'message' | 'quote'
  kind: 'image' | 'unsupported'
  /** 含平台媒体秘密，只留内存；不允许直接入模型、日志或明文队列。 */
  item: ObjectValue
}
export interface ParsedWechatMessage {
  payload: WechatInboundPayload
  mediaItems: WechatMediaRequirement[]
  hasQuote: boolean
}

/**
 * 只解析用户→Bot消息。凭据预检、媒体、typing和入队由Host按该顺序执行。
 * Host在预检通过后处理mediaItems，只有unsupported媒体且无正文时不得启动Agent。
 */
export function parseWechatMessage(message: unknown, options: { botId: string; ownerId: string }): ParsedWechatMessage | null {
  if (!object(message) || message.message_type !== 1) return null
  if (!options.botId || !options.ownerId) throw new TypeError('微信Bot身份未配置')
  const sender = text(message.from_user_id)
  if (!sender) return null
  const contextToken = text(message.context_token), groupId = text(message.group_id)
  const rawItems = message.item_list ?? []
  if (!Array.isArray(rawItems) || rawItems.some(item => !object(item))) throw new TypeError('微信消息项目列表无效')
  const items = rawItems as ObjectValue[]
  let body = items.map(item => text(field(item, 'text_item').text)).join('').trim()
  const voices = items.filter(item => item.type === 3).map(item => {
    const transcript = text(field(item, 'voice_item').text).trim()
    return transcript ? `🎤 用户发来一条语音（已转文字）：「${transcript}」。请直接听懂这段话并自然回应——这是对话内容，不是文件，别问「要不要保存」这类话。`
      : '🎤 用户发来一条语音，但转写失败/没听清，麻烦让用户用文字重新说一下。'
  })
  if (voices.length) body = (body ? body + '\n\n' : '') + voices.join('\n\n')
  const nonText = items.filter(item => item.type !== 1 && item.type !== 3)
  // 与Python一致：空正文/无当前媒体在引用解析之前早退，不能只凭引用启动Agent。
  if (!body && !nonText.length) return null
  let quote: WechatQuote = { quotedText: null, mediaItems: [] }
  for (const item of items) {
    const candidate = extractWechatQuote(item.ref_msg)
    if (candidate.quotedText || candidate.mediaItems.length) { quote = candidate; break }
  }
  const requirement = (item: ObjectValue, source: WechatMediaRequirement['source']): WechatMediaRequirement => ({
    source, kind: truthy(item.image_item) ? 'image' : 'unsupported', item: structuredClone(item),
  })
  return {
    payload: { platform: 'wechat', channel_id: options.botId, bot_id: options.botId, owner_user_id: options.ownerId,
      platform_user_id: sender, message_id: contextToken, context_token: contextToken, platform_sent_ms: wechatPlatformSentMs(message),
      chat_type: groupId ? 'group' : 'c2c', ...(groupId ? { chat_id: groupId } : {}), wechat_group_id: groupId,
      text: body, quoted_text: quote.quotedText, attachments: [] },
    mediaItems: [...nonText.map(item => requirement(item, 'message')), ...quote.mediaItems.map(item => requirement(item, 'quote'))],
    hasQuote: !!quote.quotedText || quote.mediaItems.length > 0,
  }
}
