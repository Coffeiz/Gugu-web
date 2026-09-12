import { ref, type Ref } from 'vue'
import { getLocale, i18n } from '@/i18n'
import { trackApi, agentApi, CLIENT_ID, getToken } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import { playGuguSfx } from '@/services/sfx'
import type { ChatMessage, ChatFile, ChatSession, ChatReference, QueuedMessagePayload } from '../chatTypes'
import { renderMd } from '../markdown'
import { API_BASE } from '../chatConstants'
import { FILE_TOOLS, PROJECT_TOOLS, CALENDAR_TOOLS } from './useChatActions'
import type GuguChatComposer from '../GuguChatComposer.vue'
import { createPendingQueueKey, getDraftPendingQueueId, getSessionPendingQueueId, setPendingQueueRecoveryNeeded } from './chatPendingQueueStorage'
import { dispatchPendingQueueItem } from './chatPendingQueueDispatch'

interface StatusItem { kind: 'text' | 'dots' | 'hide'; label?: string }

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
export function useChatStream(options: {
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
  refreshAfterTools: (usedTools: Set<string>) => Promise<void>
  loadQuota: () => void
  playIncomingMessageSfx: () => void
  onQueuePersistenceError?: (error: unknown) => void
  onQueueDispatchError?: (error: unknown) => void
  onContentReset?: () => void
}) {
  const liveStore = useLiveStore()
  const { messages, mkid, now, sessionId, sessions } = options

  const streaming = ref(false)
  const abortCtrl = ref<AbortController | null>(null)
  const draftPendingQueueId = getDraftPendingQueueId()
  // 新会话首轮在 session_id SSE 到达前仍是 null；记录后台生成归属，
  // 让中断按钮不会因为前端尚未切换 sessionId 而漏发取消请求。
  let activeSessionId: number | null = null
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
    // 排队的照样发，而不是一起被丢掉）。
    const id = activeSessionId ?? sessionId.value
    abortCtrl.value?.abort()
    if (id != null) agentApi.cancelSession(String(id)).catch(() => {})
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
    }
  }

  function persistDraftQueue(queueId: string) {
    const draftItems = pendingQueue.value.filter(item => item.queueId === queueId && item.sessionId == null)
    const items = draftItems.map(toPayload)
    return enqueuePendingQueueWrite(async () => {
      await agentApi.updatePendingQueue(queueId, items)
      for (const item of draftItems) persistedQueueItems.add(queueIdentity(item))
      if (items.length || pendingQueue.value.length) setPendingQueueRecoveryNeeded(true)
    })
  }

  function persistQueueItem(item: QueuedMessage) {
    if (item.sessionId == null) return persistDraftQueue(item.queueId)
    return enqueuePendingQueueWrite(async () => {
      await agentApi.patchPendingQueue(item.queueId, item.sessionId!, [toPayload(item)])
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
      await agentApi.patchPendingQueue(item.queueId, item.sessionId!, [], [item.key])
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

  function restorePendingQueueForSession(id: number, serverItems: QueuedMessagePayload[] = []) {
    const restored = (Array.isArray(serverItems) ? serverItems : [])
      .filter(item => item.session_id === id)
      .map(item => ({
        ...item,
        queueId: item.queue_id,
        sessionId: id,
        // 恢复后绑定当前会话视图；队列归属仍以 sessionId 为准。
        viewGeneration: options.getViewGeneration(),
      }))
    const restoredIdentities = new Set(restored.map(queueIdentity))
    const previousSessionItems = pendingQueue.value.filter(item => item.sessionId === id)
    const unsavedLocalItems = previousSessionItems.filter(item =>
      item.sessionId === id
      && !persistedQueueItems.has(queueIdentity(item))
      && !restoredIdentities.has(queueIdentity(item)),
    )
    for (const item of previousSessionItems) {
      if (!restoredIdentities.has(queueIdentity(item)) && !unsavedLocalItems.includes(item)) {
        persistedQueueItems.delete(queueIdentity(item))
      }
    }
    pendingQueue.value = [
      ...pendingQueue.value.filter(item => item.sessionId !== id),
      ...restored,
      ...unsavedLocalItems,
    ]
    for (const item of restored) {
      cancelledQueueKeys.delete(queueIdentity(item))
      persistedQueueItems.add(queueIdentity(item))
    }
    if (serverItems.length) setPendingQueueRecoveryNeeded(true)
  }

  function restorePendingQueueForDraft(items: QueuedMessagePayload[]) {
    const restored = items.filter(item => item.session_id == null).map(item => ({
      ...item,
      queueId: item.queue_id,
      sessionId: null,
      viewGeneration: options.getViewGeneration(),
    }))
    const restoredIdentities = new Set(restored.map(queueIdentity))
    const previousDraftItems = pendingQueue.value.filter(item => item.sessionId == null)
    const unsavedLocalItems = previousDraftItems.filter(item =>
      !persistedQueueItems.has(queueIdentity(item))
      && !restoredIdentities.has(queueIdentity(item)),
    )
    for (const item of previousDraftItems) {
      if (!restoredIdentities.has(queueIdentity(item)) && !unsavedLocalItems.includes(item)) {
        persistedQueueItems.delete(queueIdentity(item))
      }
    }
    pendingQueue.value = [
      ...pendingQueue.value.filter(item => item.sessionId != null),
      ...restored,
      ...unsavedLocalItems,
    ]
    for (const item of restored) {
      cancelledQueueKeys.delete(queueIdentity(item))
      persistedQueueItems.add(queueIdentity(item))
    }
    if (items.length) setPendingQueueRecoveryNeeded(true)
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
              const response = await agentApi.claimPendingQueueItem(item.queueId, item.sessionId, item.key)
              return response.claim_token
            },
            release: async (item, claimToken) => {
              if (item.sessionId != null) {
                await agentApi.releasePendingQueueItem(item.queueId, item.sessionId, item.key, claimToken)
              }
            },
            dispatch: async (item, claimToken) => {
              const belongsToCurrentView = item.sessionId === sessionId.value
                && item.viewGeneration === options.getViewGeneration()
              if (belongsToCurrentView) {
                options.clearStatus()
                options.setStatus(options.thinkingItem())
              }
              await send(item.text, item.attachments, item.references, item.key, item.viewGeneration, item.sessionId, item.queueId, claimToken)
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
      await agentApi.updatePendingQueue(draftPendingQueueId, [])
      await agentApi.patchPendingQueue(
        targetQueueId,
        realId,
        migrated.map(toPayload),
      )
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
    replayText = '',
    onSessionId?: (id: number, timelineOrder: number) => void,
  ) {
    const streamStartedAt = Date.now()
    const decoder = new TextDecoder()
    let buf = '', aiIdx = -1, aborted = false, interactionPaused = false
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
    let detached = false         // 一旦用户切到别的会话，本流永久脱离、不再污染当前视图
    let replaySuppressed = false
    const displayedGreeting = ownerSid == null
      ? (messages.value.find(m => m._greeting)?._greetFull || '').trim()
      : ''
    const usedTools = new Set<string>()
    let currentRoundId = ''
    let currentRunId = ''
    const toolMessageIndexes = new Map<string, number>()
    let timelineOrder = messages.value.reduce(
      (max, message) => Math.max(max, message._timelineOrder ?? 0),
      0,
    )
    const nextTimelineOrder = () => ++timelineOrder
    const sortLiveTimeline = () => {
      messages.value.sort((a, b) => {
        if (a._timelineOrder == null || b._timelineOrder == null) return 0
        return a._timelineOrder - b._timelineOrder
      })
    }
    // 每个 round 的正文必须是独立气泡。工具调用前的草稿属于上一轮，
    // 下一轮 token 不能继续写入同一个 aiIdx，否则 UI 会把多轮正文拼成一条消息。
    const finishRoundMessage = () => {
      if (aiIdx === -1 || !messages.value[aiIdx]) return
      const message = messages.value[aiIdx]
      message.streaming = false
      if (message.text.trim()) message.html = renderMd(message.text)
      aiIdx = -1
    }
    // 当前看的还是本流的会话吗？切走后置 detached（之后切回靠 loadSession 干净重载，不半路重接）
    const live = () => {
      if (detached || viewGeneration !== options.getViewGeneration()) {
        detached = true
        return false
      }
      if (sessionId.value !== (sid ?? ownerSid)) { detached = true; return false }
      return true
    }
    try {
      while (true) {
        let chunk
        try { chunk = await reader.read() }
        catch (e: any) { if (e?.name === 'AbortError') { aborted = true; break; } throw e }   // 切会话会 abort：优雅收尾，别当网络错
        const { done, value } = chunk
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim(); if (!raw) continue
          let evt; try { evt = JSON.parse(raw) } catch { continue }
          if (evt.type === 'session_id') {
            onSessionId?.(Number(evt.session_id), onSessionId ? nextTimelineOrder() : 0)
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
            activeSessionId = evt.session_id
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
          } else if (evt.type === 'round_start') {
            finishRoundMessage()
            currentRunId = String(evt.run_id || currentRunId)
            currentRoundId = String(evt.round_id || `round-${toolMessageIndexes.size + 1}`)
          } else if (evt.type === '_new_round') {
            // 兼容旧事件：新版 round_start 已先建立身份，旧客户端只看到这里也不会报错。
            finishRoundMessage()
            currentRunId = String(evt.run_id || currentRunId)
            if (evt.round_id) currentRoundId = String(evt.round_id)
          } else if (evt.type === 'tool_call') {
            if (evt.name && !evt.name.startsWith('_')) usedTools.add(evt.name)
            const toolCallId = String(evt.tool_call_id || `${evt.round_id || currentRoundId || 'round'}-tool-${toolMessageIndexes.size + 1}`)
            if (live() && !evt.name?.startsWith('_')) {
              const existingIndex = toolMessageIndexes.get(toolCallId)
              if (existingIndex !== undefined && messages.value[existingIndex]) {
                const existing = messages.value[existingIndex]
                existing.runId = evt.run_id || existing.runId
                existing.roundId = evt.round_id || existing.roundId
                existing.toolName = evt.name || existing.toolName
                existing.toolLabel = evt.label || existing.toolLabel
                existing.toolStatus = evt.status || existing.toolStatus || 'running'
                if (evt.input !== undefined) existing.toolInput = evt.input
              } else {
                const messageId = mkid()
                messages.value.push({
                  id: messageId, role: 'tool', text: '', time: now(),
                  _timelineOrder: nextTimelineOrder(),
                  runId: evt.run_id, roundId: evt.round_id || currentRoundId,
                  toolCallId, toolName: evt.name, toolLabel: evt.label,
                  toolStatus: evt.status || 'running', toolInput: evt.input,
                  _toolStartedAt: Date.now(),
                })
                sortLiveTimeline()
                toolMessageIndexes.set(toolCallId, messages.value.findIndex(item => item.id === messageId))
                await options.scrollBottom()
              }
            }
            // label 已由后端解析（含「状态命名」覆盖 + 复查前缀）；气泡常驻，仅替换文字。
            if (live()) options.setStatus({ kind: 'text', label: evt.label || evt.name })
          } else if (evt.type === 'tool_done') {
            // 改动类工具一完成就即时 bump 对应资源（走已连好的对话流，不等回合末、不靠 best-effort
            // 的 events SSE）→ 文件预览 / 项目卡 / 日历当场刷新。视图是全局的，切走也该刷，故不受 live() 限制。
            if (evt.name) {
              if (FILE_TOOLS.has(evt.name)) liveStore.bump('files')
              else if (PROJECT_TOOLS.has(evt.name)) liveStore.bump('projects')
              else if (CALENDAR_TOOLS.has(evt.name)) liveStore.bump('calendar')
            }
            const toolCallId = evt.tool_call_id ? String(evt.tool_call_id) : ''
            const toolIndex = toolCallId ? toolMessageIndexes.get(toolCallId) : undefined
            if (toolIndex !== undefined && messages.value[toolIndex]) {
              messages.value[toolIndex].toolStatus = evt.status || 'success'
              if (evt.result !== undefined) messages.value[toolIndex].toolResult = evt.result
              const startedAt = (messages.value[toolIndex] as ChatMessage & { _toolStartedAt?: number })._toolStartedAt
              if (startedAt) messages.value[toolIndex].toolDurationMs = Math.max(0, Date.now() - startedAt)
            }
            // 任一工具结束都回到思考态；下一轮工具调用会继续替换文字，不能让气泡闪退。
            if (live()) options.setStatus(options.thinkingItem())
          } else if (evt.type === 'interaction_required') {
            interactionPaused = true
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
              if (existing?.interaction) {
                // loadSession 先恢复历史、resumeStream 再收到快照时会命中这里；
                // 合并而不是追加，避免刷新后同一个交互出现两张卡。
                existing.runId = evt.run_id
                existing.roundId = evt.round_id
                existing.interaction.toolCallId = evt.tool_call_id ? String(evt.tool_call_id) : existing.interaction.toolCallId
                existing.interaction.title = String(evt.title || existing.interaction.title || i18n.global.t('chatUi.confirmRequired'))
                existing.interaction.body = String(evt.body || existing.interaction.body || '')
                existing.interaction.expiresAt = evt.expires_at ? String(evt.expires_at) : existing.interaction.expiresAt
                existing.interaction.allowTextInput = Boolean(evt.allow_text_input ?? existing.interaction.allowTextInput)
                existing.interaction.customInputActive = Boolean(evt.custom_input_active ?? existing.interaction.customInputActive)
                existing.interaction.taskPaused = Boolean(evt.task_paused ?? existing.interaction.taskPaused)
                if (!existing.interaction.resolved) existing.interaction.options = evt.options
              } else {
                messages.value.push({
                  id: mkid(), role: 'interaction', text: '', time: now(),
                  _timelineOrder: nextTimelineOrder(),
                  runId: evt.run_id, roundId: evt.round_id,
                  interaction: {
                    promptId, kind: String(evt.kind || 'confirm'),
                    toolCallId: evt.tool_call_id ? String(evt.tool_call_id) : null,
                    title: String(evt.title || i18n.global.t('chatUi.confirmRequired')), body: String(evt.body || ''),
                    options: evt.options,
                    allowTextInput: Boolean(evt.allow_text_input),
                    customInputActive: Boolean(evt.custom_input_active),
                    taskPaused: Boolean(evt.task_paused),
                    expiresAt: evt.expires_at ? String(evt.expires_at) : undefined,
                  },
                })
                sortLiveTimeline()
              }
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
          } else if (evt.type === 'token') {
            if (live()) {
              if (String(evt.content || '').trim()) receivedAssistantContent = true
              // 切回会话时，历史接口可能已经拿到完整助手消息，而 active 标记
              // 尚未来得及清掉。resume 的首个 token 是同一段 Redis snapshot，
              // 这时跳过它；真正后续新增 token 仍正常创建/追加流式气泡。
              if (!replaySuppressed && replayText && String(evt.content || '').trim() === replayText) {
                replaySuppressed = true
                continue
              }
              options.clearStatus()   // 真回复开始 → 打断状态队列、收起指示，让位给流式正文
              if (aiIdx === -1) options.playIncomingMessageSfx()
              if (aiIdx === -1) {
                const messageId = mkid()
                messages.value.push({
                  id: messageId, role: 'ai', text: '', time: now(), streaming: true,
                  runId: evt.run_id || currentRunId || undefined,
                  roundId: evt.round_id || currentRoundId || undefined,
                  _timelineOrder: nextTimelineOrder(),
                })
                sortLiveTimeline()
                aiIdx = messages.value.findIndex(item => item.id === messageId)
              }
              messages.value[aiIdx].text += evt.content
              scheduleStreamScroll()
            }
          } else if (evt.type === 'file') {
            if (live()) {
              receivedAssistantContent = true
              options.clearStatus()
              if (aiIdx === -1) options.playIncomingMessageSfx()
              if (aiIdx === -1) {
                const messageId = mkid()
                messages.value.push({
                  id: messageId, role: 'ai', text: '', time: now(), streaming: true,
                  runId: evt.run_id || currentRunId || undefined,
                  roundId: evt.round_id || currentRoundId || undefined,
                  _timelineOrder: nextTimelineOrder(),
                })
                sortLiveTimeline()
                aiIdx = messages.value.findIndex(item => item.id === messageId)
              }
              const m = messages.value[aiIdx]
              if (!m.files) m.files = []
              m.files.push(evt.file)
              scheduleStreamScroll()
            }
          } else if (evt.type === 'done') {
            if (live()) options.clearStatus()
          } else if (evt.type === 'error') {
            if (live()) {
              options.clearStatus()
              playGuguSfx('error')
              const messageKey = typeof evt.message_key === 'string' ? evt.message_key : ''
              const errorText = messageKey ? i18n.global.t(messageKey) : (evt.message || evt.detail || i18n.global.t('chatUi.genericError'))
              messages.value.push({ id: mkid(), role: 'ai', text: errorText, time: now() })
              aiIdx = messages.value.length - 1
              await options.scrollBottom()
            }
          }
        }
      }
    } finally {
      if (streamScrollRaf !== null) {
        window.cancelAnimationFrame(streamScrollRaf)
        streamScrollRaf = null
      }
      if (!detached && viewGeneration === options.getViewGeneration() && aiIdx !== -1 && messages.value[aiIdx]) {
        const m = messages.value[aiIdx]
        // 新会话打开时默认问候已经展示在列表里。若模型仍原样复述，
        // 丢掉这条重复流，只保留原来的问候气泡，避免用户看到两条相同回复。
        const duplicateGreeting = Boolean(displayedGreeting && !m.files?.length && m.text.trim() === displayedGreeting)
        m.streaming = false
        m.html = renderMd(m.text)
        if (duplicateGreeting || (!m.text?.trim() && !m.files?.length)) {
          messages.value.splice(aiIdx, 1)
        }
      }
    }
    // 工具执行成功后，后端可能已经持久化最终 assistant 消息，但最后一段 SSE
    // 正文在连接收尾竞态中没有被浏览器消费到。此时不能直接显示“没有回复”，
    // 先用本轮工具执行期间创建的最新 assistant 消息恢复视图。
    if (aiIdx === -1 && usedTools.size && sid != null && !detached && !aborted && !interactionPaused
        && viewGeneration === options.getViewGeneration()) {
      try {
        const recovered = await agentApi.getMessages(String(sid))
        const latest = [...(recovered.messages || [])].reverse().find((item: any) =>
          item.role === 'assistant' &&
          (item.content?.trim() || item.files?.length) &&
          (!item.createdAt || Date.parse(item.createdAt) >= streamStartedAt - 60_000),
        )
        if (latest && live()) {
          const messageId = mkid()
          messages.value.push({
            id: messageId,
            dbId: latest.id,
            role: 'ai',
            text: latest.content || '',
            html: latest.content ? renderMd(latest.content) : null,
            files: latest.files?.length ? latest.files : undefined,
            quotedText: latest.quotedText || undefined,
            time: new Date(latest.createdAt || Date.now()).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }),
            _createdAt: latest.createdAt,
            _timelineOrder: latest.timelineOrder ?? latest.id,
          })
          sortLiveTimeline()
          aiIdx = messages.value.findIndex(item => item.id === messageId)
          await options.scrollBottom()
        }
      } catch { /* 恢复失败再由调用方决定是否显示兜底提示 */ }
    }
    return { aiIdx, usedTools, detached, sid, aborted, interactionPaused, receivedAssistantContent }
  }

  // 续看：打开会话时若它正在生成（messages 接口返回 active），重连看后端跑完。
  async function resumeStream(id: number) {
    if (streaming.value) return            // 本地正在发/看，不重复连
    const viewGeneration = options.getViewGeneration()
    activeSessionId = id
    const token = getToken()
    abortCtrl.value = new AbortController()   // 让下次切会话能 abort 掉这条续看
    streaming.value = true; options.clearStatus(); options.setStatus(options.thinkingItem())
    try {
      const res = await fetch(`${API_BASE}/agent/sessions/${id}/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: abortCtrl.value.signal,
      })
      if (!res.ok) return
      if (viewGeneration !== options.getViewGeneration() || sessionId.value !== id) return   // 期间又切走了，丢弃
      if (!res.body) return
      const replayText = [...messages.value].reverse()
        .find(m => m.role === 'ai' && m.text?.trim())?.text.trim() || ''
      const r = await consumeStream(res.body.getReader(), id, viewGeneration, replayText)
      options.refreshAfterTools(r.usedTools)
    } catch { /* 续看失败/被切走中断都不打扰 */ }
    finally {
      const ownsResumedView = viewGeneration === options.getViewGeneration() && sessionId.value === id
      // 仍停在本会话才收尾全局指示，避免切走后清掉新会话续看的状态
      if (ownsResumedView) {
        options.clearStatus(); streaming.value = false; abortCtrl.value = null
      }
      if (activeSessionId === id) activeSessionId = null
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
    const sid = activeSessionId ?? sessionId.value
    if (sid == null) return
    try {
      const state = await agentApi.getMessages(String(sid)) as { active?: boolean }
      if (expectedViewGeneration !== options.getViewGeneration()) return
      if ((activeSessionId ?? sessionId.value) !== sid) return
      if (state.active !== false) return
      abortCtrl.value?.abort()
      abortCtrl.value = null
      if (activeSessionId === sid) activeSessionId = null
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
  ) {
    const token = getToken()
    const res = await fetch(`${API_BASE}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        message: text, locale: getLocale(), session_id: sessionId,
        pending_queue_id: queueId, pending_queue_item_key: itemKey,
        ...(claimToken ? { pending_queue_claim_token: claimToken } : {}),
        attachments: attachments.map(a => a.attach_id), references,
      }),
    })
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
  ) {
    const viewGeneration = queuedViewGeneration ?? options.getViewGeneration()
    const isQueuedDispatch = queuedItemKey !== undefined
    const targetSessionId = isQueuedDispatch ? (queuedSessionId ?? null) : sessionId.value
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
    const text = (fromInput ? options.inputText.value : (forcedText ?? '')).trim()
    const atts = fromInput ? options.pendingAtt.value.slice() : (forcedAttachments ?? [])   // 本次随消息发的附件
    const refs = fromInput ? options.inputReferences.value.slice() : (forcedReferences ?? [])
    if (!text && !atts.length) return
    // 队列消息目标会话与当前视图不同：仍把原始 session_id 发给后端，但不接管
    // 当前会话的 streaming/status/messages 状态。回复已落库，切回目标会话即可恢复。
    if (isQueuedDispatch && targetSessionId != null && targetSessionId !== sessionId.value) {
      if (cancelledQueueKeys.has(queuedIdentity)) return
      await dispatchQueuedInBackground(text, atts, refs, targetSessionId, queuedItemKey!, queueId, queuedClaimToken ?? null)
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
          await dispatchQueuedInBackground(text, atts, refs, targetSessionId, queuedItemKey!, queueId, queuedClaimToken ?? null)
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
        options.onContentReset?.()
      } else if (!streaming.value) {
        messages.value.push({ id: mkid(), role: 'user', text, time: now(),
          references: refs.length ? refs : undefined,
          files: atts.length ? atts.map(a => ({ name: a.name, ext: a.ext, size_bytes: a.size, attach_id: a.attach_id, kind: a.kind, duration: a.duration, upload: true, _thumbUrl: a._thumbUrl, img_width: a.img_width, img_height: a.img_height })) : undefined })
      }
      options.inputText.value = ''
      options.inputReferences.value = []
      options.pendingAtt.value = []
      options.composerRef.value?.resetHeight()
      trackApi.track('chat_message', { turn: _sessionTurn }).catch(() => {})
      await options.scrollBottom(true)
      if (!mayContinue()) return
    }
    if (streaming.value) {
      if (queuedItemKey !== undefined) return
      pendingQueue.value.push({
        key: createPendingQueueKey(),
        queue_id: queueId,
        queueId,
        text, attachments: atts, references: refs,
        sessionId: sessionId.value, viewGeneration: options.getViewGeneration(),
      })
      setPendingQueueRecoveryNeeded(true)
      try {
        await persistQueueItem(pendingQueue.value[pendingQueue.value.length - 1])
      } catch (error) {
        options.onQueuePersistenceError?.(error)
      }
      return
    }

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
        await dispatchQueuedInBackground(text, atts, refs, targetSessionId, queuedItemKey!, queueId, queuedClaimToken ?? null)
        return
      }
      if (invocationIsCurrent() && abortCtrl.value === requestController) {
        streaming.value = false
        abortCtrl.value = null
        options.clearStatus()
      }
      return
    }
    const token = getToken()
    const ownerSid = targetSessionId   // 队列项显式归属的 session；普通发送取当前会话
    activeSessionId = ownerSid
    let resolvedSid = ownerSid         // 流里 session_id 事件后回填成真实 id
    let aiIdx = -1
    const usedTools = new Set<string>()

    // 新会话且当前显示着默认问候 → 把问候随首条消息带给后端，落为本会话首条 assistant 消息，
    // 这样咕咕回复时能看到「自己已经打过招呼」，不会把用户对问候的回复当成对话刚开始。
    const _g0 = messages.value[0]
    const greetingForSession = (ownerSid == null && _g0?._greeting) ? (_g0._greetFull || _g0.text || '') : ''

    try {
      const res = await fetch(`${API_BASE}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ message: text, locale: getLocale(), session_id: ownerSid, pending_queue_id: queueId,
                               ...(queuedItemKey !== undefined ? { pending_queue_item_key: queuedItemKey } : {}),
                               ...(queuedClaimToken ? { pending_queue_claim_token: queuedClaimToken } : {}),
                               attachments: atts.map(a => a.attach_id), references: refs,
                               ...(greetingForSession ? { greeting: greetingForSession } : {}) }),
        signal: requestController.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('empty response body')

      let receivedSessionIdEvent = false
      const r = await consumeStream(res.body.getReader(), ownerSid, viewGeneration, '', (_acceptedSessionId, timelineOrder) => {
        receivedSessionIdEvent = true
        if (queuedItemKey === undefined || ownerSid !== sessionId.value || viewGeneration !== options.getViewGeneration()) return
        pendingQueue.value = pendingQueue.value.filter(item => queueIdentity(item) !== queuedIdentity)
        messages.value.push({
          id: mkid(), role: 'user', text, time: now(),
          references: refs.length ? refs : undefined,
          files: atts.length ? atts.map(a => ({ name: a.name, ext: a.ext, size_bytes: a.size, attach_id: a.attach_id, kind: a.kind, duration: a.duration, upload: true, _thumbUrl: a._thumbUrl, img_width: a.img_width, img_height: a.img_height })) : undefined,
          _timelineOrder: timelineOrder,
        })
      })
      resolvedSid = r.sid
      // session_id 事件可能在浏览器切换/重连的边界丢失；流本身已经返回真实
      // id，补回会话身份并迁移仍带草稿归属的队列项。
      if (viewGeneration === options.getViewGeneration() && sessionId.value == null && r.sid != null) {
        sessionId.value = r.sid
      }
      if (r.sid != null) resolvePendingSession(r.sid, viewGeneration)
      aiIdx = r.aiIdx
      r.usedTools.forEach(t => usedTools.add(t))
      // 用户中途切走了 → 别把兜底气泡塞进当前别的会话视图（回复已在后端，切回会重载）
      if (aiIdx === -1 && !r.receivedAssistantContent && !r.detached && !r.aborted && !r.interactionPaused) {
        messages.value.push({ id: mkid(), role: 'ai', text: i18n.global.t('chatUi.noReply'), time: now() })
        await options.scrollBottom()
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError' && viewGeneration === options.getViewGeneration() && sessionId.value === resolvedSid) {
        // fetch 抛错=连不上咕咕后端，基本都是网络问题（仅在仍停在本会话时报）
        options.clearStatus()
        messages.value.push({ id: mkid(), role: 'ai', text: i18n.global.t('chatUi.networkError'), time: now() })
        await options.scrollBottom()
      }
      // 发送失败时清理本次带的草稿附件（best-effort，只是降低草稿孤儿产生速度的优化，
      // 不是主清理机制——后端只在附件仍是草稿态时才真的删，消息其实已经发送成功、
      // 只是这次响应丢失/超时的情况会被后端拒绝，不会误删，见 PRD-STORAGE-1）
      if (e?.name !== 'AbortError' && queuedItemKey === undefined && atts.length) {
        for (const attachment of atts) {
          if (!attachment.attach_id) continue
          agentApi.deleteDraftAttachment(attachment.attach_id).catch(() => {})
        }
      }
    } finally {
      // 仍停在本次发送的会话才收尾全局状态；切走后这些状态归新会话的续看流管，别清掉
      const ownsCurrentView = () => viewGeneration === options.getViewGeneration() && sessionId.value === resolvedSid
      if (ownsCurrentView()) {
        // 流式结束：把该条 AI 消息标记为非流式，触发 markdown 渲染（流式中按纯文本显示，避免半截表格/代码块闪烁）
        if (aiIdx !== -1 && messages.value[aiIdx]) messages.value[aiIdx].streaming = false
        options.clearStatus(); streaming.value = false
        if (abortCtrl.value === requestController) abortCtrl.value = null
        options.loadQuota()   // 回复消耗精力，刷新一次——耗尽时顶部状态即时变「休息中」（不 await，原逻辑就是 fire-and-forget）
        // markdown 重渲染后内容变高，MutationObserver 此时已因 streaming=false 停止跟随，
        // 需在 nextTick 后再滚一次，否则底部时间戳会被截掉
        await options.scrollBottom()
      }
      if (activeSessionId === resolvedSid) activeSessionId = null
      // 目标/工具限制命令会修改 session_context；刷新会话元数据，让标题旁的状态胶囊即时同步。
      if (ownsCurrentView() && /^\/(?:goal|unlimited)(?:\s|$)/i.test(text)) {
        await options.fetchSessions()
      }
      // 咕咕若调用了改数据的工具，刷新对应前端视图（项目/日历/文件），免手动刷新页面
      options.refreshAfterTools(usedTools)
      // 生成期间排队的消息：取队首接着发（其自身 finally 会继续取下一条，逐条处理）。
      // 队列本身按 session_id 分组；切到其他会话不清除源会话队列，切回时继续排水。
      if (ownsCurrentView()) {
        await drainPendingQueue()
      }
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
