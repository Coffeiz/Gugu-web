
import { contentText,formatCompactedSummary } from '../context/compaction.js'
import type { Block,CanonicalMessage,HistoryEnvelope,HistoryIdentity,HistoryRenderOptions,Json,PersistedHistoryRow } from '../contracts.js'
import type { HistoryReaderPort } from '../ports.js'
import { blocks,copy,normalizeHistoryMessage } from './canonical-history.js'

export function validSeq(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 }

export function effectiveSeq(row: PersistedHistoryRow): number { return row.historyAnchorSeq ?? row.conversationSeq }

export function epochMicros(value: string | null | undefined): bigint {
  if (!value)
    return -9223372036854775808n
  const normalized = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const millis = Date.parse(normalized)
  if (!Number.isFinite(millis))
    throw new Error('历史时间无效')
  const fraction = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(normalized)?.[1] ?? ''
  return BigInt(millis) * 1000n + BigInt(fraction.slice(3, 6).padEnd(3, '0') || '0')
}

export function historyOrderKey(row: PersistedHistoryRow): readonly [
  bigint,
  number,
  number,
  number,
  number
] {
  const platform = row.platformSentMs, received = row.eventReceivedMs
  const timestamp = typeof platform === 'number' && platform > 0 ? BigInt(Math.trunc(platform * 1000))
    : typeof received === 'number' && received > 0 ? BigInt(Math.trunc(received * 1000)) : epochMicros(row.createdAt || row.sentAt)
  return [timestamp, received ?? 0, effectiveSeq(row), row.historyAnchorSeq != null ? 0 : 1, row.conversationSeq]
}

export function compare(a: PersistedHistoryRow, b: PersistedHistoryRow): number {
  const left = historyOrderKey(a), right = historyOrderKey(b)
  for (let index = 0;index < left.length;index++)
    if (left[index]! < right[index]!)
      return -1
    else if (left[index]! > right[index]!)
      return 1
  return 0
}

export function validateHistoryRows(identity: HistoryIdentity, rows: readonly PersistedHistoryRow[]): void {
  const ids = new Set<string>(), sequences = new Set<number>()
  for (const row of rows) {
    if (row.ownerId !== identity.ownerId || row.sessionId !== identity.sessionId)
      throw new Error('历史归属不匹配')
    if (!validSeq(row.conversationSeq) || !validSeq(effectiveSeq(row)) || ids.has(row.id) || sequences.has(row.conversationSeq))
      throw new Error('历史身份或序号无效')
    if (row.coversUntilSeq != null && !validSeq(row.coversUntilSeq))
      throw new Error('摘要覆盖水位无效')
    ids.add(row.id)
    sequences.add(row.conversationSeq)
  }
}

export function selectSessionHistory(identity: HistoryIdentity, rows: readonly PersistedHistoryRow[], baselineSeq: number): {
  rows: PersistedHistoryRow[]
  effectiveBaselineSeq: number
} {
  if (!validSeq(baselineSeq))
    throw new Error('历史 baseline 无效')
  validateHistoryRows(identity, rows)
  const summaries = rows.filter(row => row.role === 'summary').sort((a, b) => effectiveSeq(b) - effectiveSeq(a)
    || Number(b.historyAnchorSeq == null) - Number(a.historyAnchorSeq == null) || b.conversationSeq - a.conversationSeq)
  const summary = summaries[0]
  const effectiveBaselineSeq = Math.max(baselineSeq, summary?.coversUntilSeq ?? 0)
  const history = rows.filter(row => row.role !== 'summary' && !row.runId?.startsWith('im-pending:')
    && (effectiveBaselineSeq <= 0 || effectiveSeq(row) > effectiveBaselineSeq)).sort(compare)
  return { rows: copy(summary ? [summary, ...history] : history), effectiveBaselineSeq }
}

