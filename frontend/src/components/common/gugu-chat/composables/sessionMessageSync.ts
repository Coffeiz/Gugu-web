import type { ChatFile, ChatMessage, ChatReference } from '../chatTypes'
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

function displayEventKey(event: { eventId?: string }) {
  if (!event.eventId) throw new Error('展示事件缺少稳定身份，需要完成本版本数据迁移')
  return `event:${event.eventId}`
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
      _syncKey: `message:${item.id}`,
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
        _timelineOrder: event.timelineOrder, _createdAt: event.createdAt, _updatedAt: event.updatedAt,
        _syncKey: displayEventKey(event),
      }
    : {
        id: mkid(), role: 'tool', text: '', toolCallId: event.toolCallId,
        toolName: event.toolName, toolLabel: event.toolLabel,
        runId: event.runId, roundId: event.roundId,
        toolStatus: event.toolStatus || (event.toolResult !== undefined ? 'success' : 'running'),
        toolInput: event.toolInput, toolResult: event.toolResult,
        toolDetailsAvailable: event.detailsAvailable,
        _toolDetailsSource: event.detailSource,
        toolDurationMs: event.toolDurationMs,
        time: displayTime(event.createdAt), _timelineOrder: event.timelineOrder,
        _createdAt: event.createdAt, _updatedAt: event.updatedAt,
        _syncKey: displayEventKey(event),
      })
  return [...messages, ...timeline]
}

function preserveToolDetails(existing: ChatMessage, incoming: ChatMessage): Partial<ChatMessage> {
  if (existing._toolDetailsLoaded) {
    return {
      ...(incoming.toolInput === undefined ? { toolInput: existing.toolInput } : {}),
      ...(incoming.toolResult === undefined ? { toolResult: existing.toolResult } : {}),
      _toolDetailsLoaded: true,
    }
  }
  return {
    ...(incoming.toolInput === undefined && existing.toolInput !== undefined
      ? { toolInput: existing.toolInput }
      : {}),
    ...(incoming.toolResult === undefined && existing.toolResult !== undefined
      ? { toolResult: existing.toolResult }
      : {}),
  }
}

function mergeMessage(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  if (existing._updatedAt && incoming._updatedAt && Date.parse(existing._updatedAt) > Date.parse(incoming._updatedAt)) {
    return existing
  }
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    dbId: incoming.dbId ?? existing.dbId,
    ...preserveToolDetails(existing, incoming),
  }
}

function normalizedMessageText(text: string | undefined) {
  return (text || '').trim().replace(/\s+/g, ' ')
}

function findGreetingIndex(messages: ChatMessage[], persisted: ChatMessage) {
  if (persisted.role !== 'ai' || !persisted._syncKey?.startsWith('message:')) return -1
  const text = normalizedMessageText(persisted.text)
  if (!text) return -1
  return messages.findIndex(message => message._greeting && message.role === 'ai'
    && [message._greetFull, message.text].some(candidate => normalizedMessageText(candidate) === text))
}

function foldExistingMessages(messages: ChatMessage[], indexByKey: Map<string, number>) {
  const result: ChatMessage[] = []
  for (const message of messages) {
    const key = message._syncKey
    const index = key ? indexByKey.get(key) : undefined
    if (index == null) {
      if (key) indexByKey.set(key, result.length)
      result.push(message)
    } else {
      result[index] = mergeMessage(result[index], message)
    }
  }
  return result
}

function mergeIncomingMessage(
  result: ChatMessage[],
  indexByKey: Map<string, number>,
  message: ChatMessage,
) {
  const key = message._syncKey
  let index = key ? indexByKey.get(key) : undefined
  // 首次发送时，前端问候没有数据库 ID；新会话创建时后端会将同一文本持久化。
  // 让持久化记录认领本地问候，保留其位置和组件身份，不再渲染第二张问候气泡。
  const greetingIndex = index == null ? findGreetingIndex(result, message) : -1
  if (greetingIndex >= 0) index = greetingIndex

  if (index == null) {
    if (key) indexByKey.set(key, result.length)
    result.push(message)
    return
  }
  const existing = result[index]
  result[index] = mergeMessage(existing, message)
  if (existing._greeting && greetingIndex >= 0) {
    delete result[index]._greeting
    delete result[index]._greetFull
  }
  if (key) indexByKey.set(key, index)
}

/** 合并从持久化会话增量恢复的消息；重复事件更新内容但不重复创建气泡。 */
export function mergeSessionMessageDelta(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const indexByKey = new Map<string, number>()
  // 会话 append 通知可能先于 SSE session_id 到达：历史同步已经插入持久化消息，
  // 随后临时气泡才获得相同 _syncKey。先折叠当前列表中的重复身份，不能只防新增重复。
  const result = foldExistingMessages(current, indexByKey)
  for (const message of incoming) mergeIncomingMessage(result, indexByKey, message)
  return result
}

/** run 终态以已提交历史原位接替临时展示；重复通知不会追加副本。 */
export function replaceRunHistory(current: ChatMessage[], incoming: ChatMessage[], runId: string): ChatMessage[] {
  const previous = new Map(current.filter(item => item.runId === runId).map(item => [item._syncKey, item]))
  const history = incoming.filter(item => item.runId === runId).map(item => {
    const existing = previous.get(item._syncKey)
    return {
      ...item,
      id: existing?.id ?? item.id,
      streaming: false,
      ...(existing?.role === 'tool' ? preserveToolDetails(existing, item) : {}),
    }
  })
  return sortSessionTimelineMessages([...current.filter(item => item.runId !== runId), ...history])
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
          // 检查点在同一行原位更新，不能只用自增行 ID 查增量；重连先校准最新窗口。
          const snapshot = await agentApi.getMessages(String(sessionId), undefined, 200)
          if (options.sessionId.value !== sessionId) return
          options.messages.value = sortSessionTimelineMessages(mergeSessionMessageDelta(options.messages.value,
            mapSessionMessageDelta(snapshot, options.mkid, options.resolveSpeaker)))
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
            if (!data.pagination?.hasNewer) break
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
