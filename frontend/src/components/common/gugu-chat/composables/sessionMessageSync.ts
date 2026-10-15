import { assistantMessageSyncKey, type ChatFile, type ChatMessage, type ChatReference } from '../chatTypes'
import { displayQQFaces } from '../messageDisplay'
import { effectiveTimezone } from '@/utils/userTimezone'
import { nextTick, type Ref } from 'vue'
import { agentApi } from '@/services/api'

type SpeakerResolver = (
  role: string,
  platformUserId: string | null | undefined,
  platformUserName: string | null | undefined,
) => { role: string; speakerLabel?: string }

function displayTime(createdAt: string) {
  return new Date(createdAt).toLocaleTimeString('zh', {
    hour: '2-digit', minute: '2-digit', timeZone: effectiveTimezone(),
  })
}

function persistedMessageSyncKey(item: any, resolvedRole: string) {
  return (resolvedRole === 'ai' && assistantMessageSyncKey(item.runId, item.roundId))
    || `message:${item.id}`
}

export function sortSessionTimelineMessages(items: ChatMessage[]) {
  const isPairedInteraction = (a: ChatMessage, b: ChatMessage) =>
    a.role === 'interaction' && b.role === 'tool' &&
    Boolean(a.interaction?.toolCallId) && a.interaction?.toolCallId === b.toolCallId
  return items.sort((a, b) => {
    if (a._timelineOrder != null && b._timelineOrder != null && a._timelineOrder !== b._timelineOrder) {
      return a._timelineOrder - b._timelineOrder
    }
    if (isPairedInteraction(a, b)) return 1
    if (isPairedInteraction(b, a)) return -1
    return String(a._createdAt || '').localeCompare(String(b._createdAt || ''))
  })
}

/** 将消息接口的增量响应统一映射成聊天时间线项目。 */
export function mapSessionMessageDelta(
  data: any,
  mkid: () => number,
  resolveSpeaker: SpeakerResolver,
): ChatMessage[] {
  const messages: ChatMessage[] = (data.messages || []).map((item: any) => {
    const speaker = resolveSpeaker(item.role, item.platformUserId, item.platformUserName)
    const runId = item.runId || undefined
    const roundId = item.roundId || undefined
    return {
      id: mkid(), dbId: item.id,
      _syncKey: persistedMessageSyncKey({ ...item, runId, roundId }, speaker.role),
      role: speaker.role, speakerLabel: speaker.speakerLabel,
      platformUserId: item.platformUserId || null,
      text: displayQQFaces(item.content), html: null,
      files: item.files?.length ? item.files as ChatFile[] : undefined,
      references: item.references?.length ? item.references as ChatReference[] : undefined,
      quotedText: item.quotedText || undefined,
      time: displayTime(item.createdAt), _createdAt: item.createdAt,
      _timelineOrder: item.timelineOrder ?? item.id,
      runId, roundId,
      runOutcome: item.runOutcome,
    }
  })
  const timeline: ChatMessage[] = (data.timelineEvents || []).map((event: any) => event.kind === 'assistant'
    ? {
        id: mkid(), dbId: event.messageId, role: 'ai', text: displayQQFaces(event.text || ''), html: null,
        files: event.files?.length ? event.files as ChatFile[] : undefined,
        linkButtons: event.linkButtons, time: displayTime(event.createdAt),
        runId: event.runId, roundId: event.roundId,
        _timelineOrder: event.timelineOrder, _createdAt: event.createdAt,
        _syncKey: assistantMessageSyncKey(event.runId, event.roundId) || `timeline:${event.id}`,
      }
    : {
        id: mkid(), role: 'tool', text: '', toolCallId: event.toolCallId,
        toolName: event.toolName, toolLabel: event.toolLabel,
        toolStatus: event.toolStatus || (event.toolResult !== undefined ? 'success' : 'running'),
        toolInput: event.toolInput, toolResult: event.toolResult,
        toolDurationMs: event.toolDurationMs,
        time: displayTime(event.createdAt), _timelineOrder: event.timelineOrder,
        _createdAt: event.createdAt, _syncKey: `timeline:${event.id}`,
      })
  const tools: ChatMessage[] = (data.toolEvents || []).map((event: any) => ({
    id: mkid(), role: 'tool', text: '', _syncKey: `tool:${event.id}`,
    time: displayTime(event.createdAt), toolCallId: event.toolCallId,
    toolName: event.toolName, toolLabel: event.toolLabel,
    _timelineOrder: event.timelineOrder,
    toolStatus: event.toolStatus || (event.toolResult !== undefined ? 'success' : 'running'),
    toolInput: event.toolInput, toolResult: event.toolResult,
    toolDurationMs: event.toolDurationMs, _createdAt: event.createdAt,
  }))
  return [...messages, ...timeline, ...tools]
}