export async function loadSessionHistory(identity: HistoryIdentity, port: HistoryReaderPort, signal?: AbortSignal, options: {
  loadImages?: boolean
} = {}): Promise<{
  rows: PersistedHistoryRow[]
  effectiveBaselineSeq: number
}> {
  signal?.throwIfAborted()
  const read = await port.read(identity, signal)
  const selected = selectSessionHistory(identity, read.rows, read.baselineSeq)
  signal?.throwIfAborted()
  // read本身不得eager-load无限图片；只有受控二阶段sizes/payload端口可以提供历史快照。
  for (const row of selected.rows) {
    if (row.providerImageContent != null)
      throw new Error('历史图片必须通过受控二阶段端口读取，不能随正文eager-load')
    delete row.providerImageContent
  }
  if (options.loadImages) {
    if (!port.images)
      throw new Error('历史图片回放已开启但缺少授权读取端口')
    const candidates = [...selected.rows].reverse().filter(row => row.role === 'user').slice(0, 48).map(row => row.id)
    if (candidates.length) {
      const sizes = await port.images.readSizes(identity, candidates, signal)
      signal?.throwIfAborted()
      const candidateSet = new Set(candidates)
      if ([...sizes.keys()].some(id => !candidateSet.has(id)))
        throw new Error('历史图片大小查询返回了范围外消息')
      const chosen = selectImageSnapshots(selected.rows, sizes)
      if (chosen.ids.length) {
        const payloads = await port.images.readPayloads(identity, chosen.ids, signal)
        signal?.throwIfAborted()
        const allowed = new Set(chosen.ids)
        if ([...payloads.keys()].some(id => !allowed.has(id)))
          throw new Error('历史图片返回了未授权的消息快照')
        let actualBytes = 0
        for (const payload of payloads.values())
          actualBytes += new TextEncoder().encode(JSON.stringify(payload)).byteLength
        if (actualBytes > 8 * 1024 * 1024)
          throw new Error('历史图片读取量超过8MiB上限')
        const limited = limitImageBlocks(payloads, chosen.ids)
        for (const row of selected.rows)
          if (limited.has(row.id))
            row.providerImageContent = copy(limited.get(row.id)!)
      }
    }
    signal?.throwIfAborted()
  }
  if (port.hydrateReferences) {
    const authorizedImages = new Map(selected.rows.flatMap(row => row.providerImageContent ? [[row.id, copy(row.providerImageContent)] as const] : []))
    const hydrated = await port.hydrateReferences(identity, copy(selected.rows), signal)
    signal?.throwIfAborted()
    validateHistoryRows(identity, hydrated)
    if (hydrated.length !== selected.rows.length || hydrated.some((row, index) => row.id !== selected.rows[index]!.id || row.conversationSeq !== selected.rows[index]!.conversationSeq))
      throw new Error('引用恢复改变了历史边界')
    for (const row of hydrated) {
      delete row.providerImageContent
      const images = authorizedImages.get(row.id)
      if (images)
        row.providerImageContent = copy(images)
    }
    selected.rows = hydrated
  }
  return selected
}

export function normalizePersistedRow(row: PersistedHistoryRow): HistoryEnvelope {
  return normalizeHistoryMessage({
    role: row.role, content: row.content, content_json: row.contentJson,
    sent_at: row.sentAt ?? null, quoted_text: row.quote ?? null, files: row.files ?? [],
    platform_user_id: row.senderId ?? null, platform_user_name: row.senderName ?? null, source: row.source ?? null
  })
}

export function restoreHistoryMessage(row: PersistedHistoryRow): CanonicalMessage {
  const cleanRow = copy(row)
  if (cleanRow.contentJson != null)
    cleanRow.contentJson = stripHistoryMedia(cleanRow.contentJson)
  if (Array.isArray(cleanRow.contentJson))
    cleanRow.contentJson = cleanRow.contentJson.filter(value => !value || typeof value !== 'object' || Array.isArray(value)
      || !['thinking', 'redacted_thinking', 'reasoning_content'].includes(String(value.type)))
  const envelope = normalizePersistedRow(cleanRow)
  const content = envelope.contentBlocks.filter(block => !['thinking', 'redacted_thinking', 'reasoning_content'].includes(block.type))
  return {
    role: row.role, content, _history_id: row.id,
    _history_envelope: { quote: envelope.quote, attachments: envelope.attachments, sender: envelope.sender, sent_at: envelope.sentAt, source: envelope.source }
  }
}

