import { nextTick, computed, onScopeDispose, watch, type Ref } from 'vue'
import { i18n } from '@/i18n'
import { agentApi } from '@/services/api'
import { accountBoundaryEpoch, getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import type { ChatMessage, ChatSession, QueuedMessagePayload } from '../chatTypes'
import type GuguChatComposer from '../GuguChatComposer.vue'
import { createSessionMessageSynchronizer, mapSessionMessageDelta, mergeSessionMessageDelta } from './sessionMessageSync'
import type { SessionScrollAnchor } from './sessionScrollLayout'

export type SessionLoadOutcome = 'loaded' | 'superseded' | 'unavailable' | 'failed'

interface CachedSessionSnapshot {
  messages: ChatMessage[]
  ownerPlatformUserId: string | null
  isGroupSession: boolean
  pagination: { hasMore?: boolean; hasNewer?: boolean; oldestId?: number | null }
  scrollAnchor: SessionScrollAnchor | null
  accountEpoch: number
  savedAt: number
}

/**
 * 会话切换操作的唯一所有权：loadSession/newSession/deleteSession，以及从
 * sessions 派生的 webSessions/imSessions/currentSessionTitle。
 *
 * sessionId/sessions/ownerPlatformUserId/isGroupSession 这几个"当前会话
 * 身份"状态由 useChatConversation 创建并传入——它们同时也被 useChatStream
 * 读写（流里收到 session_id/session_title 事件时），真正双向共享的状态
 * 放在编排层创建一次、两边传引用，比硬塞进某一侧、再靠回调互相通知要简单。
 *
 * 不拥有流式收发本身——切会话/新建会话需要打断正在进行的流，靠注入的
 * abortCtrl/streaming/resumeStream/resetSessionTurn（来自 useChatStream）
 * 完成，这里只负责在正确的时机调用它们。
 */
export interface ChatSessionHistory {
  messages: unknown[]
  pagination?: { hasMore?: boolean; hasNewer?: boolean; oldestId?: number | null; newestId?: number | null }
  active?: boolean
  session?: Pick<ChatSession, 'workspaceName' | 'goalActive' | 'goalStatus' | 'chatType'> & { ownerPlatformUserId?: string | null }
  executionState?: string
  pendingQueue?: QueuedMessagePayload[]
}

export interface ChatSessionHistoryAccess {
  readHistory: (id: number, before?: number) => Promise<ChatSessionHistory>
  readFirstPage?: (id: number) => Promise<ChatSessionHistory>
  readChanges?: (id: number, afterId?: number) => Promise<ChatSessionHistory>
  readExecutionState?: (id: number) => Promise<string | undefined>
  deleteSession: (id: number) => Promise<unknown>
  renameSession: (id: number, title: string) => Promise<unknown>
}

export function useChatSessions(options: {
  historyAccess?: ChatSessionHistoryAccess
  messages: Ref<ChatMessage[]>
  mkid: () => number
  sessionId: Ref<number | null>
  sessions: Ref<ChatSession[]>
  ownerPlatformUserId: Ref<string | null>
  isGroupSession: Ref<boolean>
  resolveSpeaker: (
    role: string,
    platformUserId: string | null | undefined,
    platformUserName: string | null | undefined,
  ) => { role: string; speakerLabel?: string }
  bumpViewGeneration: () => number
  getViewGeneration: () => number
  composerRef: Ref<InstanceType<typeof GuguChatComposer> | null>
  abortCtrl: Ref<AbortController | null>
  streaming: Ref<boolean>
  resumeStream: (id: number) => Promise<void>
  resetSessionTurn: () => void
  clearPendingQueue: (clearOrphanedStorage?: boolean) => void
  restorePendingQueue: (id: number, items?: QueuedMessagePayload[]) => void
  drainPendingQueue: () => Promise<void>
  clearStatus: () => void
  setStatus: (item: { kind: 'text' | 'dots' | 'hide'; label?: string }) => void
  thinkingItem: () => { kind: 'text' | 'dots' | 'hide'; label?: string }
  contextCompactingItem: () => { kind: 'text' | 'dots' | 'hide'; label?: string }
  onContentReset: () => void
  onCaptureBaseScrollH: () => void
  scrollBottom: (force?: boolean) => Promise<void>
  captureScrollAnchor: () => SessionScrollAnchor | null | undefined
  restoreScrollPosition: (anchor: SessionScrollAnchor | null) => Promise<void>
  waitForSessionSettlement: (id: number) => Promise<void>
  shouldFollowBottom: () => boolean
  onHistoryReset?: () => void
  onHistoryLoaded?: (page: { hasMore?: boolean; hasNewer?: boolean; oldestId?: number | null }) => void
  getHistoryPage?: () => { hasMore?: boolean; hasNewer?: boolean; oldestId?: number | null }
  setSessionSettling: (value: boolean) => void
}) {
  const { messages, mkid, sessionId, sessions } = options

  // 切回近期会话时按服务端历史校准内存快照，再恢复阅读位置。只保留少量会话，
  // 排除一次性交互 token；带稳定事件身份的流中消息也缓存，供 resumeStream 接续前恢复画面。
  const sessionSnapshots = new Map<number, CachedSessionSnapshot>()
  const snapshotTtlMs = 5 * 60_000
  const maxSessionSnapshots = 4
  watch(accountBoundaryEpoch, () => sessionSnapshots.clear())

  function cacheSessionSnapshot(
    id: number,
    items: ChatMessage[],
    pagination: CachedSessionSnapshot['pagination'],
    scrollAnchor = sessionSnapshots.get(id)?.scrollAnchor ?? null,
  ) {
    const stableMessages = items
      .filter(message => !message.interaction && (message.dbId != null || message._timelineOrder != null))
      .map(message => ({ ...message }))
    if (!stableMessages.length) return
    sessionSnapshots.delete(id)
    sessionSnapshots.set(id, {
      messages: stableMessages,
      ownerPlatformUserId: options.ownerPlatformUserId.value,
      isGroupSession: options.isGroupSession.value,
      pagination: { ...pagination },
      scrollAnchor,
      accountEpoch: getAccountBoundaryEpoch(),
      savedAt: Date.now(),
    })
    while (sessionSnapshots.size > maxSessionSnapshots) {
      const oldest = sessionSnapshots.keys().next().value
      if (oldest == null) break
      sessionSnapshots.delete(oldest)
    }
  }

  function getCachedSessionSnapshot(id: number) {
    const snapshot = sessionSnapshots.get(id)
    if (!snapshot) return null
    if (snapshot.accountEpoch !== getAccountBoundaryEpoch() || Date.now() - snapshot.savedAt > snapshotTtlMs) {
      sessionSnapshots.delete(id)
      return null
    }
    // Map 的插入顺序作为 LRU 次序。
    sessionSnapshots.delete(id)
    sessionSnapshots.set(id, snapshot)
    return snapshot
  }

  let disposed = false
  let baselinePollTimer: ReturnType<typeof setTimeout> | null = null
  const messageSync = createSessionMessageSynchronizer({
    messages, sessionId, mkid, resolveSpeaker: options.resolveSpeaker, scrollBottom: options.scrollBottom, readChanges: options.historyAccess?.readChanges,
  })

  async function readPlatformHistory(
    access: ChatSessionHistoryAccess, id: number, known: readonly ChatMessage[], current: () => boolean,
  ) {
    const latest = known.reduce((max, message) => Math.max(max, message.dbId ?? 0), 0)
    const first = await access.readHistory(id, undefined)
    const pages = [first]
    let page = first
    let before: number | undefined
    let overlaps = false
    while (current()) {
      overlaps = latest > 0 && page.messages.some(message => message !== null && typeof message === 'object'
        && 'id' in message && typeof message.id === 'number' && message.id <= latest)
      const cursor = page.pagination?.oldestId
      if (!latest || overlaps || !page.pagination?.hasMore || cursor == null) break
      if (before !== undefined && cursor >= before) throw new Error('历史游标未前进')
      before = cursor
      page = await access.readHistory(id, before)
      pages.push(page)
    }
    return { first, pages, overlaps, pagination: page.pagination }
  }

  async function refreshSessionMessages(id: number) {
    if (!options.historyAccess || options.historyAccess.readChanges) return messageSync.refresh(id)
    if (sessionId.value !== id) return
    const generation = options.getViewGeneration()
    const account = getAccountBoundaryEpoch()
    const current = () => sessionId.value === id && options.getViewGeneration() === generation
      && getAccountBoundaryEpoch() === account
    try {
      const { pages, pagination, overlaps } = await readPlatformHistory(options.historyAccess, id, messages.value, current)
      if (!current()) return
      messages.value = mergeSessionMessageDelta(messages.value,
        pages.flatMap(page => mapSessionMessageDelta(page, mkid, options.resolveSpeaker)))
      if (!overlaps) options.onHistoryLoaded?.(pagination || {})
    } catch { /* 下一次运行事件会重新读取会话。 */ }
  }

  // 组件卸载后 tick 不能再起下一轮：仅靠 sessionId/viewGeneration 守卫是
  // 「空转不生效」，定时器本身仍会按 4s 醒一次，属于有界泄漏。
  onScopeDispose(() => {
    disposed = true
    if (baselinePollTimer) clearTimeout(baselinePollTimer)
  })

  /** 轮询基线整理是否结束；结束/切走/超时即收起提示，避免「正在整理上下文」卡在屏幕上。 */
  function pollBaselineDone(id: number, viewGeneration: number) {
    if (baselinePollTimer) clearTimeout(baselinePollTimer)
    const startedAt = Date.now()
    const tick = async () => {
      if (disposed || viewGeneration !== options.getViewGeneration() || sessionId.value !== id) return
      try {
        const executionState = options.historyAccess
          ? await options.historyAccess.readExecutionState?.(id)
          : (await agentApi.getSessionState(String(id))).executionState
        if (disposed || viewGeneration !== options.getViewGeneration() || sessionId.value !== id) return
        if (executionState !== 'baseline_updating') {
          // 整理期间用户可能已发新消息开始新一轮流式：状态指示此时归新流程管，
          // 迟到的轮询结果不能把它误清掉。
          if (!options.streaming.value) {
            options.clearStatus()
            void options.drainPendingQueue().catch(() => {})
          }
          return
        }
      } catch { /* 网络抖动下一轮再试 */ }
      if (disposed) return
      if (Date.now() - startedAt > 5 * 60_000) {
        if (!options.streaming.value) options.clearStatus()
        return
      }
      baselinePollTimer = setTimeout(tick, 4000)
    }
    baselinePollTimer = setTimeout(tick, 4000)
  }

  const webSessions = computed(() => sessions.value.filter(s => !s.source || s.source === 'web'))
  const imSessions = computed(() => sessions.value.filter(s => s.source && s.source !== 'web'))
  const currentSessionTitle = computed(() =>
    !sessionId.value ? i18n.global.t('chatUi.newConversation') : (sessions.value.find(s => s.id === sessionId.value)?.title ?? i18n.global.t('chatUi.conversation'))
  )
  const currentSessionWorkspaceName = computed(() =>
    !sessionId.value ? null : (sessions.value.find(s => s.id === sessionId.value)?.workspaceName ?? null)
  )
  const currentSessionGoalActive = computed(() =>
    !sessionId.value ? false : Boolean(sessions.value.find(s => s.id === sessionId.value)?.goalActive)
  )
  const currentSessionGoalStatus = computed(() =>
    !sessionId.value ? null : (sessions.value.find(s => s.id === sessionId.value)?.goalStatus ?? null)
  )
  const currentSessionFilesystemAuthorized = computed(() =>
    !sessionId.value ? false : Boolean(sessions.value.find(s => s.id === sessionId.value)?.filesystemAuthorized)
  )
  const currentSessionFilesystemAuthorizationEnabled = computed(() =>
    !sessionId.value ? false : Boolean(sessions.value.find(s => s.id === sessionId.value)?.filesystemAuthorizationEnabled)
  )

  async function loadSession(id: number, force = false): Promise<SessionLoadOutcome> {
    // 刷新恢复时 sessionId 会先从 sessionStorage 恢复；即使 id 相同，消息内存仍是空的，
    // 必须继续请求历史。普通侧栏重复点击仍保持无操作。
    if (!force && id === sessionId.value) {
      await options.waitForSessionSettlement(id)
      return sessionId.value === id ? 'loaded' : 'superseded'
    }
    const viewGeneration = options.bumpViewGeneration()
    const accountEpoch = getAccountBoundaryEpoch()
    const previousSessionId = sessionId.value
    const previousMessages = messages.value
    const previousOwnerPlatformUserId = options.ownerPlatformUserId.value
    const previousIsGroupSession = options.isGroupSession.value
    const previousScrollAnchor = options.captureScrollAnchor()
    if (previousSessionId != null && previousMessages.length) {
      cacheSessionSnapshot(
        previousSessionId,
        previousMessages,
        options.getHistoryPage?.() || sessionSnapshots.get(previousSessionId)?.pagination || {},
        previousScrollAnchor,
      )
    }
    const cachedSnapshot = force ? null : getCachedSessionSnapshot(id)
    let loadingHistory = true
    options.setSessionSettling(true)
    options.abortCtrl.value?.abort()        // 停掉当前会话的流式消费（后端生成不受影响、继续跑）
    options.streaming.value = false
    // 待发消息按 session_id 归属；切换只更改展示状态，恢复和排水时按目标会话筛选。
    // 请求期间清掉旧会话的 DOM，避免新会话挂载前沿用旧 scrollTop；请求失败再恢复。
    messages.value = []
    options.clearStatus()
    options.onContentReset()
    try {
      const platformHistory = options.historyAccess && !options.historyAccess.readFirstPage
        ? await readPlatformHistory(options.historyAccess, id, cachedSnapshot?.messages ?? [],
          () => viewGeneration === options.getViewGeneration() && accountEpoch === getAccountBoundaryEpoch())
        : null
      const data = platformHistory?.first ?? await (options.historyAccess?.readFirstPage?.(id)
        ?? agentApi.getMessages(id, { restoreInteractions: true }))
      const pagination = (platformHistory?.overlaps ? cachedSnapshot?.pagination
        : platformHistory ? platformHistory.pagination : data.pagination) ?? {}
      loadingHistory = false
      if (viewGeneration !== options.getViewGeneration() || accountEpoch !== getAccountBoundaryEpoch()) return 'superseded'   // 等待期间又切换/新建了会话，丢弃这次结果
      sessionId.value = id
      options.onHistoryLoaded?.(pagination)
      const loadedSession = sessions.value.find(s => s.id === id)
      // 历史接口同时返回服务端生成快照；用它校准侧栏运行态，避免切回时保留
      // 切走前缓存的 isRunning。缓存只用于合并已加载的历史，不能覆盖服务端终态。
      if (loadedSession && data.active === false) loadedSession.isRunning = false
      if (loadedSession && data.session?.workspaceName !== undefined) loadedSession.workspaceName = data.session.workspaceName
      if (loadedSession && data.session?.goalActive !== undefined) loadedSession.goalActive = Boolean(data.session.goalActive)
      if (loadedSession && data.session?.goalStatus !== undefined) loadedSession.goalStatus = data.session.goalStatus
      options.ownerPlatformUserId.value = data.session?.ownerPlatformUserId ?? null
      options.isGroupSession.value = data.session?.chatType === 'group'
      if (data.active === true) options.setStatus(options.thinkingItem())
      else options.clearStatus()   // 切会话先清掉上个会话残留的状态指示
      // 历史首屏和增量刷新共用同一映射，防止同一持久化消息在不同加载路径获得不同身份键。
      const loadedTimelineMessages = (platformHistory?.pages ?? [data])
        .flatMap(page => mapSessionMessageDelta(page, mkid, options.resolveSpeaker))
      // 按稳定身份合并缓存，同时保留之前加载的旧页。
      const restoredKeys = new Set(loadedTimelineMessages.map(item => item._syncKey))
      const cachedMessages = cachedSnapshot?.messages.filter(item =>
        item.role !== 'interaction' || item.interaction?.resolved || restoredKeys.has(item._syncKey),
      ) ?? []
      messages.value = mergeSessionMessageDelta(
        cachedMessages, loadedTimelineMessages,
      )
      cacheSessionSnapshot(id, messages.value, pagination)
      messageSync.setCursor(id, data.pagination?.newestId)
      options.onContentReset(); options.resetSessionTurn()
      await nextTick()
      if (viewGeneration !== options.getViewGeneration() || accountEpoch !== getAccountBoundaryEpoch()) return 'superseded'
      options.onCaptureBaseScrollH()   // 基线 = 切入会话的历史高度
      // 服务端活跃标记是续接的权威状态。历史中存在助手消息不能证明当前 run 已结束
      // （例如 IM run 或多轮工具过程）；/stream 会按稳定事件 ID 重放，完成后由历史收尾。
      const shouldResume = data.active === true
      // 基线整理是持久状态：刷新或切回会话时 SSE 已结束、没有可续看的流，
      // 从会话行状态恢复「正在整理上下文」提示，否则用户看到的就是静默卡死。
      const compacting = !shouldResume && data.executionState === 'baseline_updating'
      if (compacting) options.setStatus(options.contextCompactingItem())
      // 让历史合并和虚拟列表的位置校准在消息区隐藏时完成。
      await options.restoreScrollPosition(cachedSnapshot?.scrollAnchor ?? null)
      if (viewGeneration !== options.getViewGeneration() || accountEpoch !== getAccountBoundaryEpoch()) return 'superseded'
      options.setSessionSettling(false)
      options.restorePendingQueue(id, Array.isArray(data.pendingQueue) ? data.pendingQueue : [])
      if (shouldResume) {
        await options.resumeStream(id)
      } else if (compacting) {
        pollBaselineDone(id, viewGeneration)
      } else {
        // 刷新前队列可能正好在上一轮结束后尚未排水；没有活跃 SSE 时也要继续接力。
        // 发送错误由 send 自己显示为网络错误；这里避免启动恢复链路产生未处理拒绝。
        void options.drainPendingQueue().catch(() => {})
      }
      if (viewGeneration !== options.getViewGeneration() || accountEpoch !== getAccountBoundaryEpoch()) return 'superseded'
      // 恢复收尾时如果用户已跳到历史消息或主动上滚，不再强制把视图拉回底部。
      if (shouldResume && options.shouldFollowBottom()) await options.scrollBottom()
      return viewGeneration === options.getViewGeneration() ? 'loaded' : 'superseded'
    } catch (error) {
      if (viewGeneration !== options.getViewGeneration() || accountEpoch !== getAccountBoundaryEpoch()) return 'superseded'
      const status = (error as { status?: number } | undefined)?.status
      const unavailable = status === 403 || status === 404
      if (unavailable) sessionSnapshots.delete(id)
      const restoredSnapshot = unavailable ? null : cachedSnapshot
      if (restoredSnapshot) {
        messages.value = [...restoredSnapshot.messages]
        sessionId.value = id
        options.ownerPlatformUserId.value = restoredSnapshot.ownerPlatformUserId
        options.isGroupSession.value = restoredSnapshot.isGroupSession
        options.onHistoryLoaded?.(restoredSnapshot.pagination)
      } else {
        messages.value = previousMessages
        sessionId.value = previousSessionId
        options.ownerPlatformUserId.value = previousOwnerPlatformUserId
        options.isGroupSession.value = previousIsGroupSession
        if (previousSessionId != null) {
          options.onHistoryLoaded?.(sessionSnapshots.get(previousSessionId)?.pagination || {})
        }
      }
      await options.restoreScrollPosition(restoredSnapshot ? restoredSnapshot.scrollAnchor : previousScrollAnchor ?? null)
      if (viewGeneration !== options.getViewGeneration() || accountEpoch !== getAccountBoundaryEpoch()) return 'superseded'
      options.setSessionSettling(false)
      return loadingHistory && unavailable ? 'unavailable' : 'failed'
    }
  }

  async function newSession() {
    if (sessionId.value != null && messages.value.length) {
      cacheSessionSnapshot(
        sessionId.value,
        messages.value,
        options.getHistoryPage?.() || sessionSnapshots.get(sessionId.value)?.pagination || {},
        options.captureScrollAnchor(),
      )
    }
    options.onHistoryReset?.()
    options.bumpViewGeneration()
    options.setSessionSettling(false)
    options.abortCtrl.value?.abort()
    options.streaming.value = false
    options.clearPendingQueue(true)   // 新对话不继承任何会话的待发队列
    sessionId.value = null
    messages.value = []        // 大窗「新对话」是干净起手——不放默认问候（问候只在打开小窗时出现）
    options.clearStatus()      // 旧会话残留的思考/工具状态气泡不属于这个空会话，清掉（loadSession 早就有这步，这里之前漏了）
    options.resetSessionTurn()
    await nextTick()
    options.composerRef.value?.focus()
  }

  async function deleteSession(id: number) {
    try {
      if (options.historyAccess) await options.historyAccess.deleteSession(id)
      else await agentApi.deleteSession(String(id))
      sessionSnapshots.delete(id)
      sessions.value = sessions.value.filter(s => s.id !== id)
      if (sessionId.value === id) {
        await newSession()
        sessionSnapshots.delete(id)
      }
    } catch {}
  }

  async function renameSession(id: number, title: string) {
    const trimmed = title.trim()
    if (!trimmed) return
    const target = sessions.value.find(s => s.id === id)
    if (!target) return
    const prev = target.title
    target.title = trimmed   // 乐观更新：先改本地，输入框/列表立刻显示新标题，不用等接口返回
    try {
      if (options.historyAccess) await options.historyAccess.renameSession(id, trimmed)
      else await agentApi.renameSession(String(id), trimmed)
    } catch {
      target.title = prev   // 失败回滚
    }
  }

  return {
    webSessions, imSessions, currentSessionTitle, currentSessionWorkspaceName, currentSessionGoalActive, currentSessionGoalStatus,
    currentSessionFilesystemAuthorized, currentSessionFilesystemAuthorizationEnabled,
    loadSession, newSession, deleteSession, renameSession, refreshSessionMessages,
  }
}
