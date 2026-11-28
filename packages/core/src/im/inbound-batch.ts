/** 平台连接确认后的消息；权限不从消息内容或 mention 推断。 */
export interface ImBatchMessage {
  readonly platform: 'feishu' | 'qq' | 'wechat' | 'telegram'
  readonly botId: string
  readonly chatType: 'c2c' | 'group'
  readonly senderId: string
  readonly chatId: string
  readonly platformSentMs?: number
  readonly botMentioned?: boolean
  readonly mentionsOtherBot?: boolean
  readonly pendingAskResume?: boolean
}

export interface ImInboundItem<T extends ImBatchMessage = ImBatchMessage> {
  readonly eventId: string
  readonly message: T
}

/** 完整作用域同时用于串行锁、缓冲和会话查询；JSON 编码避免分隔符碰撞。 */
export function imConversationKey(message: ImBatchMessage): string {
  if (!['feishu', 'qq', 'wechat', 'telegram'].includes(message.platform)
    || !['c2c', 'group'].includes(message.chatType)
    || !message.botId || !message.senderId || (message.chatType === 'group' && !message.chatId))
    throw new TypeError('IM 消息作用域无效')
  return JSON.stringify([message.platform, message.botId, message.chatType,
    message.chatType === 'group' ? message.chatId : message.senderId])
}

function arrivalKey(value: string): readonly [bigint, bigint] {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value)
  return match ? [BigInt(match[1]!), BigInt(match[2] ?? '0')] : [0n, 0n]
}

function orderKey(item: ImInboundItem): readonly [bigint, bigint] {
  const arrival = arrivalKey(item.eventId)
  const sent = item.message.platformSentMs
  return typeof sent === 'number' && Number.isFinite(sent) && sent > 0
    ? [BigInt(Math.trunc(sent)), arrival[1]] : arrival
}

/** 对齐 Python inbound_batch：先稳定排序，每条当前 Bot mention/问答恢复单独成段。 */
export function partitionImInboundBatch<T extends ImBatchMessage>(batch: readonly ImInboundItem<T>[]): ImInboundItem<T>[][] {
  if (!batch.length) return []
  const scope = imConversationKey(batch[0]!.message)
  if (batch.some(item => imConversationKey(item.message) !== scope))
    throw new TypeError('IM 批次作用域不一致')
  const ordered = [...batch].sort((left, right) => {
    const a = orderKey(left), b = orderKey(right)
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
  })
  const segments: ImInboundItem<T>[][] = []
  let ordinary: ImInboundItem<T>[] = []
  for (const item of ordered) {
    const message = item.message
    if (message.pendingAskResume === true || (message.chatType === 'group'
      && message.botMentioned === true && message.mentionsOtherBot !== true)) {
      if (ordinary.length) segments.push(ordinary)
      ordinary = []
      segments.push([item])
    } else ordinary.push(item)
  }
  if (ordinary.length) segments.push(ordinary)
  return segments
}

export interface ImBatchPayloadItem {
  readonly eventId: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly anchor: { readonly messageId: number; readonly conversationSeq: number }
}

/** 单段聚合保留逐条正文/引用/附件和 speaker 事实；原生回复路由始终取最后一条。 */
export function aggregateImInboundPayloads(items: readonly ImBatchPayloadItem[]): Record<string, unknown> {
  if (!items.length || items.length > 128) throw new TypeError('IM 消息段数量无效')
  const last = items.at(-1)!.payload
  const conversationKey = (p: Readonly<Record<string, unknown>>) => imConversationKey({ platform: p.platform as ImBatchMessage['platform'],
    botId: String(p.bot_id ?? p.channel_id ?? ''), chatType: p.chat_type as ImBatchMessage['chatType'],
    senderId: typeof p.platform_user_id === 'string' ? p.platform_user_id : '', chatId: typeof p.chat_id === 'string' ? p.chat_id : '' })
  const key = conversationKey(last)
  if (items.some(item => conversationKey(item.payload) !== key || item.payload.owner_user_id !== last.owner_user_id)
    || new Set(items.map(item => item.anchor.messageId)).size !== items.length) throw new TypeError('IM 消息段作用域或锚点不一致')
  const hasFace = items.some(item => item.payload.qq_face_marker === true)
  const source: Record<string, unknown>[] = items.map(item => {
    const p = item.payload
    if (typeof p.text !== 'string' || !Number.isSafeInteger(item.anchor.messageId) || item.anchor.messageId < 1)
      throw new TypeError('IM 消息段锚点无效')
    return { ...structuredClone(p), event_id: item.eventId, early_id: item.anchor.messageId,
      _early_message_id: item.anchor.messageId, conversation_seq: item.anchor.conversationSeq }
  })
  const segments = source.map(p => ({ event_id: p.event_id, platform: p.platform, bot_id: p.bot_id ?? p.channel_id,
    channel_id: p.channel_id, chat_id: p.chat_id ?? null, chat_type: p.chat_type, platform_user_id: p.platform_user_id,
    platform_user_name: p.platform_user_name ?? '', text: hasFace && p.qq_face_marker === true && p.text === '[QQ表情]' ? '' : String(p.text).trim(),
    attention_raw_text: p.attention_raw_text ?? p.text, bot_mentioned: p.bot_mentioned === true,
    mentions_other_bot: p.mentions_other_bot === true, platform_message_id: p.platform_message_id ?? p.message_id,
    early_id: p.early_id, conversation_seq: p.conversation_seq, attachments: p.attachments ?? [], quoted_text: p.quoted_text ?? null }))
  const speakers = new Map<string, { platform_user_id: string; platform_user_name: string }>()
  for (const p of source) {
    if (typeof p.platform_user_id !== 'string' || !p.platform_user_id) throw new TypeError('IM 批次发言人无效')
    if (!speakers.has(p.platform_user_id)) speakers.set(p.platform_user_id,
      { platform_user_id: p.platform_user_id, platform_user_name: typeof p.platform_user_name === 'string' ? p.platform_user_name : '' })
  }
  return { ...structuredClone(last), chat_id: last.chat_type === 'group' ? last.chat_id : null,
    text: segments.map(p => p.text).filter(Boolean).join('\n'), attachments: source.flatMap(p => Array.isArray(p.attachments) ? p.attachments : []),
    _batch_messages: source, _speaker_segments: segments, _early_message_ids: items.map(item => item.anchor.messageId),
    _turn_speakers: [...speakers.values()].sort((a, b) => a.platform_user_id < b.platform_user_id ? -1 : a.platform_user_id > b.platform_user_id ? 1 : 0),
    ...(last.chat_type === 'group' ? { bot_mentioned: source.some(p => p.bot_mentioned === true), group_mentioned: source.some(p => p.group_mentioned === true) } : {}),
    qq_face_marker: hasFace }
}