/** 在Harness中重建引用/发言人/消息时间语义；Provider adapter只需处理协议wire。 */
export function restoreHistoryForRequest(row: PersistedHistoryRow, options: HistoryRenderOptions): CanonicalMessage | null {
  const message = restoreHistoryMessage(row)
  if (row.role === 'summary')
    return { ...message, role: 'user', content: formatCompactedSummary(contentText(message.content)) }
  if (row.role === 'user' && options.allowHistoricalImages && row.providerImageContent?.some(block => ['image', 'image_url'].includes(block.type)))
    return { ...message, content: copy(row.providerImageContent) }
  const values = blocks(message.content)
  if (row.role === 'assistant' && !values.some(block => ['tool_call', 'tool_use'].includes(block.type)
    || block.type === 'text' && String(block.text ?? '').trim()) && !row.files?.length && !row.quote)
    return null
  if (row.role !== 'user')
    return message
  const isTool = values.some(block => block.type === 'tool_result')
  const inlineReference = values.some(block => block.type === 'knowledge-context' && block.scope === 'explicit-reference') && values.some(block => block.type === 'text')
  const eventTypes = new Set(['knowledge-context', 'tool-schema', 'skill-schema', 'tool-discovery', 'stance-context', 'time-context', 'runtime-context'])
  const isEvent = values.some(block => eventTypes.has(block.type)) && !inlineReference
  const actualUser = !isTool && !isEvent && !['rag', 'stance', 'message_time', 'runtime'].includes(row.source ?? '')
  const envelope = normalizePersistedRow(row)
  let content: Json = row.contentJson == null ? formatHistoricalText(envelope, options.groupChat === true && row.chatType === 'group') : copy(message.content)
  if (row.contentJson != null && !isTool) {
    const quote = row.quote ? formatQuotedContext('', row.quote) : ''
    const refs = formatAttachmentReferences(envelope.attachments)
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
    content = [...(quote ? [{ type: 'text', text: quote }] : []), ...parts, ...(refs ? [{ type: 'text', text: refs }] : [])]
  }
  if (actualUser) {
    const timestamp = row.platformSentMs != null && row.platformSentMs > 0 ? row.platformSentMs
      : row.eventReceivedMs != null && row.eventReceivedMs > 0 ? row.eventReceivedMs : row.createdAt || row.sentAt
    let time: string | null = null
    if (timestamp != null) {
      if (!options.userTimezone || !options.formatMessageTime)
        throw new Error('恢复消息时间需要可信时区和格式化端口')
      time = options.formatMessageTime(timestamp, options.userTimezone)
    }
    content = wrapMessageTime(content, time)
  }
  return { ...message, content }
}

export function protectedMessageIds(rows: readonly PersistedHistoryRow[], keepRounds = 10): Set<string> {
  const keep = Math.max(1, Math.trunc(keepRounds))
  const latestRun = [...rows].reverse().find(row => row.runId)?.runId
  if (!latestRun || !rows.at(-1)?.runId) {
    const units: PersistedHistoryRow[][] = []
    for (const row of rows) {
      const previous = units.at(-1)
      if (row.canonicalBatchId != null && previous?.[0]?.canonicalBatchId === row.canonicalBatchId)
        previous.push(row)
      else
        units.push([row])
    }
    return new Set(units.slice(-keep).flat().map(row => row.id))
  }
  const latest = rows.filter(row => row.runId === latestRun)
  const rounds = [...new Set(latest.flatMap(row => /^round-(\d+)$/.exec(row.roundId ?? '')?.[1] ? [Number(row.roundId!.slice(6))] : []))].sort((a, b) => a - b).slice(-keep)
  return new Set(latest.filter(row => rounds.includes(Number(row.roundId?.slice(6)))).map(row => row.id))
}

/** 历史媒体载荷有独立预算；正文始终完整加载，不按字符或条数截断。 */
export function selectImageSnapshots(rows: readonly PersistedHistoryRow[], sizes: ReadonlyMap<string, number>): {
  ids: string[]
  bytes: number
} {
  const candidates = [...rows].reverse().filter(row => row.role === 'user').slice(0, 48)
  const ids: string[] = []
  let bytes = 0
  for (const row of candidates) {
    const size = sizes.get(row.id)
    if (size == null || !Number.isSafeInteger(size) || size < 0 || size > 8 * 1024 * 1024 - bytes)
      continue
    ids.push(row.id)
    bytes += size
    if (ids.length >= 12)
      break
  }
  return { ids, bytes }
}

