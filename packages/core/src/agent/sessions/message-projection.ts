import { replacePlatformMentionIds, sanitizeMediaPayload } from '../context/messages/index.js'

export interface AgentMessageProjectionRow {
  id: number
  role: string
  content: string
  is_display_body: boolean
  display_timeline: unknown
  has_display_timeline: boolean
  files?: unknown
  created_at: Date | string
  run_id: string | null
  round_id: string | null
  client_message_id?: string | null
  quoted_text?: string | null
  references_json?: unknown
  platform_user_id?: string | null
  platform_user_name?: string | null
  platform_bot_user_id?: string | null
  run_outcome?: unknown
  im_platform_sent_ms?: number | string | null
  im_event_received_ms?: number | string | null
}

function normalizeQqAttachmentPlaceholders(text: string, files: unknown, quoted = false): string {
  if (!text || !Array.isArray(files) || files.length === 0) return text
  let changed = false
  const normalized = text.replace(
    /<attachmentType="([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)",attachmentIndex=(\d+),description="[^"]*">/g,
    (placeholder, expectedMime: string, rawIndex: string) => {
      const index = Number(rawIndex)
      if (!Number.isSafeInteger(index) || index >= files.length) return placeholder
      const attachment = files[index]
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return placeholder
      const record = attachment as Record<string, unknown>
      if (record.quoted !== quoted) return placeholder
      const rawMime = record.content_type || record.mime || record.type || ''
      const actualMime = String(rawMime).split(';', 1)[0]!.trim().toLowerCase()
      if (actualMime !== expectedMime.toLowerCase()) return placeholder
      changed = true
      return ''
    },
  )
  return changed ? normalized.trim() : text
}

function projectAgentTimelineEvent(raw: unknown, messageId: number, index: number): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = sanitizeMediaPayload(raw) as Record<string, unknown>
  const event = Object.fromEntries(Object.entries(item).filter(([key]) =>
    !(item.kind === 'tool' && (key === 'toolInput' || key === 'toolResult')),
  ))
  return {
    ...event,
    id: `${messageId}:${index}`,
    messageId,
    timelineOrder: item.timelineOrder,
    createdAt: item.createdAt,
    ...(item.kind === 'tool' && ('toolInput' in item || 'toolResult' in item)
      ? { detailsAvailable: true, detailSource: { kind: 'timeline', messageId, index } }
      : {}),
  }
}

/** 仅将可见时间线投影给 UI；工具输入/输出由详情接口按 owner 单独读取。 */
export function projectAgentTimelineEvents(
  messages: Array<{ id: number; displayTimeline: unknown }>,
): unknown[] {
  return messages.flatMap(message => Array.isArray(message.displayTimeline)
    ? message.displayTimeline.flatMap((raw, index) => {
      const event = projectAgentTimelineEvent(raw, message.id, index)
      return event ? [event] : []
    })
    : [])
}

/** 只返回展示正文，不把 canonical 正文或原始时间线泄漏到历史消息 DTO。 */
export function projectAgentMessageBodies(
  messages: AgentMessageProjectionRow[],
  source?: string,
) {
  return projectAgentMessageBodiesWithMentions(messages, source, new Map())
}

/** 组装历史恢复字段，并按 Python 的时间、QQ 附件和群聊提及规则投影。 */
export function projectAgentMessageBodiesWithMentions(
  messages: AgentMessageProjectionRow[],
  source: string | undefined,
  mentionNames: ReadonlyMap<string, string>,
) {
  return messages.flatMap((message) => {
    if (!message.is_display_body || (message.has_display_timeline && message.display_timeline !== null))
      return []
    const files = message.files ?? []
    const normalizedContent = typeof message.content === 'string' && source === 'qq'
      ? normalizeQqAttachmentPlaceholders(message.content, files)
      : message.content
    const normalizedQuotedText = typeof message.quoted_text === 'string' && source === 'qq'
      ? normalizeQqAttachmentPlaceholders(message.quoted_text, files, true)
      : message.quoted_text ?? null
    const content = typeof normalizedContent === 'string'
      ? replacePlatformMentionIds(normalizedContent, mentionNames) ?? normalizedContent
      : normalizedContent
    const quotedText = typeof normalizedQuotedText === 'string'
      ? replacePlatformMentionIds(normalizedQuotedText, mentionNames)
      : normalizedQuotedText
    const platformSentAt = Number(message.im_platform_sent_ms)
    const eventReceivedAt = Number(message.im_event_received_ms)
    const occurredAt = platformSentAt > 0
      ? new Date(platformSentAt).toISOString()
      : eventReceivedAt > 0
        ? new Date(eventReceivedAt).toISOString()
        : new Date(message.created_at).toISOString()
    return [{
      id: message.id,
      role: message.role,
      clientMessageId: message.client_message_id ?? null,
      timelineOrder: message.id * 1_000_000,
      content,
      files,
      references: message.references_json ?? [],
      quotedText,
      platformUserId: message.platform_user_id ?? null,
      platformUserName: message.platform_user_name ?? null,
      platformBotUserId: message.platform_bot_user_id ?? null,
      runOutcome: message.run_outcome ?? null,
      runId: message.run_id,
      roundId: message.round_id,
      createdAt: new Date(message.created_at).toISOString(),
      occurredAt,
      ...(message.has_display_timeline ? { timelineOmitted: true } : {}),
    }]
  })
}
