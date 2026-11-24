import { localizedToolStatusLabel } from '../messageDisplay'
import { ref, type Ref } from 'vue'
import { createAgentChatSseDecoder } from '@gugu/core/agent/chat-sse'
import { i18n, translateAgentError } from '@/i18n'
import { agentApi, CLIENT_ID } from '@/services/api'
import { isUnauthorizedResponse } from '@/services/authSession'
import { useLiveStore } from '@/stores/live'
import { playGuguSfx } from '@/services/sfx'
import { showAppError } from '@/composables/core/useAppToast'
import type { ChatMessage, ChatFile, ChatSession, ChatReference, QueuedMessagePayload } from '../chatTypes'
import { renderMd } from '../markdown'
import { chatHttpStream, type ChatHttpStreamAccess } from '../chatHttpStream'
import { FILE_TOOLS, PROJECT_TOOLS, CALENDAR_TOOLS, MCP_TOOLS, MIND_WRITE_TOOLS } from './useChatActions'
import { notifyResourceChanged } from '@/services/resourceRefreshEvents'
import type GuguChatComposer from '../GuguChatComposer.vue'
import { createPendingQueueKey, getDraftPendingQueueId, getSessionPendingQueueId, setPendingQueueRecoveryNeeded } from './chatPendingQueueStorage'
import { dispatchPendingQueueItem } from './chatPendingQueueDispatch'
import type { ChatSessionHistory } from './useChatSessions'
import {
  mapSessionInteraction,
  mapSessionMessageDelta,
  mergeSessionMessageDelta,
  replaceRunHistory,
} from './sessionMessageSync'

interface StatusItem { kind: 'text' | 'dots' | 'hide'; label?: string }

const RESUMED_HISTORY_EVENTS = new Set([
  'display_event', 'interaction_required', 'error',
])

function parseOpenItemResult(result: unknown) {
  let value = result
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  if (!value || typeof value !== 'object') return null
  const { ok, open_in_browser, link } = value as Record<string, unknown>
  if (ok !== true || open_in_browser !== true || typeof link !== 'string') return null
  const match = /^gugu:\/\/open-object\/(file|folder)\/((?:path|drop)-[A-Za-z0-9_-]{1,24000})$/u.exec(link)
  return match ? { kind: match[1] as 'file' | 'folder', id: match[2]! } : null
}

function attachPersistedIdentity(
  messages: ChatMessage[], optimistic: ChatMessage, dbId: number, timelineOrder?: number,
): ChatMessage[] {
  const index = messages.findIndex(message => message.id === optimistic.id)
  if (index < 0) {
    optimistic.dbId = dbId
    optimistic._syncKey ||= `message:${dbId}`
    if (timelineOrder != null) optimistic._timelineOrder = timelineOrder
    return messages
  }
  messages[index].dbId = dbId
  messages[index]._syncKey ||= `message:${dbId}`
  if (timelineOrder != null) messages[index]._timelineOrder = timelineOrder
  // History sync may have inserted the persisted copy before SSE delivered identity.
  return mergeSessionMessageDelta(messages, [])
}

export interface QueuedMessage extends QueuedMessagePayload {
  queueId: string
  sessionId: number | null
  viewGeneration: number
}

/**
 * SSE 收发的唯一状态所有权：streaming、AbortController、生成中消息排队、
 * 当前会话已发轮次（埋点用）。send（POST /chat）和续看 resumeStream
 * （GET .../stream）共用同一套 consumeStream 消费逻辑。
 *
 * 不拥有 messages/sessionId/sessions 本身（由调用方——useChatConversation /
 * useChatSessions 传入读写）、也不拥有会话列表刷新的触发时机之外的逻辑。
 *
 * getViewGeneration 是只读依赖：只在切会话时递增，这里只用来判断"写回
 * messages 前，用户是不是还停在发起这次请求时的那个视图"，递增的所有权
 * 在 useChatSessions（loadSession/newSession 才会切视图）。
 */
type QueuePayload = Pick<QueuedMessagePayload, 'key' | 'text' | 'attachments' | 'references' | 'modelId'>

export interface ChatQueueAccess {
  replace: (queueId: string, items: QueuePayload[]) => Promise<unknown>
  patch: (queueId: string, sessionId: number, items: QueuePayload[], removedKeys?: number[]) => Promise<unknown>
  claim: (queueId: string, sessionId: number, key: number) => Promise<{ claim_token: string | null; reason?: string }>
  release: (queueId: string, sessionId: number, key: number, claimToken: string) => Promise<unknown>
}

export interface ChatRunAccess {
  cancel: (id: number, runId: string) => Promise<{ outcome: string }>
  readState: (id: number) => Promise<{ runId?: string; status: string }>
  readHistory: (id: number, before?: number) => Promise<ChatSessionHistory>
  createSession: (title: string, greeting?: string) => Promise<{ id: number }>
  resume: (id: number, runId: string, signal: AbortSignal) => ReadableStream<Uint8Array>
  send: (input: {
    id: number; text: string; clientMessageId: string; modelId?: string
    attachments: ChatFile[]; references: ChatReference[]; queueClaim?: { key: number; token: string }
  }, signal: AbortSignal) => ReadableStream<Uint8Array>
}