export function limitImageBlocks(payloads: ReadonlyMap<string, readonly Block[]>, selectedIds: readonly string[]): Map<string, Block[]> {
  const result = new Map<string, Block[]>()
  let remaining = 12
  for (const id of selectedIds) {
    const payload = payloads.get(id)
    if (!payload || remaining <= 0)
      continue
    let count = 0
    const kept = payload.filter(block => {
      if (!['image', 'image_url'].includes(block.type))
        return true
      if (count >= remaining)
        return false
      count++
      return true
    })
    if (count) {
      result.set(id, copy(kept))
      remaining -= count
    }
  }
  return result
}

export function hasOnlyLegacyTimeContext(row: PersistedHistoryRow): boolean {
  const values = blocks(row.contentJson)
  return Array.isArray(row.contentJson) && values.length > 0 && values.length === row.contentJson.length && values.every(block => block.type === 'time-context')
}

export const text_imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tiff', 'tif'])

export const text_videoExtensions = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v'])

/** 稳定的附件使用说明不是权限声明；真实可读范围仍由工具注册和执行器逐调用判定。 */
export function formatAttachmentReferences(attachments: readonly Block[]): string {
  const images: string[] = [], videos: string[] = [], files: string[] = []
  for (const ref of attachments) {
    if (!ref.attach_id)
      continue
    const kind = String(ref.kind ?? '').toLowerCase(), ext = String(ref.ext ?? '').toLowerCase(), name = String(ref.name ?? '')
    const label = name && ext ? `${name}.${ext}` : name || ext || '未命名'
    if (kind === 'image' || text_imageExtensions.has(ext))
      images.push(`attach_id=${ref.attach_id}${name ? `，名称=${name}` : ''}`)
    else if (kind === 'video' || text_videoExtensions.has(ext))
      videos.push(`attach_id=${ref.attach_id}，文件=${label}`)
    else if (kind !== 'voice')
      files.push(`attach_id=${ref.attach_id}，文件=${label}`)
  }
  const parts: string[] = []
  if (images.length)
    parts.push(`[历史图片附件，仅在用户要求回看/分析时调用 read_file(items=[{attach_id: ...}]) 读取：${images.join('；')}]`)
  if (videos.length)
    parts.push(`[历史视频附件，仅在用户要求理解/总结视频时直接调用 read_file(attach_id=...) 原生读取；不要先 save_uploaded_file 或用 Shell/ffmpeg 抽帧，除非用户明确要求抽帧/逐帧分析：${videos.join('；')}]`)
  if (files.length)
    parts.push(`[历史文件附件，仅在用户要求回看/读取内容时，先调用 save_uploaded_file(attach_id) 把附件转存进文件库再读：${files.join('；')}]`)
  return parts.length ? '\n' + parts.join('\n') : ''
}

export function formatQuotedContext(content: string, quote?: string | null): string {
  return quote ? `💬 用户引用/回复了一条历史消息（原文：「${quote}」），针对这条消息说：\n\n${content}` : content
}

export function formatGroupMessage(input: {
  body: string
  senderId?: string | null
  senderName?: string | null
  quote?: string | null
  attachmentIds?: readonly string[]
  attachmentContext?: string | null
}): string {
  const lines = ['【群消息】', '【发言人元数据】', `平台 ID：${input.senderId || '未提供'}`, `显示名：${input.senderName || '未提供'}`, '【消息正文】', input.body]
  if (input.quote)
    lines.push('【引用消息】', input.quote)
  if (input.attachmentIds?.length)
    lines.push('【附件 ID】', input.attachmentIds.join(', '))
  if (input.attachmentContext)
    lines.push('【补充上下文】', input.attachmentContext)
  return lines.join('\n')
}

export function text_text(value: Json | undefined): string {
  if (typeof value === 'string')
    return value
  if (Array.isArray(value))
    return value.map(item => item && typeof item === 'object' && !Array.isArray(item)
      ? String(item.text ?? item.content ?? '') : '').filter(Boolean).join('\n')
  return ''
}