/** 从消息快照或逐轮时间线中找出最近一条已持久化的助手回复。 */
export function findLatestPersistedAssistant(data: any, notBefore = 0) {
  const candidates = [
    ...(data.messages || []).flatMap((item: any) => item.role === 'assistant'
      ? [{ item, syncKey: assistantMessageSyncKey(item.runId, item.roundId) || `message:${item.id}`, text: item.content || '' }]
      : []),
    ...(data.timelineEvents || []).flatMap((item: any) => item.kind === 'assistant'
      ? [{ item, syncKey: assistantMessageSyncKey(item.runId, item.roundId) || `timeline:${item.id}`, text: item.text || '' }]
      : []),
  ].filter(({ item, text }) => {
    const hasContent = Boolean(text?.trim() || item.files?.length)
    const createdAt = Date.parse(item.createdAt || '')
    return hasContent && (!Number.isFinite(createdAt) || createdAt >= notBefore)
  })
  .sort((a, b) => Date.parse(b.item.createdAt || '') - Date.parse(a.item.createdAt || ''))

  const latest = candidates[0]
  if (!latest) return null
  return { item: latest.item, text: latest.text, syncKey: latest.syncKey }
}

/** 合并从持久化会话增量恢复的消息；重复事件更新内容但不重复创建气泡。 */
export function mergeSessionMessageDelta(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  if (!incoming.length) return current

  const result = [...current]
  const indexByKey = new Map<string, number>()
  result.forEach((message, index) => {
    if (message._syncKey) indexByKey.set(message._syncKey, index)
  })

  for (const message of incoming) {
    const key = message._syncKey
    const index = key ? indexByKey.get(key) : undefined
    if (index == null) {
      if (key) indexByKey.set(key, result.length)
      result.push(message)
      continue
    }
    result[index] = { ...result[index], ...message, id: result[index].id }
  }
  return result
}

/** 搜索命中较早历史消息时，按目标 ID 一次读取有界历史页并并入当前时间线。 */
export async function ensureSessionMessageLoaded(options: {
  sessionId: number
  messageId: number
  messages: Ref<ChatMessage[]>
  mkid: () => number
  resolveSpeaker: SpeakerResolver
  isCurrent?: () => boolean
}): Promise<boolean> {
  if (options.messages.value.some(message => message.dbId === options.messageId)) return true
  if (options.isCurrent && !options.isCurrent()) return false
  const data = await agentApi.getMessagesBefore(String(options.sessionId), options.messageId + 1, 200)
  if (options.isCurrent && !options.isCurrent()) return false
  const incoming = mapSessionMessageDelta(data, options.mkid, options.resolveSpeaker)
  if (!incoming.some(message => message.dbId === options.messageId)) return false
  options.messages.value = sortSessionTimelineMessages(
    mergeSessionMessageDelta(options.messages.value, incoming),
  )
  return options.messages.value.some(message => message.dbId === options.messageId)
}

export function createSessionMessageSynchronizer(options: {
  messages: Ref<ChatMessage[]>
  sessionId: Ref<number | null>
  mkid: () => number
  resolveSpeaker: SpeakerResolver
  scrollBottom: () => Promise<void>
}) {
  const cursors = new Map<number, number>()
  const running = new Map<number, Promise<void>>()
  const requested = new Set<number>()

  function setCursor(sessionId: number, value: number | null | undefined) {
    if (value != null && Number.isFinite(value) && value > 0) cursors.set(sessionId, value)
    else cursors.delete(sessionId)
  }

  function refresh(sessionId: number): Promise<void> {
    if (options.sessionId.value !== sessionId) return Promise.resolve()
    const active = running.get(sessionId)
    if (active) {
      requested.add(sessionId)
      return active
    }
    const task = (async () => {
      do {
        requested.delete(sessionId)
        let cursor = cursors.get(sessionId) ?? 0
        try {
          while (options.sessionId.value === sessionId) {
            const data = await agentApi.getMessages(String(sessionId), cursor, 200)
            if (options.sessionId.value !== sessionId) return
            const incoming = mapSessionMessageDelta(data, options.mkid, options.resolveSpeaker)
            const nextCursor = Number(data.pagination?.newestId)
            const newestIdAdvanced = Number.isFinite(nextCursor) && nextCursor > cursor
            if (incoming.length) {
              options.messages.value = sortSessionTimelineMessages(
                mergeSessionMessageDelta(options.messages.value, incoming),
              )
              await nextTick()
              await options.scrollBottom()
            }
            if (!newestIdAdvanced) break
            cursor = nextCursor
            cursors.set(sessionId, cursor)
            if ((data.messages || []).length < 200) break
          }
        } catch {
          /* 失败不推进游标，后续通知或 SSE 重连会再次尝试 */
        }
      } while (requested.has(sessionId) && options.sessionId.value === sessionId)
    })().finally(() => {
      running.delete(sessionId)
      requested.delete(sessionId)
    })
    running.set(sessionId, task)
    return task
  }

  return { setCursor, refresh }
}