export function useChatStream(options: {
  deleteDraftAttachment?: (id: string) => Promise<unknown>
  httpStream?: ChatHttpStreamAccess
  cancelSession?: (id: number) => Promise<{ outcome: string }>
  runAccess?: ChatRunAccess
  queueAccess?: ChatQueueAccess
  messages: Ref<ChatMessage[]>
  mkid: () => number
  now: () => string
  inputText: Ref<string>
  inputReferences: Ref<ChatReference[]>
  sessionId: Ref<number | null>
  sessions: Ref<ChatSession[]>
  getViewGeneration: () => number
  // SSE session_id 落地专用：保留当前输入并把它记为新会话草稿（不是会话切换，
  // 不能走普通 watcher 的「存旧还原新」语义，那会清掉正在输入的文字）
  bindNewSessionId: (id: number) => void
  pendingAtt: Ref<ChatFile[]>
  composerRef: Ref<InstanceType<typeof GuguChatComposer> | null>
  setStatus: (item: StatusItem) => void
  clearStatus: () => void
  thinkingItem: () => StatusItem
  contextCompactingItem: () => StatusItem
  scrollBottom: (force?: boolean) => Promise<void>
  fetchSessions: () => Promise<void>
  updateSidebarRun?: (sessionId: number, runId: string, running: boolean) => void
  syncResumedHistory?: (id: number) => Promise<void>
  refreshAfterTools: (usedTools: Set<string>) => Promise<void>
  loadQuota: () => void
  playIncomingMessageSfx: () => void
  onQueuePersistenceError?: (error: unknown) => void
  onQueueDispatchError?: (error: unknown) => void
  trackMessageSent?: (turn: number) => void
  onAutomaticModeCommand?: () => Promise<void>
  onOpenItem?: (item: { kind: 'file' | 'folder'; id: string }) => void
}) {
  let clientMessageSequence = 0
  const liveStore = useLiveStore()
  const { messages, mkid, now, sessionId, sessions } = options

  const streaming = ref(false)
  const abortCtrl = ref<AbortController | null>(null)
  const draftPendingQueueId = getDraftPendingQueueId()
  // 每条流各自绑定会话 ID，避免切换会话后旧 SSE 的迟到事件覆盖新流归属。
  const runSessionIds = new WeakMap<AbortController, number | null>()
  const runIds = new WeakMap<AbortController, string>()
  const runTerminalControllers = new WeakSet<AbortController>()
  function sessionIdForRun(controller: AbortController): number | null {
    return runSessionIds.has(controller) ? (runSessionIds.get(controller) ?? null) : sessionId.value
  }
  // 停止时不能先 abort SSE：取消终态（tool_done/done）正由这条流返回。
  // AbortController 作为 run 身份，避免切会话后旧流的回调污染新流状态。
  const cancelRequestedControllers = new WeakSet<AbortController>()
  const stopWaitingForSessionId = new WeakSet<AbortController>()
  function requestRunCancellation(id: number, controller: AbortController) {
    if (runTerminalControllers.has(controller) || cancelRequestedControllers.has(controller)) return
    const runId = runIds.get(controller)
    if (options.runAccess && !runId) return
    cancelRequestedControllers.add(controller)
    options.setStatus({ kind: 'text', label: i18n.global.t('chatUi.cancelling') })
    const cancellation = options.runAccess && runId
      ? options.runAccess.cancel(id, runId)
      : (options.cancelSession ?? (sessionId => agentApi.cancelSession(String(sessionId))))(id)
    void cancellation.then(result => {
      if (abortCtrl.value !== controller || runTerminalControllers.has(controller)) return
      if (result.outcome === 'interrupted') {
        runTerminalControllers.add(controller)
        options.setStatus({ kind: 'text', label: i18n.global.t('chatUi.runInterrupted') })
      } else if (result.outcome === 'already_completed') {
        runTerminalControllers.add(controller)
        options.setStatus({ kind: 'text', label: i18n.global.t('chatUi.cancelTooLate') })
      }
    }).catch(() => {
      cancelRequestedControllers.delete(controller)
      if (abortCtrl.value === controller && !runTerminalControllers.has(controller)) {
        options.setStatus({ kind: 'text', label: i18n.global.t('chatUi.cancelFailed') })
      }
    })
  }
  function bindRunId(controller: AbortController, id: number, runId: string) {
    runIds.set(controller, runId)
    if (stopWaitingForSessionId.delete(controller)) requestRunCancellation(id, controller)
  }
  // 当前页面缓存已恢复的会话队列；其权威数据在服务端，跨浏览器按 session_id 聚合。
  // 切换会话只过滤展示/消费目标，不清空其他会话的队列。
  const pendingQueue = ref<QueuedMessage[]>([])
  const cancelledQueueKeys = new Set<string>()
  const dispatchingQueueKeys = new Set<string>()
  const persistedQueueItems = new Set<string>()
  // 队列增量写入按顺序提交，避免同一标签里的移除/迁移请求乱序。
  let pendingQueueWrite = Promise.resolve()
  let drainingPendingQueue = false
  let drainingView: { sessionId: number | null; viewGeneration: number } | null = null
  let drainRequestedForAnotherView = false
  let _sessionTurn = 0                      // 当前 session 已发消息轮次（埋点用），切会话由 useChatSessions 调 resetSessionTurn 重置
  function resetSessionTurn() { _sessionTurn = 0 }

  function stopStreaming() {
    // 停止=取消当前 run；排队中的消息保留，当前流收尾后由 finally 里的
    // drainPendingQueue 立即接续第一条（用户预期：停的是「正在说的这句」，
    // 排队的照样发，而不是一起被丢掉）。终止收口前后端会短暂仍报 active，
    // 排水的 claim 重试负责等它结束。
    const controller = abortCtrl.value
    if (!controller || controller.signal.aborted || runTerminalControllers.has(controller)) return
    const id = sessionIdForRun(controller)
    if (id == null || (options.runAccess && !runIds.has(controller))) {
      // 保留 SSE，等会话和本次运行身份确认后再取消。
      stopWaitingForSessionId.add(controller)
      options.setStatus({ kind: 'text', label: i18n.global.t('chatUi.cancelling') })
      return
    }
    requestRunCancellation(id, controller)
  }

  function enqueuePendingQueueWrite(task: () => Promise<void>) {
    pendingQueueWrite = pendingQueueWrite.catch(() => {}).then(task)
    return pendingQueueWrite
  }

  function queueIdentity(item: Pick<QueuedMessage, 'queueId' | 'key'>) {
    return `${item.queueId}:${item.key}`
  }

  function toPayload(item: QueuedMessage) {
    return {
      key: item.key,
      text: item.text,
      attachments: item.attachments,
      references: item.references,
      ...(item.modelId ? { modelId: item.modelId } : {}),
    }
  }

  const queueAccess: ChatQueueAccess = options.queueAccess ?? {
    replace: agentApi.updatePendingQueue,
    patch: agentApi.patchPendingQueue,
    claim: agentApi.claimPendingQueueItem,
    release: agentApi.releasePendingQueueItem,
  }

  function persistDraftQueue(queueId: string) {
    const draftItems = pendingQueue.value.filter(item => item.queueId === queueId && item.sessionId == null)
    const items = draftItems.map(toPayload)
    return enqueuePendingQueueWrite(async () => {
      await queueAccess.replace(queueId, items)
      for (const item of draftItems) persistedQueueItems.add(queueIdentity(item))
      if (items.length || pendingQueue.value.length) setPendingQueueRecoveryNeeded(true)
    })
  }

  function persistQueueItem(item: QueuedMessage) {
    if (item.sessionId == null) return persistDraftQueue(item.queueId)
    return enqueuePendingQueueWrite(async () => {
      await queueAccess.patch(item.queueId, item.sessionId!, [toPayload(item)])
      persistedQueueItems.add(queueIdentity(item))
      setPendingQueueRecoveryNeeded(true)
    })
  }

  function ensureQueueItemPersisted(item: QueuedMessage) {
    if (persistedQueueItems.has(queueIdentity(item))) return pendingQueueWrite.catch(() => {})
    return persistQueueItem(item)
  }

  function removePersistedQueueItem(item: QueuedMessage) {
    if (item.sessionId == null) return persistDraftQueue(item.queueId)
    return enqueuePendingQueueWrite(async () => {
      await queueAccess.patch(item.queueId, item.sessionId!, [], [item.key])
    })
  }

  function clearPendingQueue(clearOrphanedStorage = false) {
    const previousSessionId = sessionId.value
    // 已有会话的队列继续留在本地和服务端；新建对话只清理尚未绑定会话的草稿项。
    if (previousSessionId == null && clearOrphanedStorage) {
      const draftItems = pendingQueue.value.filter(item => item.sessionId == null)
      const draftQueueIds = new Set(draftItems.map(item => item.queueId))
      for (const item of draftItems) persistedQueueItems.delete(queueIdentity(item))
      pendingQueue.value = pendingQueue.value.filter(item => item.sessionId != null)
      for (const queueId of draftQueueIds) {
        void persistDraftQueue(queueId).catch(error => options.onQueuePersistenceError?.(error))
      }
    }
  }

  function restorePendingQueueForScope(targetSessionId: number | null, serverItems: QueuedMessagePayload[]) {
    const restored = (Array.isArray(serverItems) ? serverItems : [])
      .filter(item => targetSessionId == null ? item.session_id == null : item.session_id === targetSessionId)
      .map(item => ({
        ...item,
        queueId: item.queue_id,
        sessionId: targetSessionId,
        // 恢复后绑定当前会话视图；队列归属仍以 sessionId 为准。
        viewGeneration: options.getViewGeneration(),
      }))
    const restoredIdentities = new Set(restored.map(queueIdentity))
    const previousItems = pendingQueue.value.filter(item => item.sessionId === targetSessionId)
    const unsavedLocalItems = previousItems.filter(item =>
      item.sessionId === targetSessionId
      && !persistedQueueItems.has(queueIdentity(item))
      && !restoredIdentities.has(queueIdentity(item)),
    )
    for (const item of previousItems) {
      if (!restoredIdentities.has(queueIdentity(item)) && !unsavedLocalItems.includes(item)) {
        persistedQueueItems.delete(queueIdentity(item))
      }
    }
    pendingQueue.value = [
      ...pendingQueue.value.filter(item => item.sessionId !== targetSessionId),
      ...restored,
      ...unsavedLocalItems,
    ]
    for (const item of restored) {
      cancelledQueueKeys.delete(queueIdentity(item))
      persistedQueueItems.add(queueIdentity(item))
    }
    if (serverItems.length) setPendingQueueRecoveryNeeded(true)
  }

  function restorePendingQueueForSession(id: number, serverItems: QueuedMessagePayload[] = []) {
    restorePendingQueueForScope(id, serverItems)
  }

  function restorePendingQueueForDraft(items: QueuedMessagePayload[]) {
    restorePendingQueueForScope(null, items)
  }

  function removeQueued(queueId: string, key: number) {
    const index = pendingQueue.value.findIndex(item => item.queueId === queueId && item.key === key)
    if (index !== -1) {
      const [item] = pendingQueue.value.splice(index, 1)
      const identity = queueIdentity(item)
      persistedQueueItems.delete(identity)
      if (dispatchingQueueKeys.has(identity)) cancelledQueueKeys.add(identity)
      void removePersistedQueueItem(item).catch(error => options.onQueuePersistenceError?.(error))
    }
  }

  async function drainPendingQueue() {
    const drainViewGeneration = options.getViewGeneration()
    const drainSessionId = sessionId.value
    if (drainingPendingQueue) {
      if (drainingView && (
        drainingView.viewGeneration !== drainViewGeneration
        || drainingView.sessionId !== drainSessionId
      )) drainRequestedForAnotherView = true
      return
    }
    drainingPendingQueue = true
    drainingView = { sessionId: drainSessionId, viewGeneration: drainViewGeneration }
    const drainViewIsCurrent = () =>
      drainViewGeneration === options.getViewGeneration() && sessionId.value === drainSessionId
    // 终止 run 后立即排水，会撞上后端 cancel 尚未收口的窗口（claim 返回
    // session_active）。按固定节奏重试同一条，重试期不把整条队列卡死。
    let sessionActiveRetries = 0
    let claimReason = ''
    try {
      while (pendingQueue.value.length) {
        if (!drainViewIsCurrent()) return
        const next = pendingQueue.value.find(item => item.sessionId === drainSessionId)
        if (!next) return
        if (streaming.value) return
        let dispatched = false
        const identity = queueIdentity(next)
        dispatchingQueueKeys.add(identity)
        try {
          dispatched = await dispatchPendingQueueItem(next.queueId, next.key, {
            findItem: (queueId, key) => pendingQueue.value.find(item => item.queueId === queueId && item.key === key),
            persist: ensureQueueItemPersisted,
            claim: async item => {
              if (item.sessionId == null) return null
              const response = await queueAccess.claim(item.queueId, item.sessionId, item.key)
              claimReason = response.reason || ''
              return response.claim_token
            },
            release: async (item, claimToken) => {
              if (item.sessionId != null) {
                await queueAccess.release(item.queueId, item.sessionId, item.key, claimToken)
              }
            },
            dispatch: async (item, claimToken) => {
              const belongsToCurrentView = item.sessionId === sessionId.value
                && item.viewGeneration === options.getViewGeneration()
              if (belongsToCurrentView) {
                options.clearStatus()
                options.setStatus(options.thinkingItem())
              }
              let yielded: (() => void) | undefined
              const executionSlotReleased = new Promise<void>(resolve => { yielded = resolve })
              const sending = send(item.text, item.attachments, item.references, item.key, item.viewGeneration,
                item.sessionId, item.queueId, claimToken, item.modelId, () => {
                  if (!pendingQueue.value.some(value => queueIdentity(value) === queueIdentity(item))) yielded?.()
                })
              await Promise.race([sending, executionSlotReleased])
              if (options.runAccess && claimToken && item.sessionId != null
                && pendingQueue.value.some(value => queueIdentity(value) === queueIdentity(item))) {
                // 桌面准入原子消费令牌。仍有效的令牌可释放，已准入或换租令牌的队列不受影响。
                const released = await queueAccess.release(item.queueId, item.sessionId, item.key, claimToken)
                if (released === true) {
                  const pending = pendingQueue.value.find(value => queueIdentity(value) === queueIdentity(item))
                  if (pending) pending.claimed = false
                }
              }
            },
            isCancelled: item => cancelledQueueKeys.has(queueIdentity(item)),
            onPersistError: error => options.onQueuePersistenceError?.(error),
            onDispatchError: error => options.onQueueDispatchError?.(error),
          })
        } catch {
          return
        } finally {
          dispatchingQueueKeys.delete(identity)
          cancelledQueueKeys.delete(identity)
        }
        if (!dispatched) {
          if (!drainViewIsCurrent()) return
          if (!pendingQueue.value.some(item => queueIdentity(item) === identity)) continue
          // claim 因会话仍在生成（含终止收口窗口）被拒：等待后重试同一条。
          if (claimReason === 'session_active' && ++sessionActiveRetries <= 8) {
            await new Promise(resolve => setTimeout(resolve, 2000))
            if (!drainViewIsCurrent() || streaming.value) return
            continue
          }
          return
        }
        // 队列项保留到后端与用户消息同一事务确认；请求失败或刷新不会提前丢失。
        // 若后端没有发出 session_id 确认，条目仍在队列中；停止自动重试，避免失败时循环发送。
        if (pendingQueue.value.some(item => queueIdentity(item) === identity)) return
      }
    } finally {
      drainingPendingQueue = false
      drainingView = null
      const shouldDrainCurrentView = drainRequestedForAnotherView
      drainRequestedForAnotherView = false
      if (shouldDrainCurrentView && !streaming.value && pendingQueue.value.some(item => item.sessionId === sessionId.value)) {
        queueMicrotask(() => { void drainPendingQueue().catch(() => {}) })
      }
    }
  }

  // 新对话首轮开始时暂时还没有服务端 session_id；收到真实 ID 后，把同一源视图的
  // 草稿队列项迁移到该会话，并持久化迁移后的逐项归属。
  function resolvePendingSession(
    realId: number,
    sourceViewGeneration = options.getViewGeneration(),
  ) {
    const migrated: QueuedMessage[] = []
    const oldIdentities = new Map<QueuedMessage, string>()
    const targetQueueId = getSessionPendingQueueId(realId)
    for (const item of pendingQueue.value) {
      if (item.sessionId == null && item.viewGeneration === sourceViewGeneration) {
        oldIdentities.set(item, queueIdentity(item))
        item.sessionId = realId
        item.queueId = targetQueueId
        migrated.push(item)
      }
    }
    if (!migrated.length) return
    for (const item of migrated) persistedQueueItems.delete(oldIdentities.get(item)!)
    // 先清理该标签尚未完成的草稿快照写入，再增量写入会话队列。
    void enqueuePendingQueueWrite(async () => {
      await queueAccess.replace(draftPendingQueueId, [])
      await queueAccess.patch(targetQueueId, realId, migrated.map(toPayload))
      for (const item of migrated) persistedQueueItems.add(queueIdentity(item))
      setPendingQueueRecoveryNeeded(true)
    }).catch(error => options.onQueuePersistenceError?.(error))
  }

  // 消费一条 SSE 流，把事件渲染进消息列表。send（POST /chat）和续看（GET .../stream）共用。
  // 返回 { aiIdx, usedTools }，供调用方做收尾（首条空回复兜底、刷新视图）。
  async function consumeStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    ownerSid: number | null,
    viewGeneration: number,
    onSessionId?: (id: number, timelineOrder: number, userMessageId?: number) => void,
    runController?: AbortController,
    onRunWaiting?: () => void,
  ) {
    const decoder = createAgentChatSseDecoder()
    let aiIdx = -1, aiMessageId: number | null = null, aborted = false, interactionPaused = false
    let sawCancelledTerminal = false
    // token 到达速度由 Provider 决定；滚动只是展示副作用，不能让每个 token 等待一次
    // nextTick。按帧合并滚动请求，避免把快速到达的 token 人为变成固定打字速度。
    let streamScrollRaf: number | null = null
    const scheduleStreamScroll = () => {
      if (streamScrollRaf !== null) return
      streamScrollRaf = window.requestAnimationFrame(() => {
        streamScrollRaf = null
        void options.scrollBottom()
      })
    }
    // 多 round 流中 aiIdx 会在 round_start 时归零；它只表示“当前气泡”，不能用来
    // 判断整条流是否已经收到过正文。否则第一轮有回复、第二轮空回合时会误加兜底气泡。
    let receivedAssistantContent = false
    let sid = ownerSid           // 本流归属的会话（新对话在 session_id 事件前为 null）
    let outcomeMessageDbId: number | null = null
    let detached = false         // 一旦用户切到别的会话，本流永久脱离、不再污染当前视图
    const resumedRunId = runController && runIds.get(runController)
    let resumedHistoryReady = Boolean(onSessionId || (resumedRunId && hasRunUserMessage(resumedRunId)))
    const displayedGreeting = ownerSid == null
      ? (messages.value.find(m => m._greeting)?._greetFull || '').trim()
      : ''
    const usedTools = new Set<string>()
    let currentRoundId = ''
    let currentRunId = resumedRunId ?? ''
    let interruptedDelivery: { runId: string; message: string } | undefined
    // 工具消息会随着多轮正文持续排序/插入，不能缓存数组下标；只保存稳定的消息 id，
    // 每次事件到达时重新定位，避免 tool_done 更新到错误的卡片或找不到卡片。
    let timelineOrder = messages.value.reduce(
      (max, message) => Math.max(max, message._timelineOrder ?? 0),
      0,
    )
    const nextTimelineOrder = () => {
      // 跨端用户消息可能在连接建立后才补入；不能沿用连接开始时的旧序号。
      timelineOrder = messages.value.reduce(
        (max, message) => Math.max(max, message._timelineOrder ?? 0), timelineOrder,
      )
      return ++timelineOrder
    }
    const applyRunOutcome = (
      outcome: ChatMessage['runOutcome'],
      targetUserMessageId = outcomeMessageDbId,
    ) => {
      if (!outcome || !targetUserMessageId) return
      const target = messages.value.find(message => message.dbId === targetUserMessageId)
      if (target?.role === 'user') target.runOutcome = outcome
    }
    const syncAiIndex = () => {
      aiIdx = aiMessageId == null
        ? -1
        : messages.value.findIndex(item => item.id === aiMessageId)
      return aiIdx
    }
    // 当前看的还是本流的会话吗？切走后置 detached（之后切回靠 loadSession 干净重载，不半路重接）
    const live = () => {
      if (detached || viewGeneration !== options.getViewGeneration()) {
        detached = true
        return false
      }
      if (runController && abortCtrl.value !== runController) {
        detached = true
        return false
      }
      if (sessionId.value !== (sid ?? ownerSid)) { detached = true; return false }
      return true
    }

    let settledRunId: string | undefined
    let sawStreamError = false
    async function settleHistory() {
      if (!currentRunId || sid == null || currentRunId === settledRunId) return
      const finishingRun = currentRunId
      try {
        const timeline: ChatMessage[] = []
        let beforeId: number | undefined
        const seenCursors = new Set<number>()
        while (true) {
          const snapshot = options.runAccess
            ? await options.runAccess.readHistory(sid, beforeId)
            : await agentApi.getMessages(sid, { runId: finishingRun, limit: 200, ...(beforeId === undefined ? {} : { beforeId }) })
          if (!live()) return
          timeline.push(...mapSessionMessageDelta(snapshot, mkid, role => ({ role: role === 'assistant' ? 'ai' : role })))
          // 桌面历史按消息分页；助手时间线可能比同一运行的用户消息先出现。
          if (!snapshot.pagination?.hasMore || (options.runAccess
            && timeline.some(item => item.role === 'user' && item.runId === finishingRun))) break
          const next = snapshot.pagination.oldestId
          if (typeof next !== 'number' || seenCursors.has(next)) return
          seenCursors.add(next)
          beforeId = next
        }
        if (!timeline.some(item => item.runId === finishingRun)) return
        messages.value = replaceRunHistory(messages.value, timeline, finishingRun)
        settledRunId = finishingRun
      } catch {
        // 保留最后已知展示；重连最新窗口校准会重试，不把传输失败伪装成任务失败。
      }
    }
    try {
      while (true) {
        let chunk
        try { chunk = await reader.read() }
        catch (e: any) { if (e?.name === 'AbortError') { aborted = true; break; } throw e }   // 切会话会 abort：优雅收尾，别当网络错
        const { done, value } = chunk
        if (done) break
        for (const raw of decoder.push(value)) {
          let evt; try { evt = JSON.parse(raw) } catch { continue }
          if (!resumedHistoryReady && sid != null && live() && RESUMED_HISTORY_EVENTS.has(evt.type)) {
            // IM 的 running 通知可能早于用户消息提交。等首个可见事件再补取历史，
            // 此时执行器已提交用户消息，重放工具卡才能排在它之后；整条续看只同步一次。
            await options.syncResumedHistory?.(sid)
            resumedHistoryReady = true
          }
          const eventUserMessageId = Number(evt.user_message_id)
          if (Number.isInteger(eventUserMessageId) && eventUserMessageId > 0) {
            outcomeMessageDbId = eventUserMessageId
          }
          if (evt.type === 'session_id') {
            const acceptedSessionId = Number(evt.session_id)
            if (typeof evt.run_id === 'string' && evt.run_id) currentRunId = evt.run_id
            if (runController) {
              runSessionIds.set(runController, acceptedSessionId)
              if (options.runAccess && currentRunId) bindRunId(runController, acceptedSessionId, currentRunId)
            }
            onSessionId?.(acceptedSessionId, (outcomeMessageDbId ?? 0) * 1_000_000,
              outcomeMessageDbId ?? undefined)
            const isNew = sessionId.value !== evt.session_id
            // 仅当用户仍停在本流视图（旧会话或新对话）才把视图切到新 id，否则别抢走用户当前会话。
            // 走 bindNewSessionId：身份落地要保留当前输入并记为新会话草稿（普通赋值
            // 会触发切换 watcher 把输入当「旧会话遗留」还原成空串，正在打的字就丢了）。
            if (viewGeneration === options.getViewGeneration() && sessionId.value === (sid ?? ownerSid)) {
              options.bindNewSessionId(evt.session_id)
            }
            // session_id 同时也是本流排队消息的目标归属。即使用户已切走，仍按本流的
            // 入队代次绑定旧消息；不能把它们交给当前选中的另一个会话。
            resolvePendingSession(evt.session_id, viewGeneration)
            sid = evt.session_id
            if (isNew) await options.fetchSessions()
          } else if (evt.type === 'session_title') {
            const s = sessions.value.find(s => s.id === sid)   // 按本流会话更新标题，与当前视图无关
            if (s) s.title = evt.title
          } else if (evt.type === 'session_goal') {
            const s = sessions.value.find(s => s.id === Number(evt.session_id || sid))
            if (s) {
              s.goalActive = Boolean(evt.active)
              s.goalStatus = evt.status === 'active' || evt.status === 'paused' ? evt.status : null
            }
          } else if (evt.type === 'run_waiting') {
            if (!live()) continue
            const reply = messages.value[syncAiIndex()]
            if (reply) reply.streaming = false
            options.clearStatus()
            // 子任务仍在后台运行，保留订阅，同时让输入框可以发送下一条消息。
            streaming.value = false
            onRunWaiting?.()
            void drainPendingQueue().catch(() => {})
          } else if (evt.type === 'round_start') {
            currentRunId = String(evt.core_run_id || evt.run_id || currentRunId)
            currentRoundId = String(evt.round_id || 'round')
            if (options.runAccess && runController && sid != null && currentRunId)
              bindRunId(runController, sid, currentRunId)
            if (live() && sid != null) options.updateSidebarRun?.(sid, currentRunId, true)
            if (live() && !(runController && cancelRequestedControllers.has(runController))) {
              streaming.value = true
              options.setStatus(options.thinkingItem())
            }
          } else if (evt.type === '_new_round') {
            // 兼容旧事件：新版 round_start 已先建立身份，旧客户端只看到这里也不会报错。
            currentRunId = String(evt.core_run_id || evt.run_id || currentRunId)
            if (evt.round_id) currentRoundId = String(evt.round_id)
          } else if (evt.type === 'display_event') {
            if (!live()) continue
            const item = evt.item
            currentRunId = item.runId
            currentRoundId = item.roundId
            if (item.kind === 'tool') {
              usedTools.add(item.toolName)
              options.setStatus(item.toolStatus === 'running' || item.toolStatus === 'queued'
                ? { kind: 'text', label: localizedToolStatusLabel({
                    name: item.toolName, label: item.toolLabel, custom: item.toolLabelOverride, input: item.toolInput,
                    shellActivity: item.shellActivity,
                  }) }
                : options.thinkingItem())
            } else {
              receivedAssistantContent = true
              options.clearStatus()
            }
            const delta = mapSessionMessageDelta({ timelineEvents: [item] }, mkid, role => ({ role }))
            const reply = delta.find(message => message.role === 'ai')
            if (reply?.text) reply.streaming = true
            messages.value = mergeSessionMessageDelta(messages.value, delta)
            if (item.kind === 'assistant') {
              const previous = messages.value[syncAiIndex()]
              aiMessageId = messages.value.find(message => message._syncKey === `event:${item.eventId}`)?.id ?? null
              if (previous?.streaming && previous.id !== aiMessageId) previous.streaming = false
              syncAiIndex()
              // 后续正文按消息行的实际高度变化维持贴底。
              if (previous?.id !== aiMessageId) scheduleStreamScroll()
            } else {
              scheduleStreamScroll()
            }
          } else if (evt.type === 'tool_done') {
            if (evt.name === 'open_item' && evt.status === 'success') {
              const item = parseOpenItemResult(evt.result)
              if (item && onSessionId && live()) options.onOpenItem?.(item)
            }
            if (FILE_TOOLS.has(evt.name)) liveStore.bump('files')
            else if (PROJECT_TOOLS.has(evt.name)) liveStore.bump('projects')
            else if (CALENDAR_TOOLS.has(evt.name)) liveStore.bump('calendar')
            else if (MCP_TOOLS.has(evt.name)) notifyResourceChanged('mcp')
            else if (evt.status === 'success' && MIND_WRITE_TOOLS.has(evt.name)) liveStore.bump('mind')
          } else if (evt.type === 'interaction_required') {
            const interactionResolved = evt.resolved === true
            if (!interactionResolved) interactionPaused = true
            const eventSessionId = evt.session_id == null ? null : Number(evt.session_id)
            const interactionBelongsToView = viewGeneration === options.getViewGeneration()
              && (eventSessionId == null
                ? live()
                : eventSessionId === Number(sessionId.value))
            if (interactionBelongsToView && evt.prompt_id && Array.isArray(evt.options)) {
              const promptId = Number(evt.prompt_id)
              const existing = messages.value.find(item =>
                item.role === 'interaction' && item.interaction?.promptId === promptId,
              )
              const card = mapSessionInteraction({
                ...evt,
                // 续看可能重放轮换前的按钮凭据；已经恢复的卡片保留当前凭据。
                options: !interactionResolved && !onSessionId && existing?.interaction ? existing.interaction.options : evt.options,
                run_id: evt.core_run_id || currentRunId || evt.run_id,
                round_id: evt.round_id || currentRoundId,
              }, mkid, existing)
              if (card) {
                card._timelineOrder ??= nextTimelineOrder()
                messages.value = mergeSessionMessageDelta(messages.value, [card])
              }
              if (!card || card.interaction?.resolved) continue
              if (live() && sid != null) options.updateSidebarRun?.(sid, String(evt.core_run_id || currentRunId || evt.run_id || ''), false)
              options.setStatus({
                kind: 'text',
                label: evt.task_paused
                  ? i18n.global.t('chatUi.taskPausedWaiting')
                  : i18n.global.t('chatUi.waitingConfirmation'),
              })
              await options.scrollBottom()
            }
          } else if (evt.type === '_context_compaction') {
            // 自动压缩可能需要等待 provider；单独显示状态，避免用户把这段等待误认为卡死。
            if (live()) {
              const phase = String(evt.phase || '')
              if (phase === 'started') {
                options.setStatus(options.contextCompactingItem())
              } else if (phase === 'completed' || evt.applied === true) {
                options.setStatus(options.thinkingItem())
              }
            }
          } else if (evt.type === 'retry') {
            // 模型瞬时空峰自动重试：状态行就地显示进度，拿到首个 token 即被 clearStatus 收起
            if (live()) {
              options.setStatus({
                kind: 'text',
                label: i18n.global.t('chatUi.retrying', {
                  n: Number(evt.attempt) || 0,
                  max: Number(evt.max_retries) || 0,
                  seconds: Number(evt.next_retry_in) || 0,
                }),
              })
              await options.scrollBottom()
            }
          } else if (evt.type === 'notice') {
            if (live() && typeof evt.message === 'string' && evt.message.trim()) {
              options.setStatus({ kind: 'text', label: evt.message })
            }
          } else if (evt.type === 'done') {
            if (evt.command_reply === true) receivedAssistantContent = true
            // 等待确认只结束本次观察；运行内的展示还未写入终态历史。
            if (evt.waiting_for_interaction === true) {
              interactionPaused = true
              continue
            }
            currentRunId = String(evt.core_run_id || evt.run_id || currentRunId || '')
            if (runController) runTerminalControllers.add(runController)
            if (sid != null) options.updateSidebarRun?.(sid, currentRunId, false)
            // 会话列表的运行态由独立的用户级 live 事件刷新；若该瞬时通知丢失，
            // 当前流仍能收到终态，借此重新读取服务端快照，避免侧栏标题动画残留。
            void options.fetchSessions()
            if (live()) {
              if (evt.cancelled) {
                sawCancelledTerminal = true
                options.setStatus({ kind: 'text', label: i18n.global.t(evt.remote_status_unknown
                  ? 'chatUi.cancelRemoteUnknown'
                  : 'chatUi.runInterrupted') })
              } else options.clearStatus()
              // 取消收尾兜底：任何路径漏发个别 tool_done 终态时，把仍在转圈的
              // 工具气泡统一翻成「已停止」，不允许出现永久「进行中」。
              if (evt.cancelled) {
                aborted = true // 取消是正常终态，不应再补「没有收到回复」兜底气泡。
                applyRunOutcome(evt.run_outcome || {
                  status: 'interrupted', runId: currentRunId,
                }, Number.isInteger(eventUserMessageId) && eventUserMessageId > 0
                  ? eventUserMessageId
                  : undefined)
                for (const item of messages.value.filter(message => message.runId === currentRunId)) {
                  if (item?.role === 'tool' && (item.toolStatus === 'queued' || item.toolStatus === 'running' || item.toolStatus === 'waiting')) {
                    item.toolStatus = 'cancelled'
                  }
                }
              }
              if (currentRunId && sid != null) {
                await settleHistory()
              } else if (options.runAccess && sid != null) {
                await options.syncResumedHistory?.(sid)
              }
            }
          } else if (evt.type === 'error') {
            // 失败流也可能先于/替代 completed live 通知结束；刷新列表以收敛运行态。
            void options.fetchSessions()
            if (live()) {
              if (onSessionId && options.runAccess && currentRunId && evt.delivery_interrupted === true) {
                interruptedDelivery = { runId: currentRunId, message: evt.message }
                continue
              }
              sawStreamError = true
              options.clearStatus()
              playGuguSfx('error')
              if (evt.run_outcome && typeof evt.run_outcome === 'object') {
                applyRunOutcome(
                  evt.run_outcome as ChatMessage['runOutcome'],
                  Number.isInteger(eventUserMessageId) && eventUserMessageId > 0
                    ? eventUserMessageId
                    : undefined,
                )
                await options.scrollBottom()
                continue
              }
              const messageKey = typeof evt.message_key === 'string' ? evt.message_key : ''
              const params = (evt.message_params && typeof evt.message_params === 'object')
                ? { ...evt.message_params }
                : undefined
              const errorText = messageKey
                ? translateAgentError(messageKey, params)
                : (evt.message || evt.detail || i18n.global.t('chatUi.genericError'))
              messages.value.push({ id: mkid(), role: 'ai', text: errorText, time: now() })
              aiMessageId = messages.value[messages.value.length - 1]?.id ?? null
              syncAiIndex()
              await options.scrollBottom()
            }
          }
        }
      }
      if (sawStreamError && live()) await settleHistory()
    } finally {
      if (streamScrollRaf !== null) {
        window.cancelAnimationFrame(streamScrollRaf)
        streamScrollRaf = null
      }
      syncAiIndex()
      if (!detached && viewGeneration === options.getViewGeneration() && aiIdx !== -1 && messages.value[aiIdx]) {
        const m = messages.value[aiIdx]
        // 新会话打开时默认问候已经展示在列表里。若模型仍原样复述，
        // 丢掉这条重复流，只保留原来的问候气泡，避免用户看到两条相同回复。
        const duplicateGreeting = Boolean(displayedGreeting && !m.files?.length && m.text.trim() === displayedGreeting)
        m.streaming = false
        m.html = renderMd(m.text)
        if (duplicateGreeting || (!m.text?.trim() && !m.files?.length)) {
          messages.value.splice(aiIdx, 1)
          aiMessageId = null
          aiIdx = -1
        }
      }
    }
    return { aiIdx, usedTools, detached, sid, aborted, interactionPaused, receivedAssistantContent,
      cancelledTerminal: sawCancelledTerminal, interruptedDelivery }
  }

  function hasRunUserMessage(runId: string) {
    return messages.value.some(message => message.role === 'user' && message.runId === runId)
  }

  // 续看：打开会话时若它正在生成（messages 接口返回 active），重连看后端跑完。
  async function resumeStream(id: number, runId?: string) {
    if (abortCtrl.value && (!runId || runIds.get(abortCtrl.value) === runId)) return
    if (sessionId.value !== id) return
    // 已确认时旧流可能仍在结束等待态。切换订阅不取消后端运行。
    if (runId) abortCtrl.value?.abort()
    const viewGeneration = options.getViewGeneration()
    const controller = new AbortController()
    runSessionIds.set(controller, id)
    if (runId) runIds.set(controller, runId)
    abortCtrl.value = controller             // 让下次切会话能 abort 掉这条续看
    streaming.value = true; options.clearStatus()
    let cancelledTerminal = false
    try {
      if (runId && !hasRunUserMessage(runId)) await options.syncResumedHistory?.(id)
      if (viewGeneration !== options.getViewGeneration() || sessionId.value !== id || abortCtrl.value !== controller
        || controller.signal.aborted) return
      options.setStatus(options.thinkingItem())
      let body: ReadableStream<Uint8Array>
      let activeRunId = runId
      if (options.runAccess) {
        if (!activeRunId) {
          const state = await options.runAccess.readState(id)
          if (!state.runId || ['completed', 'failed', 'cancelled'].includes(state.status)) return
          activeRunId = state.runId
        }
        controller.signal.throwIfAborted()
        bindRunId(controller, id, activeRunId)
        body = options.runAccess.resume(id, activeRunId, controller.signal)
      } else {
        const res = await (options.httpStream ?? chatHttpStream).resume(id, runId, controller.signal)
        if (isUnauthorizedResponse(res)) return
        if (!res.ok || !res.body) return
        body = res.body
      }
      const r = await consumeStream(body.getReader(), id, viewGeneration, undefined, controller)
      cancelledTerminal = r.cancelledTerminal
      options.refreshAfterTools(r.usedTools)
    } catch { /* 续看失败/被切走中断都不打扰 */ }
    finally {
      const ownsResumedView = viewGeneration === options.getViewGeneration()
        && sessionId.value === id && abortCtrl.value === controller
      // 仍停在本会话才收尾全局指示，避免切走后清掉新会话续看的状态
      if (ownsResumedView) {
        if (!cancelledTerminal) options.clearStatus()
        streaming.value = false
        abortCtrl.value = null
        if (cancelledTerminal) {
          window.setTimeout(() => {
            if (!streaming.value && abortCtrl.value === null) options.clearStatus()
          }, 2400)
        }
      }
      // 续看期间排队的消息必须在这里接续发送：之前漏了这一步，续看流结束后
      // 队列永远无人消费，排队的消息显示着「已发出」却从未 POST（2026-09-11 修复）。
      if (ownsResumedView) await drainPendingQueue()
    }
  }

  // 后端重启、SSE 断开或 Redis 活跃快照过期后，浏览器可能还保留本地 streaming=true。
  // 这种状态不能把新消息永久塞进 pendingQueue；只有明确读到服务端已无活跃生成时才复位，
  // 查询失败则保留原状态，避免 Redis 短暂不可用时与正在运行的任务并发。
  async function reconcileStaleStreaming(expectedViewGeneration: number): Promise<void> {
    if (!streaming.value) return
    const controller = abortCtrl.value
    const sid = controller ? sessionIdForRun(controller) : sessionId.value
    if (sid == null) return
    try {
      const state = options.runAccess
        ? await options.runAccess.readState(sid).then(result => ({ active: result.status === 'running' || result.status === 'preparing' }))
        : await agentApi.getSessionState(String(sid))
      if (expectedViewGeneration !== options.getViewGeneration()) return
      if (abortCtrl.value !== controller) return
      if ((controller ? sessionIdForRun(controller) : sessionId.value) !== sid) return
      if (state.active !== false) return
      controller?.abort()
      abortCtrl.value = null
      options.clearStatus()
      streaming.value = false
    } catch {
      // 状态查询失败时不擅自放行，等待现有流或用户重试。
    }
  }

  async function dispatchQueuedInBackground(
    text: string,
    attachments: ChatFile[],
    references: ChatReference[],
    sessionId: number,
    itemKey: number,
    queueId: string,
    claimToken: string | null,
    clientMessageId: string,
    credentialId: number | null | undefined,
    modelId: string | undefined,
  ) {
    if (options.runAccess) {
      const stream = options.runAccess.send({ id: sessionId, text, clientMessageId, modelId, attachments, references,
        ...(claimToken ? { queueClaim: { key: itemKey, token: claimToken } } : {}),
      }, new AbortController().signal)
      const reader = stream.getReader()
      const decoder = createAgentChatSseDecoder()
      const identity = `${queueId}:${itemKey}`
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          for (const raw of decoder.push(chunk.value)) {
            let event
            try { event = JSON.parse(raw) } catch { continue }
            if (event?.type === 'session_id' && event.session_id === sessionId && event.client_message_id === clientMessageId) {
              pendingQueue.value = pendingQueue.value.filter(item => queueIdentity(item) !== identity)
            }
          }
        }
      } finally { reader.releaseLock() }
      return
    }
    const res = await (options.httpStream ?? chatHttpStream).send({
      text, clientMessageId, sessionId, queueId, itemKey, claimToken, attachments, references, credentialId,
    })
    if (isUnauthorizedResponse(res)) return
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!res.body) throw new Error('empty response body')
    const reader = res.body.getReader()
    try {
      while (!(await reader.read()).done) { /* 响应归目标会话，当前视图不消费 */ }
    } finally {
      reader.releaseLock()
    }
  }

  async function send(
    forcedText?: string,
    forcedAttachments?: ChatFile[],
    forcedReferences?: ChatReference[],
    queuedItemKey?: number,
    queuedViewGeneration?: number,
    queuedSessionId?: number | null,
    queuedQueueId?: string,
    queuedClaimToken?: string | null,
    queuedModelId?: string,
    onRunWaiting?: () => void,
  ) {
    const viewGeneration = queuedViewGeneration ?? options.getViewGeneration()
    const isQueuedDispatch = queuedItemKey !== undefined
    const targetSessionId = isQueuedDispatch ? (queuedSessionId ?? null) : sessionId.value
    const credentialId = options.composerRef.value?.selectedCredentialId?.()
    const modelId = options.runAccess ? queuedModelId ?? options.composerRef.value?.selectedModelId?.() : undefined
    const queueId = queuedQueueId || (targetSessionId == null ? draftPendingQueueId : getSessionPendingQueueId(targetSessionId))
    const queuedIdentity = queuedItemKey !== undefined ? `${queueId}:${queuedItemKey}` : ''
    const invocationIsCurrent = () => viewGeneration === options.getViewGeneration()
    const queuedItemIsCurrent = () => {
      if (queuedItemKey === undefined) return true
      return !cancelledQueueKeys.has(queuedIdentity)
        && (targetSessionId != null || invocationIsCurrent())
    }
    const mayContinue = () => (isQueuedDispatch || invocationIsCurrent()) && queuedItemIsCurrent()

    // forcedText 来自"排队接力"（队首消息）：此时用户气泡已在入队时显示过，不重复推
    const fromInput = forcedText === undefined
    let optimisticUserMessage: ChatMessage | null = null
    const text = (fromInput ? options.inputText.value : (forcedText ?? '')).trim()
    const atts = fromInput ? options.pendingAtt.value.slice() : (forcedAttachments ?? [])   // 本次随消息发的附件
    const refs = fromInput ? options.inputReferences.value.slice() : (forcedReferences ?? [])
    if (!text && !atts.length && !(options.runAccess && refs.length)) return
    clientMessageSequence += 1
    const runAccess = options.runAccess
    const clientMessageId = runAccess ? crypto.randomUUID() : `${CLIENT_ID}:${Date.now().toString(36)}:${clientMessageSequence.toString(36)}`
    const sentAt = new Date().toISOString()
    // 队列消息目标会话与当前视图不同：仍把原始 session_id 发给后端，但不接管
    // 当前会话的 streaming/status/messages 状态。回复已落库，切回目标会话即可恢复。
    if (isQueuedDispatch && targetSessionId != null && targetSessionId !== sessionId.value) {
      if (cancelledQueueKeys.has(queuedIdentity)) return
      await dispatchQueuedInBackground(text, atts, refs, targetSessionId, queuedItemKey!, queueId, queuedClaimToken ?? null, clientMessageId, credentialId, modelId)
      return
    }
    // 草稿尚未拿到真实 session_id 时不能脱离当前草稿发送，否则后端会创建/选中错误会话。
    if (isQueuedDispatch && targetSessionId == null && !invocationIsCurrent()) return
    // 生成中：先 reconcile（可能把僵尸流态复位），再决定「直接发」还是「进排队条」。
    // 排队的消息不进对话流——展示在输入框上方的排队条，排水发送时才落入对话。
    const willQueueInitial = streaming.value
    if (willQueueInitial) {
      await reconcileStaleStreaming(viewGeneration)
      if (isQueuedDispatch && targetSessionId != null && targetSessionId !== sessionId.value) {
        if (!cancelledQueueKeys.has(queuedIdentity)) {
          await dispatchQueuedInBackground(text, atts, refs, targetSessionId, queuedItemKey!, queueId, queuedClaimToken ?? null, clientMessageId, credentialId, modelId)
        }
        return
      }
      if (!mayContinue()) return
    }
    if (fromInput) {
      const isNewCommand = /^\/new\s*$/i.test(text)
      _sessionTurn++
      if (isNewCommand && !streaming.value) {
        // /new 本身是控制命令，不成为新上下文的一部分；后端也会删除它的持久消息。
        messages.value = []
      } else if (!streaming.value) {
        optimisticUserMessage = { id: mkid(), role: 'user', text, time: now(),
          clientMessageId, _syncKey: `client:${clientMessageId}`,
          // 首条用户消息的本地时间早于服务端保存问候的时间，等历史回填后再参与时间排序。
          _createdAt: targetSessionId == null && messages.value[0]?._greeting ? undefined : sentAt,
          references: refs.length ? refs : undefined,
          files: atts.length ? atts.map(a => ({ name: a.name, ext: a.ext, size_bytes: a.size, attach_id: a.attach_id, kind: a.kind, duration: a.duration, upload: true, _thumbUrl: a._thumbUrl, img_width: a.img_width, img_height: a.img_height })) : undefined }
        messages.value.push(optimisticUserMessage)
      }
      options.inputText.value = ''
      options.inputReferences.value = []
      options.pendingAtt.value = []
      options.composerRef.value?.resetHeight()
      options.trackMessageSent?.(_sessionTurn)
      await options.scrollBottom(true)
      if (!mayContinue()) return
    }
    if (streaming.value) {
      if (queuedItemKey !== undefined) return
      // 等待状态对齐期间，新对话可能已经拿到正式会话 ID。
      // 入队时从同一个会话状态生成队列标识和归属。
      const queuedSession = sessionId.value
      const pendingQueueId = queuedSession == null ? draftPendingQueueId : getSessionPendingQueueId(queuedSession)
      const item: QueuedMessage = {
        key: createPendingQueueKey(),
        queue_id: pendingQueueId,
        queueId: pendingQueueId,
        text, attachments: atts, references: refs,
        ...(modelId ? { modelId } : {}),
        sessionId: queuedSession, viewGeneration,
      }
      pendingQueue.value.push(item)
      setPendingQueueRecoveryNeeded(true)
      try {
        await persistQueueItem(item)
      } catch (error) {
        options.onQueuePersistenceError?.(error)
      }
      return
    }

    // 发送新消息只切换订阅，旧 Run 由宿主继续等待和接收结果。
    abortCtrl.value?.abort()
    streaming.value = true; options.clearStatus(); options.setStatus(options.thinkingItem())
    const requestController = new AbortController()
    abortCtrl.value = requestController
    await options.scrollBottom()
    // scrollBottom 等待期间切走了：队列请求继续按队列项的目标会话后台发送，
    // 普通输入则停止；不能醒来后读取新 sessionId 并错投。
    if (!mayContinue() || (isQueuedDispatch && targetSessionId != null && targetSessionId !== sessionId.value)) {
      if (isQueuedDispatch && targetSessionId != null && !cancelledQueueKeys.has(queuedIdentity)) {
        // 会话切换方已接管全局 UI 状态；这里只释放仍指向旧请求的控制器引用。
        if (abortCtrl.value === requestController) abortCtrl.value = null
        await dispatchQueuedInBackground(text, atts, refs, targetSessionId, queuedItemKey!, queueId, queuedClaimToken ?? null, clientMessageId, credentialId, modelId)
        return
      }
      if (invocationIsCurrent() && abortCtrl.value === requestController) {
        streaming.value = false
        abortCtrl.value = null
        options.clearStatus()
      }
      return
    }
    let ownerSid = targetSessionId   // 队列项显式归属的 session；普通发送取当前会话
    runSessionIds.set(requestController, ownerSid)
    let resolvedSid = ownerSid         // 流里 session_id 事件后回填成真实 id
    let cancelledTerminal = false
    let aiIdx = -1
    const usedTools = new Set<string>()

    // 新会话且当前显示着默认问候 → 把问候随首条消息带给后端，落为本会话首条 assistant 消息，
    // 这样咕咕回复时能看到「自己已经打过招呼」，不会把用户对问候的回复当成对话刚开始。
    const _g0 = messages.value[0]
    const greetingForSession = (ownerSid == null && _g0?._greeting) ? (_g0._greetFull || _g0.text || '') : ''

    let serviceUnavailable = false
    let interruptedDelivery: Awaited<ReturnType<typeof consumeStream>>['interruptedDelivery']
    try {
      let streamBody: ReadableStream<Uint8Array>
      if (runAccess) {
        if (ownerSid == null) {
          const title = text.slice(0, 48) || i18n.global.t('chatUi.newConversation')
          const created = await runAccess.createSession(title, greetingForSession || undefined)
          ownerSid = created.id
          if (viewGeneration === options.getViewGeneration() && sessionId.value == null) options.bindNewSessionId(created.id)
          await options.fetchSessions()
        }
        if (ownerSid == null) throw new Error('会话创建失败')
        runSessionIds.set(requestController, ownerSid)
        streamBody = runAccess.send({
          id: ownerSid, text, clientMessageId, modelId, attachments: atts, references: refs,
          ...(queuedItemKey !== undefined && queuedClaimToken ? { queueClaim: { key: queuedItemKey, token: queuedClaimToken } } : {}),
        }, requestController.signal)
      } else {
        const res = await (options.httpStream ?? chatHttpStream).send({
          text, clientMessageId, sessionId: ownerSid, queueId, itemKey: queuedItemKey,
          claimToken: queuedClaimToken, attachments: atts, references: refs, credentialId,
          greeting: greetingForSession,
        }, requestController.signal)
        if (isUnauthorizedResponse(res)) return
        serviceUnavailable = res.status === 502 || res.status === 503 || res.status === 504
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        if (!res.body) throw new Error('empty response body')
        streamBody = res.body
      }

      resolvedSid = ownerSid
      const r = await consumeStream(streamBody.getReader(), ownerSid, viewGeneration, (_acceptedSessionId, timelineOrder, userMessageId) => {
        if (optimisticUserMessage && userMessageId) {
          // 用响应式代理补稳定身份，并折叠历史同步可能已插入的竞态副本。
          messages.value = attachPersistedIdentity(
            messages.value, optimisticUserMessage, userMessageId, timelineOrder,
          )
        }
        runSessionIds.set(requestController, _acceptedSessionId)
        if (!runAccess && stopWaitingForSessionId.delete(requestController))
          requestRunCancellation(_acceptedSessionId, requestController)
        if (queuedItemKey === undefined) return
        pendingQueue.value = pendingQueue.value.filter(item => queueIdentity(item) !== queuedIdentity)
        if (ownerSid !== sessionId.value || viewGeneration !== options.getViewGeneration()) return
        optimisticUserMessage = {
          id: mkid(), role: 'user', text, time: now(),
          clientMessageId, _syncKey: `client:${clientMessageId}`,
          dbId: userMessageId,
          _createdAt: sentAt,
          references: refs.length ? refs : undefined,
          files: atts.length ? atts.map(a => ({ name: a.name, ext: a.ext, size_bytes: a.size, attach_id: a.attach_id, kind: a.kind, duration: a.duration, upload: true, _thumbUrl: a._thumbUrl, img_width: a.img_width, img_height: a.img_height })) : undefined,
          _timelineOrder: timelineOrder,
        }
        messages.value.push(optimisticUserMessage)
      }, requestController, onRunWaiting)
      resolvedSid = r.sid
      // session_id 事件可能在浏览器切换/重连的边界丢失；流本身已经返回真实
      // id，补回会话身份并迁移仍带草稿归属的队列项。
      if (viewGeneration === options.getViewGeneration() && sessionId.value == null && r.sid != null) {
        sessionId.value = r.sid
      }
      if (r.sid != null) resolvePendingSession(r.sid, viewGeneration)
      aiIdx = r.aiIdx
      cancelledTerminal = r.cancelledTerminal
      interruptedDelivery = r.interruptedDelivery
      r.usedTools.forEach(t => usedTools.add(t))
      // 用户中途切走了 → 别把兜底气泡塞进当前别的会话视图（回复已在后端，切回会重载）
      if (viewGeneration === options.getViewGeneration() && sessionId.value === resolvedSid
        && abortCtrl.value === requestController
        && !interruptedDelivery && aiIdx === -1 && !r.receivedAssistantContent && !r.detached && !r.aborted && !r.interactionPaused) {
        messages.value.push({ id: mkid(), role: 'ai', text: i18n.global.t('chatUi.noReply'), time: now() })
        await options.scrollBottom()
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError' && viewGeneration === options.getViewGeneration()
        && sessionId.value === resolvedSid && abortCtrl.value === requestController) {
        if (runAccess && resolvedSid != null) await options.syncResumedHistory?.(resolvedSid)
        options.clearStatus()
        if (serviceUnavailable) {
          if (optimisticUserMessage) {
            const message = messages.value.find(item => item.id === optimisticUserMessage?.id)
            if (message) message.runOutcome = { status: 'failed' }
          }
          showAppError(i18n.global.t('chatUi.serviceUnavailable'))
        } else {
          messages.value.push({ id: mkid(), role: 'ai', text: i18n.global.t('chatUi.networkError'), time: now() })
        }
        await options.scrollBottom()
      }
      // 发送失败时清理本次带的草稿附件（best-effort，只是降低草稿孤儿产生速度的优化，
      // 不是主清理机制——后端只在附件仍是草稿态时才真的删，消息其实已经发送成功、
      // 只是这次响应丢失/超时的情况会被后端拒绝，不会误删，见 PRD-STORAGE-1）
      if (e?.name !== 'AbortError' && queuedItemKey === undefined && atts.length) {
        for (const attachment of atts) {
          if (!attachment.attach_id) continue
          const deleteDraft = options.deleteDraftAttachment ?? agentApi.deleteDraftAttachment
          void deleteDraft(attachment.attach_id).catch(() => {})
        }
      }
    } finally {
      // 仍停在本次发送的会话才收尾全局状态；切走后这些状态归新会话的续看流管，别清掉
      let releasedOwnController = false
      const ownsCurrentView = () => viewGeneration === options.getViewGeneration()
        && sessionId.value === resolvedSid
        && (abortCtrl.value === requestController || (releasedOwnController && abortCtrl.value === null))
      if (ownsCurrentView()) {
        // 流式结束：把该条 AI 消息标记为非流式，触发 markdown 渲染（流式中按纯文本显示，避免半截表格/代码块闪烁）
        if (aiIdx !== -1 && messages.value[aiIdx]) messages.value[aiIdx].streaming = false
        if (!cancelledTerminal) options.clearStatus()
        streaming.value = false
        if (abortCtrl.value === requestController) {
          abortCtrl.value = null
          releasedOwnController = true
        }
        if (cancelledTerminal) {
          window.setTimeout(() => {
            if (!streaming.value && abortCtrl.value === null) options.clearStatus()
          }, 2400)
        }
        options.loadQuota()   // 回复消耗精力，刷新一次——耗尽时顶部状态即时变「休息中」（不 await，原逻辑就是 fire-and-forget）
        // markdown 重渲染后内容变高，MutationObserver 此时已因 streaming=false 停止跟随，
        // 需在 nextTick 后再滚一次，否则底部时间戳会被截掉
        await options.scrollBottom()
      }
      // 目标命令会修改 session_context；刷新会话元数据，让标题旁的状态胶囊即时同步。
      if (ownsCurrentView() && /^\/goal(?:\s|$)/i.test(text)) {
        await options.fetchSessions()
      }
      // 解除 workspace 绑定会更新会话元数据；同步会话列表，让标题栏立即移除工作区名称。
      if (ownsCurrentView() && /^\/workspace\s+(?:unlink|off|none|unbind)\s*$/i.test(text)) {
        await options.fetchSessions()
      }
      if (/^(?:\/|／)auto(?:\s|$)/i.test(text)) {
        await options.onAutomaticModeCommand?.()
      }
      // 咕咕若调用了改数据的工具，刷新对应前端视图（项目/日历/文件），免手动刷新页面
      options.refreshAfterTools(usedTools)
      // 生成期间排队的消息：取队首接着发（其自身 finally 会继续取下一条，逐条处理）。
      // 队列本身按 session_id 分组；切到其他会话不清除源会话队列，切回时继续排水。
      if (runAccess && interruptedDelivery && resolvedSid != null && ownsCurrentView()) {
        const id = resolvedSid
        const { runId, message } = interruptedDelivery
        let recovered = false
        try {
          const state = await runAccess.readState(id)
          if (ownsCurrentView() && state.runId === runId && ['preparing', 'running'].includes(state.status)) {
            recovered = true
            await resumeStream(id, runId)
          } else if (ownsCurrentView() && options.syncResumedHistory) {
            await options.syncResumedHistory(id)
            recovered = true
          }
        } catch { /* 保留当前会话，等待下一次状态通知。 */ }
        if (!recovered && ownsCurrentView()) {
          messages.value.push({ id: mkid(), role: 'ai', text: message || i18n.global.t('chatUi.genericError'), time: now() })
          await options.scrollBottom()
        }
      }
      if (ownsCurrentView()) await drainPendingQueue()
    }
  }

  return {
    streaming, abortCtrl, pendingQueue, removeQueued,
    resetSessionTurn, clearPendingQueue, resolvePendingSession,
    restorePendingQueueForSession, restorePendingQueueForDraft, drainPendingQueue,
    waitForPendingQueueWrites: () => pendingQueueWrite.catch(() => {}),
    send, stopStreaming, resumeStream,
  }
}