/** Provider-neutral历史可读文字。媒体/wire转换另由Provider adapter负责。 */
export function formatHistoricalText(envelope: HistoryEnvelope, groupChat: boolean): string {
  const body = envelope.contentBlocks.filter(block => ['text', 'transcript', 'attachment_text'].includes(block.type)).map(block => text_text(block.text ?? block.content)).join('\n')
  const quote = envelope.quote ? String(envelope.quote.text ?? '') : null
  const attachmentContext = formatAttachmentReferences(envelope.attachments)
  if (groupChat && envelope.role === 'user')
    return formatGroupMessage({
      body, senderId: envelope.sender?.id,
      senderName: envelope.sender?.name, quote, attachmentIds: envelope.attachments.map(ref => String(ref.attach_id)), attachmentContext
    })
  return formatQuotedContext(body, quote) + attachmentContext
}

export function wrapMessageTime(content: Json, time?: string | null): Json {
  const value = (time ?? '').trim().replace(/^\[system-reminder\]\s*|\s*\[\/system-reminder\]$/g, '').replace(/^消息时间：/, '').trim()
  const prefix = value ? `【消息时间】${value}\n` : ''
  const wrapped = (text: string): boolean => text.trimStart().startsWith('【消息正文】')
    || (text.includes('【消息正文】') && (text.trimStart().startsWith('【消息时间】') || text.includes('【群消息】')))
  if (typeof content === 'string')
    return wrapped(content) ? prefix + content : `${prefix}【消息正文】\n${content}`
  if (Array.isArray(content)) {
    const first = content.find(block => !!block && typeof block === 'object' && !Array.isArray(block) && block.type === 'text')
    const firstText = first && typeof first === 'object' && !Array.isArray(first) ? String(first.text ?? '') : ''
    if (wrapped(firstText))
      return [...(prefix ? [{ type: 'text', text: prefix }] : []), ...copy(content)]
    return [{ type: 'text', text: `${prefix}【消息正文】\n` }, ...copy(content)]
  }
  return content && typeof content === 'object'
    ? [{ type: 'text', text: `${prefix}【消息正文】\n` }, copy(content)] : `${prefix}【消息正文】\n${content ?? ''}`
}

/** 仅用于已持久化历史的恢复，不清理当前Run仍需发送给模型的媒体。 */
export function stripHistoryMedia(content: Json): Json {
  if (Array.isArray(content))
    return content.map(stripHistoryMedia)
  if (!content || typeof content !== 'object')
    return content
  const type = content.type
  if (type === 'image' || type === 'video' || type === 'audio')
    return { type: 'text', text: `[${type === 'image' ? '图片' : type === 'video' ? '视频' : '音频'}已查看]` }
  if (type === 'image_url') {
    const image = content.image_url
    const url = image && typeof image === 'object' && !Array.isArray(image) ? image.url : image
    if (typeof url === 'string' && url.startsWith('data:'))
      return { type: 'text', text: '[图片已查看]' }
  }
  return Object.fromEntries(Object.entries(content).map(([key, value]) => [key, stripHistoryMedia(value)]))
}

/** 内部上下文始终保留独立身份，不能借user角色变成本轮用户请求。 */
export const internalBlockTypes = new Set(['tool-schema', 'skill-schema', 'tool-discovery', 'knowledge-context', 'stance-context', 'time-context', 'runtime-context'])

export function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function reminder(value: unknown): boolean { return typeof value === 'string' && value.trimStart().startsWith('[system-reminder]') }

export function isInternalUserMessage(message: unknown): boolean {
  const value = object(message)
  if (value?.role !== 'user')
    return false
  if (reminder(value.content))
    return true
  if (!Array.isArray(value.content) || !value.content.length)
    return false
  return value.content.every(item => {
    const block = object(item)
    return block != null && (internalBlockTypes.has(String(block.type)) || block.type === 'text' && reminder(block.text))
  })
}

export function lastUserIndex(messages: unknown): number | null {
  if (!Array.isArray(messages))
    return null
  for (let index = messages.length - 1;index >= 0;index--)
    if (object(messages[index])?.role === 'user' && !isInternalUserMessage(messages[index]))
      return index
  return null
}

export function userTextFromMessage(message: unknown): string {
  const value = object(message)
  if (value?.role !== 'user')
    return ''
  if (typeof value.content === 'string')
    return reminder(value.content) ? '' : value.content
  if (!Array.isArray(value.content))
    return ''
  return value.content.flatMap(item => {
    const block = object(item)
    if (block?.type !== 'text')
      return []
    const text = String(block.text || '')
    return reminder(text) ? [] : [text]
  }).join('\n')
}
