import type { ChatHttpStreamAccess } from '../chatHttpStream'
import { ref, computed, nextTick, onUnmounted, watch, type Ref } from 'vue'
import { CLIENT_ID, agentApi } from '@/services/api'
import { i18n } from '@/i18n'
import { useLiveStore } from '@/stores/live'
import { accountBoundaryEpoch, getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import { pickGreetingFallback } from '@/utils/greetingText'
import type { ChatMessage, ChatFile, ChatSession, ChatReference, QueuedMessagePayload } from '../chatTypes'
import { renderMd } from '../markdown'
import { SESSION_KEY, LAST_SESSION_KEY } from '../chatConstants'
import { ensureSessionMessageLoaded, findSessionMessageIndex, mapSessionMessageDelta, type ReadHistoryThroughMessage } from './sessionMessageSync'
import { acceptsSidebarRunStatus, type SidebarRunStatus } from './sessionRunStatus'
import { waitForSessionSettlement } from './sessionReadiness'
import { hasPendingMessageMarkdown, type SessionScrollAnchor } from './sessionScrollLayout'
import { getSessionPendingQueueId, setPendingQueueRecoveryNeeded } from './chatPendingQueueStorage'
import { type ChatQueueAccess, type ChatRunAccess, useChatStream } from './useChatStream'
import { useChatSessions, type ChatSessionHistoryAccess } from './useChatSessions'
import { useChatHistoryPagination } from './useChatHistoryPagination'
import type GuguChatComposer from '../GuguChatComposer.vue'
import type GuguChatMessageList from '../GuguChatMessageList.vue'

interface StatusItem { kind: 'text' | 'dots' | 'hide'; label?: string }

/**
 * 对话引擎的编排层：消息数据、状态气泡、滚动跟随、当前会话身份（sessionId/
 * ownerPlatformUserId/isGroupSession/sessions）这几块真正跨切面共享的状态
 * 收在这里；把"切会话"（useChatSessions）和"SSE 收发"（useChatStream）
 * 拆成两个独立文件，各自只关心自己的操作逻辑。
 *
 * 为什么 sessionId/sessions 这类身份状态没有下放给 useChatSessions 独占：
 * useChatStream 收到 session_id/session_title 事件时也要能直接改它们（新对话
 * 落地成真实 id、流式过程中标题被后端生成出来）——这是真正的双向共享，
 * 硬塞进某一侧、靠回调通知另一侧，只会比现在多一层间接。两个 composable
 * 都只拿到引用，谁都不"独占"，编排层负责创建和收尾（live 监听、持久化）。
 *
 */
export interface ChatGreetingAccess {
  prefetch(): Promise<void>
  read(): string
}

export interface ChatConversationAccess extends ChatSessionHistoryAccess {
  run?: ChatRunAccess
  queue: ChatQueueAccess
  listSessions: () => Promise<ChatSession[]>
  readPendingQueue: (queueId: string) => Promise<{ items: QueuedMessagePayload[] }>
  subscribeRunChanges?: (listener: (sessionId?: number, interactionChanged?: true) => void) => () => void
  readRunState: (id: number) => Promise<{ active: boolean; runId?: string }>
}

export function useChatConversation(options: {
  greetingAccess?: ChatGreetingAccess
  deleteDraftAttachment?: (id: string) => Promise<unknown>
  sessionAccess?: ChatConversationAccess
  httpStream?: ChatHttpStreamAccess
  cancelSession?: (id: number) => Promise<{ outcome: string }>
  readHistoryThroughMessage?: ReadHistoryThroughMessage
  composerRef: Ref<InstanceType<typeof GuguChatComposer> | null>
  messageListRef: Ref<InstanceType<typeof GuguChatMessageList> | null>
  pendingAtt: Ref<ChatFile[]>
  refreshAfterTools: (usedTools: Set<string>) => Promise<void>
  loadQuota: () => void
  playIncomingMessageSfx: () => void
  onQueuePersistenceError?: (error: unknown) => void
  onQueueDispatchError?: (error: unknown) => void
  trackMessageSent?: (turn: number) => void
  onAutomaticModeCommand?: () => Promise<void>
  onSyncSmallH: () => void            // 按内容真实高度重新计算窗口高
  onOpenItem?: (item: { kind: 'file' | 'folder'; id: string }) => void
}) {
  const platformAccess = options.sessionAccess?.run ? options.sessionAccess : undefined
  const readRunState = options.sessionAccess?.readRunState ?? (id => agentApi.getSessionState(String(id)))
  const liveStore = useLiveStore()
  const messagesEl = computed(() => options.messageListRef.value?.el ?? null)
  const sessionSettling = ref(false)
  // 所有滚动请求共用一个代次与 rAF。切会话、流式 token、工具事件可能同时请求到底部，
  // 旧请求必须失效，否则它会在新消息布局完成后再次改写 scrollTop。
  let scrollRequest = 0
  let scrollRaf: number | null = null
  function invalidateScrollRequests() {
    scrollRequest += 1
    if (scrollRaf !== null) {
      cancelAnimationFrame(scrollRaf)
      scrollRaf = null
    }
  }

  const now = () => {
    const d = new Date()
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  let _mid = 0
  const mkid = () => ++_mid

  // 默认问候：占位空消息（打开对话框时再以打字机动画显示，文案在那一刻取最新生成版/兜底）
  const messages = ref<ChatMessage[]>([
    { id: mkid(), role: 'ai', text: '', html: '', time: now(), _greeting: true },
  ])

  const inputText = ref('')

  // ── 输入草稿按会话保留：切走时存、切回时还原，localStorage 持久化（刷新/重开浏览器都在）。
  // 引用和正文一同保存，恢复时才能重新构造输入框中的引用卡片。
  // 挂载 watcher 在下方 sessionId 声明之后（见 _watchSessionDrafts）。
  const CHAT_DRAFTS_KEY = 'gugu-chat-drafts'
  const CHAT_DRAFTS_MAX = 30   // 只留最近 30 个会话的草稿，防 localStorage 无限增长
  type ChatDraft = { text: string; references: ChatReference[] }
  function _loadDrafts(): Record<string, string | ChatDraft> {
    try { return JSON.parse(localStorage.getItem(CHAT_DRAFTS_KEY) || '{}') || {} } catch { return {} }
  }
  function _saveDraft(sid: number | null, text: string, references: ChatReference[]) {
    if (!sid) return   // 新对话（无 id）不落盘
    try {
      const drafts = _loadDrafts()
      if (text) drafts[sid] = { text, references }
      else delete drafts[sid]
      const keys = Object.keys(drafts)
      if (keys.length > CHAT_DRAFTS_MAX) {
        for (const k of keys.slice(0, keys.length - CHAT_DRAFTS_MAX)) delete drafts[k]
      }
      localStorage.setItem(CHAT_DRAFTS_KEY, JSON.stringify(drafts))
    } catch { /* 存储不可用（隐私模式/超限）时草稿功能静默降级 */ }
  }

  const inputReferences = ref<ChatReference[]>([])
  const thinkingLabels = ref<string[]>([])   // 「思考中」候选文案（后台「状态命名」_thinking，可多个 | 分隔；空=三个点）
  const contextCompactingLabels = ref<string[]>([]) // 自动压缩状态文案（后台「状态命名」_context_compaction）
  // 生成状态在工具、复查和思考之间更新，直到真实输出或中断。
  const statusKind = ref('')   // '' | 'text'（工具/自定义思考）| 'dots'（默认思考三点）
  const statusTyped = ref('')  // 当前显示的文字（dots 时为空）

  const STATUS_ENTER_MS = 300
  let statusShownAt = 0
  let statusSwitchTimer: ReturnType<typeof setTimeout> | null = null
  let pendingStatus: StatusItem | null = null

  function _thinkingItem(): StatusItem {
    // 「思考中」：设了自定义文案就随机取一条；否则三个点。
    const c = thinkingLabels.value
    return c.length ? { kind: 'text', label: c[Math.floor(Math.random() * c.length)] } : { kind: 'dots' }
  }

  function _contextCompactingItem(): StatusItem {
    const c = contextCompactingLabels.value
    return { kind: 'text', label: c.length ? c[Math.floor(Math.random() * c.length)] : i18n.global.t('chatUi.contextCompacting') }
  }

  function cancelPendingStatus() {
    if (statusSwitchTimer) clearTimeout(statusSwitchTimer)
    statusSwitchTimer = null
    pendingStatus = null
  }

  function applyStatus(item: StatusItem) {
    statusKind.value = item.kind
    statusTyped.value = item.kind === 'text' ? (item.label || '') : ''
    statusShownAt = performance.now()
    scrollBottom()
  }

  function clearStatus() {       // 仅在回复开始、生成结束或中断时收起
    cancelPendingStatus()
    statusShownAt = 0
    statusKind.value = ''; statusTyped.value = ''
  }

  function setStatus(item: StatusItem) {
    if (item.kind === 'hide') { clearStatus(); return }
    const label = item.kind === 'text' ? (item.label || '') : ''
    if (statusKind.value === item.kind && statusTyped.value === label) return

    const remaining = STATUS_ENTER_MS - (performance.now() - statusShownAt)
    if (!statusKind.value || remaining <= 0) {
      cancelPendingStatus()
      applyStatus(item)
      return
    }

    // 状态刚显示时只保留最新状态，避免工具链里的短状态一闪而过。
    pendingStatus = item
    if (!statusSwitchTimer) {
      statusSwitchTimer = setTimeout(() => {
        statusSwitchTimer = null
        const nextStatus = pendingStatus
        pendingStatus = null
        if (nextStatus) applyStatus(nextStatus)
      }, remaining)
    }
  }

  onUnmounted(cancelPendingStatus)

  // ── 当前会话身份：sessionId/sessions/ownerPlatformUserId/isGroupSession 由
  // useChatStream 和 useChatSessions 共同读写（见文件头注释），在这里创建一次，
  // 两边都只拿引用。viewGeneration 同理——只有 useChatSessions 会递增
  // （切会话/新建才算"换视图"），useChatStream 只读它判断"这条流还有效吗"。
  const sessionId = ref<number | null>(null)
  const sessions = ref<ChatSession[]>([])
  const ownerPlatformUserId = ref<string | null>(null)
  const isGroupSession = ref(false)
  let _chatViewGeneration = 0
  const getViewGeneration = () => _chatViewGeneration
  const bumpViewGeneration = () => {
    invalidateScrollRequests()
    return ++_chatViewGeneration
  }

  const sidebarRuns = new Map<number, SidebarRunStatus>()
  watch(accountBoundaryEpoch, () => sidebarRuns.clear(), { flush: 'sync' })
  let sessionsFetchVersion = 0

  function updateSidebarRun(id: number, runId: string | undefined, running: boolean, fromUserEvents = false) {
    if (!runId) return
    const previous = sidebarRuns.get(id)
    const next = { runId, running }
    if (!acceptsSidebarRunStatus(previous, next, fromUserEvents)) return
    const session = sessions.value.find(item => item.id === id)
    if (previous?.runId === runId && previous.running === running && session?.isRunning === running) return
    sidebarRuns.set(id, next)
    if (session) session.isRunning = running
    // 丢弃在本次状态事件之前启动的列表请求。
    sessionsFetchVersion++
    sessionsLoading.value = false
  }
  const sessionsLoading = ref(false)
  const sessionsLoadFailed = ref(false)
  async function fetchSessions() {
    const version = ++sessionsFetchVersion
    const epoch = getAccountBoundaryEpoch()
    sessionsLoading.value = true
    sessionsLoadFailed.value = false
    const isCurrent = () => version === sessionsFetchVersion && epoch === getAccountBoundaryEpoch()
    try {
      const result = await (options.sessionAccess?.listSessions ?? agentApi.listSessions)()
      if (isCurrent()) sessions.value = result
    } catch {
      if (isCurrent()) sessionsLoadFailed.value = true
    } finally {
      if (isCurrent()) sessionsLoading.value = false
    }
  }
  // role/platformUserId → 气泡归属 + 群成员发言人标注。三态：
  // - 'ai'：assistant，左侧，不比对
  // - 'user'：owner 自己发的，右侧，不署名
  // - 'member'：群里其他成员（platformUserId 存在但跟 owner 对不上），左侧，署 speakerLabel。
  // 单独开一个 role 值而不是复用 'user'，是因为全文件所有 role 判断都只认 'ai'/非 'ai'
  // 两态（没有任何地方显式判断 === 'user'），加第三态不会破坏既有逻辑，但如果借用
  // 'user' 表达"群成员"，气泡会被现有 CSS 判到右侧去，跟需求正好相反。
  //
  // 只有真正的群聊会话才去比对 platformUserId === ownerPlatformUserId——owner 绑定
  // 目前只有 QQ 走了验证码流程，微信/飞书的 ownerPlatformUserId 恒为 null，但它们的
  // IM 消息一样带 platformUserId（不分群聊私聊），如果不看 isGroupSession 直接比对，
  // 微信/飞书自己的私聊消息会因为「真实 id !== null」被误判成群成员、错落左侧。
  // 私聊/网页对话没有"群里其他人"这个概念，直接按 owner 处理。
  function resolveSpeaker(
    role: string,
    platformUserId: string | null | undefined,
    platformUserName: string | null | undefined,
  ): { role: string; speakerLabel?: string } {
    if (role === 'assistant') return { role: 'ai' }
    if (!isGroupSession.value || !platformUserId || platformUserId === ownerPlatformUserId.value) return { role: 'user' }
    return { role: 'member', speakerLabel: platformUserName || platformUserId }
  }

  // 会话 id 存入 sessionStorage：刷新页面保留当前对话，关闭浏览器/标签页才清空。
  // 同时把「最后一段对话」存进 localStorage（跨浏览器重开仍在）——重开浏览器是否接续上次，
  // 由设置 reopenResume 控制（见侧栏开关）；默认关＝重开开新对话（与历史行为一致）。
  watch(sessionId, (v) => {
    if (v) { sessionStorage.setItem(SESSION_KEY, String(v)); localStorage.setItem(LAST_SESSION_KEY, String(v)) }
    else sessionStorage.removeItem(SESSION_KEY)   // 新对话只清当前标签；localStorage 留最后一段供重开接续
  })

  // 会话切换时的草稿存/取（helper 定义在 inputText 旁；这里才拿得到已初始化的 sessionId）。
  // 只处理「真正的 load/switch」；新对话首条消息的 SSE session_id 落地走
  // bindNewSessionId（下方），不能在这里用 null → id 推断——刷新恢复、侧栏点击
  // 已有会话同样是 null → id，但那两种需要恢复目标会话的草稿，语义相反。
  watch(sessionId, (nv, ov) => {
    if (_draftTimer) clearTimeout(_draftTimer)
    _saveDraft(ov, inputText.value, inputReferences.value)
    const draft = nv ? _loadDrafts()[String(nv)] : undefined
    inputReferences.value = typeof draft === 'object' && Array.isArray(draft.references) ? draft.references : []
    inputText.value = typeof draft === 'string' ? draft : draft?.text ?? ''
  }, { flush: 'sync' })
  // 新对话首条消息：SSE session_id 事件把会话身份落到真实 id。这是同一会话的
  // 指针落地而不是切换——先把当前输入（用户正打的字/刚排队的消息）记到新 id
  // 名下再赋值；随后触发的切换 watcher 按新 id 还原出同一份文本，输入框不动。
  function bindNewSessionId(id: number) {
    _saveDraft(id, inputText.value, inputReferences.value)
    sessionId.value = id
  }
  // 输入即存（防抖）：只靠切换时存会有脏条目——发送/清空后草稿表里还是旧文，
  // 重开浏览器接续同一会话时会把已发出的内容当草稿复活。
  let _draftTimer: ReturnType<typeof setTimeout> | null = null
  watch([inputText, inputReferences], () => {
    if (_draftTimer) clearTimeout(_draftTimer)
    _draftTimer = setTimeout(() => _saveDraft(sessionId.value, inputText.value, inputReferences.value), 300)
  })
  onUnmounted(() => {
    if (_draftTimer) clearTimeout(_draftTimer)
    _saveDraft(sessionId.value, inputText.value, inputReferences.value)
  })

  // 会话内定位到某条历史消息（全局搜索跳转用）：先按 dbId 找到下标，用虚拟列表的
  // scrollToIndex 滚过去（数据本来就在 messages 里，不用管它当前有没有挂 DOM），
  // 等它挂载出来再交给 _flashChatMessage 做高亮。
  async function _revealMessage(dbId: number) {
    let idx = findSessionMessageIndex(messages.value, dbId)
    if (idx === -1 && sessionId.value != null) {
      const sessionIdAtRequest = sessionId.value
      const generationAtRequest = getViewGeneration()
      try {
        await ensureSessionMessageLoaded({
          sessionId: sessionIdAtRequest,
          messageId: dbId,
          readHistoryThroughMessage: options.readHistoryThroughMessage,
          messages,
          mkid,
          resolveSpeaker,
          isCurrent: () => sessionId.value === sessionIdAtRequest && getViewGeneration() === generationAtRequest,
          onHistoryPage: page => {
            const { oldestId } = historyPagination.currentPage()
            if (page.oldestId !== null && (oldestId === null || page.oldestId <= oldestId))
              historyPagination.reset(page)
          },
        })
      } catch {
        return false
      }
      idx = findSessionMessageIndex(messages.value, dbId)
    }
    if (idx === -1 || !options.messageListRef.value) return false
    stick.value = false   // 跳去的多半是历史消息，不该被当成「回到底部」处理
    options.messageListRef.value.scrollToIndex(idx, { align: 'center', behavior: 'auto' })
    await nextTick()
    return true
  }

  let flashRequest = 0
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let activeFlashElement: HTMLElement | null = null

  function clearFlash() {
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = null
    activeFlashElement?.classList.remove('search-highlight')
    activeFlashElement = null
  }

  function _flashChatMessage(dbId: number) {
    const request = ++flashRequest
    clearFlash()
    let attempts = 0
    const findElement = () => {
      if (request !== flashRequest) return
      const target = messages.value[findSessionMessageIndex(messages.value, dbId)]
      const message = target && messagesEl.value?.querySelector<HTMLElement>(`[data-message-id="${target.id}"]`)
      const bubble = message?.querySelector<HTMLElement>('.msg-bubble, .tool-activity')
      if (!message || !bubble) {
        if (attempts++ >= 30) return
        flashTimer = setTimeout(findElement, 50)
        return
      }
      message.scrollIntoView({ behavior: 'smooth', block: 'center' })
      bubble.classList.add('search-highlight')
      activeFlashElement = bubble
      flashTimer = setTimeout(() => {
        if (request !== flashRequest) return
        bubble.classList.remove('search-highlight')
        activeFlashElement = null
        flashTimer = null
      }, 1800)
    }
    flashTimer = setTimeout(findElement, 50)
  }

  // 打开对话框时让默认问候像回复一样「打字机」冒出来（生成版 / 兜底都走这套）。每条问候只播一次。
  let _greetTimer: ReturnType<typeof setInterval> | null = null
  onUnmounted(() => { if (_greetTimer) clearInterval(_greetTimer) })
  async function animateGreeting(isVisible: () => boolean) {
    const m = messages.value
    if (!(m.length === 1 && m[0]._greeting)) return   // 已有真实对话 → 不动
    const msg = m[0]
    if (msg._greetAnimated) return
    await options.greetingAccess?.prefetch()
    if (!isVisible() || messages.value.length !== 1 || messages.value[0] !== msg || msg._greetAnimated) return
    const full = options.greetingAccess?.read() ?? pickGreetingFallback()
    if (!full) {
      messages.value = []
      return
    }
    msg._greetAnimated = true
    msg._greetFull = full                             // 记下定稿文案：用户回复时随首条消息把它入库（见 send）
    msg.text = ''; msg.html = ''; msg.streaming = true
    let i = 0
    if (_greetTimer) clearInterval(_greetTimer)
    _greetTimer = setInterval(() => {
      msg.text = full.slice(0, ++i)
      if (i >= full.length) { if (_greetTimer) clearInterval(_greetTimer); _greetTimer = null; msg.streaming = false; msg.html = renderMd(full) }
    }, 22)
  }

  // streaming 跟随意图：只有用户主动上翻才取消，回到底部附近恢复。
  const stick = ref(true)
  const historyPagination = useChatHistoryPagination({
    messages, sessionId, settling: sessionSettling, mkid, resolveSpeaker, getViewGeneration,
    loadPage: async (session, cursor) => {
      const data = options.sessionAccess
        ? await options.sessionAccess.readHistory(session, cursor)
        : await agentApi.getMessages(session, { beforeId: cursor, limit: 50 })
      return { pagination: data.pagination, messages: mapSessionMessageDelta(data, mkid, resolveSpeaker) }
    },
    beforeMerge: () => { stick.value = false; invalidateScrollRequests() },
  })

  // 工具消息可以合并进前面的活动行，跟随滚动以最后一条展示行为准。
  function scrollToBottom() {
    options.messageListRef.value?.scrollToBottom()
  }

  // 用户上翻 → 停住；滚回接近底部 → 恢复跟随。messagesEl 是真实可滚动容器，scrollHeight
  // 由虚拟列表的占位高度撑出来，即使视口外的消息没挂 DOM，这个距离判断依然准确。
  function onMsgScroll() {
    const el = messagesEl.value; if (!el) return
    // 切换期间的布局纠偏不是用户上翻，也不能触发旧页预取。
    if (sessionSettling.value) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stick.value = dist < 40
    // 跟随虚拟列表的实际范围预取：首个挂载行进入 overscan 区时开始取上一页，
    // 给网络和长消息布局留出缓冲，避免滚到最顶端才发请求。
    if ((options.messageListRef.value?.getVirtualRangeStart() ?? 0) <= 10) {
      void historyPagination.loadOlder()
    }
  }

  // 用户发送时强制即时跳到底（大窗用 smooth 会被随后出现的 thinking 气泡/内容打断，看着没到底）；
  // 再补一帧 rAF，兜住附件缩略图/气泡迟一拍布局导致的高度变化
  async function scrollBottom(force = false) {
    const request = ++scrollRequest
    if (scrollRaf !== null) {
      cancelAnimationFrame(scrollRaf)
      scrollRaf = null
    }
    await nextTick()
    if (request !== scrollRequest) return
    const el = messagesEl.value; if (!el) return
    options.onSyncSmallH()   // 发送/加载后按内容真实高度更新窗口高（含刚加的用户气泡）
    if (force) {
      stick.value = true
      scrollToBottom()
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null
        if (request !== scrollRequest) return
        if (stick.value) scrollToBottom()
      })
    }
    else if (stick.value) scrollToBottom()
  }

  // 虚拟列表在切换会话后会先用估算高度绘制，再在可见行挂载后逐帧修正高度。
  // 先在隐藏状态恢复阅读锚点或底部，等测量完成再展示。
  async function restoreScrollPosition(anchor: SessionScrollAnchor | null, waitForLayout = true) {
    const generation = getViewGeneration()
    await nextTick()
    if (generation !== getViewGeneration()) return
    const list = options.messageListRef.value
    const anchorIndex = anchor ? messages.value.findIndex(message => message._syncKey === anchor.messageKey) : -1
    if (anchor && anchorIndex >= 0) {
      stick.value = false
      options.onSyncSmallH()
      list?.restoreScrollAnchor(anchorIndex, anchor.offset)
    } else {
      await scrollBottom(true)
    }
    if (generation !== getViewGeneration()) return
    if (waitForLayout) await waitForStableScrollLayout(anchor, anchorIndex)
  }

  async function alignNewWindowToBottom() {
    // 会话正在加载时，由加载流程负责最后一次定位。
    if (sessionSettling.value) return
    const generation = getViewGeneration()
    sessionSettling.value = true
    try {
      await nextTick()
      if (generation !== getViewGeneration()) return
      await restoreScrollPosition(null)
    } finally {
      if (generation === getViewGeneration()) sessionSettling.value = false
    }
  }

  async function waitForStableScrollLayout(anchor: SessionScrollAnchor | null = null, anchorIndex = -1) {
    const generation = getViewGeneration()
    const list = options.messageListRef.value
    let previous = ''
    let stableFrames = 0
    // 首次打开会话时，当前虚拟窗口内的 MarkdownView 会异步解析 Mermaid。
    // 这段时间列表仍隐藏；等 SVG 完成及虚拟行高度稳定后再展示，避免可见状态下滚动纠偏。
    for (let i = 0; i < 180; i += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      await nextTick()
      if (generation !== getViewGeneration() || !sessionSettling.value) return
      const el = messagesEl.value
      if (!el || !el.clientHeight) return
      const needsCorrection = anchor && anchorIndex >= 0
        ? list?.restoreScrollAnchor(anchorIndex, anchor.offset)
        : el.scrollHeight - el.scrollTop - el.clientHeight > 2
      if (needsCorrection) {
        if (anchorIndex < 0) scrollToBottom()
        previous = ''
        stableFrames = 0
        continue
      }
      const current = `${el.scrollHeight}:${el.clientHeight}:${el.scrollTop}`
      const markdownPending = hasPendingMessageMarkdown(el)
      if (!markdownPending && current && current === previous) {
        stableFrames += 1
        if (stableFrames >= 2) return
      } else {
        stableFrames = 0
        previous = current
      }
    }
  }

  watch(messagesEl, (el, oldEl) => {
    oldEl?.removeEventListener('scroll', onMsgScroll)
    if (!el) return
    el.addEventListener('scroll', onMsgScroll, { passive: true })
  })

  onUnmounted(() => {
    messagesEl.value?.removeEventListener('scroll', onMsgScroll)
    flashRequest++
    clearFlash()
  })

  // ── SSE 收发（send/stopStreaming/resumeStream），见 useChatStream.ts ──
  const streamApi = useChatStream({
    deleteDraftAttachment: options.deleteDraftAttachment,
    httpStream: options.httpStream,
    cancelSession: options.cancelSession,
    runAccess: options.sessionAccess?.run,
    queueAccess: options.sessionAccess?.queue,
    messages, mkid, now, inputText, inputReferences, sessionId, sessions,
    getViewGeneration, bindNewSessionId,
    pendingAtt: options.pendingAtt,
    composerRef: options.composerRef,
    setStatus, clearStatus, thinkingItem: _thinkingItem, contextCompactingItem: _contextCompactingItem,
    scrollBottom, fetchSessions, updateSidebarRun,
    syncResumedHistory: (id) => sessionsApi.refreshSessionMessages(id),
    refreshAfterTools: options.refreshAfterTools,
    loadQuota: options.loadQuota,
    playIncomingMessageSfx: options.playIncomingMessageSfx,
    onQueuePersistenceError: options.onQueuePersistenceError,
    onQueueDispatchError: options.onQueueDispatchError,
    trackMessageSent: options.trackMessageSent,
    onAutomaticModeCommand: options.onAutomaticModeCommand,
    onOpenItem: options.onOpenItem,
  })
  const {
    streaming, abortCtrl, pendingQueue, removeQueued, resetSessionTurn, clearPendingQueue,
    restorePendingQueueForSession, restorePendingQueueForDraft, drainPendingQueue,
    waitForPendingQueueWrites,
    send, stopStreaming, resumeStream,
  } = streamApi

  // ── 会话切换（loadSession/newSession/deleteSession），见 useChatSessions.ts ──
  const sessionsApi = useChatSessions({
    historyAccess: options.sessionAccess,
    messages, mkid, sessionId, sessions, ownerPlatformUserId, isGroupSession,
    resolveSpeaker, bumpViewGeneration, getViewGeneration,
    composerRef: options.composerRef,
    abortCtrl, streaming, resumeStream, resetSessionTurn, clearPendingQueue,
    restorePendingQueue: restorePendingQueueForSession,
    drainPendingQueue,
    clearStatus, setStatus, thinkingItem: _thinkingItem, contextCompactingItem: _contextCompactingItem,
    scrollBottom,
    captureScrollAnchor: () => sessionSettling.value ? undefined : options.messageListRef.value?.captureScrollAnchor(),
    restoreScrollPosition,
    waitForSessionSettlement: (id) => waitForSessionSettlement(sessionId, sessionSettling, id),
    shouldFollowBottom: () => stick.value,
    setSessionSettling: (value: boolean) => { sessionSettling.value = value },
    onHistoryReset: () => historyPagination.reset(),
    onHistoryLoaded: page => historyPagination.reset(page),
    getHistoryPage: historyPagination.currentPage,
  })
  const { webSessions, imSessions, currentSessionTitle, currentSessionWorkspaceName, currentSessionGoalActive, currentSessionGoalStatus, currentSessionFilesystemAuthorized, currentSessionFilesystemAuthorizationEnabled, loadSession, newSession, deleteSession, renameSession, refreshSessionMessages } = sessionsApi

  // 队列正文仍以服务端为准：跨浏览器通过用户级 SSE 通知后读取一次快照；
  // 断线重连时也补读当前会话，避免错过 Pub/Sub 不回放的事件。
  let pendingQueueRefreshPromise: Promise<void> | null = null
  let pendingQueueRefreshRequested = false
  function refreshSessionPendingQueue(): Promise<void> {
    if (sessionId.value == null) return Promise.resolve()
    pendingQueueRefreshRequested = true
    if (pendingQueueRefreshPromise) return pendingQueueRefreshPromise

    pendingQueueRefreshPromise = (async () => {
      while (pendingQueueRefreshRequested) {
        pendingQueueRefreshRequested = false
        const id = sessionId.value
        if (id == null) continue
        try {
          await waitForPendingQueueWrites()
          const snapshot = options.sessionAccess
            ? await options.sessionAccess.readPendingQueue(getSessionPendingQueueId(id))
            : await agentApi.getPendingQueue(getSessionPendingQueueId(id))
          if (sessionId.value !== id) continue
          restorePendingQueueForSession(id, snapshot.items)
          setPendingQueueRecoveryNeeded(snapshot.items.length > 0 || pendingQueue.value.length > 0)
          if (snapshot.items.length && !streaming.value) void drainPendingQueue().catch(() => {})
        } catch {
          // SSE 重连或下一次队列变更会再次校准；不以定时请求掩盖暂时性失败。
        }
      }
    })().finally(() => {
      pendingQueueRefreshPromise = null
      if (pendingQueueRefreshRequested) void refreshSessionPendingQueue()
    })
    return pendingQueueRefreshPromise
  }

  watch(() => liveStore.connected, (connected) => {
    if (connected && !platformAccess) {
      void refreshSessionPendingQueue()
      if (sessionId.value != null && !sessionSettling.value) {
        const activeSessionId = sessionId.value
        void refreshSessionMessages(activeSessionId).then(async () => {
          const state = await readRunState(activeSessionId)
          if (state.active && sessionId.value === activeSessionId && !streaming.value)
            void resumeStream(activeSessionId)
        }).catch(() => {})
      }
    }
  }, { immediate: true })

  watch(() => liveStore.resourceEvent, (event) => {
    if (
      platformAccess
      || !event
      || event.resource !== 'pending_queues'
      || sessionId.value == null
      || String(event.entity_id) !== String(sessionId.value)
      || event.origin === CLIENT_ID
    ) return
    void refreshSessionPendingQueue()
  })

  // 实时：会话变更刷新列表。消息正文由带 origin 的事件处理器增量补取；重连补取由
  // connected watcher 执行，避免本标签页自己的乐观消息被 rev 触发重复补回。
  watch(() => liveStore.rev.sessions, () => {
    if (!platformAccess) void fetchSessions()
  })

  let deferredRunSession: number | null = null
  watch(() => liveStore.agentRunEvent, (event) => {
    if (platformAccess || !event) return
    if (event.status === 'waiting') {
      if (sessionId.value === event.session_id) void refreshSessionMessages(event.session_id, true)
      return
    }
    updateSidebarRun(event.session_id, event.run_id, event.status === 'running', true)
    void fetchSessions()
    if (event.status === 'completed' || event.status === 'failed') {
      if (sessionId.value !== event.session_id) return
      if (sessionSettling.value || streaming.value) deferredSessionRefresh.add(event.session_id)
      else {
        void refreshSessionMessages(event.session_id)
        // 终态也可能来自后台运行。即使页面没有订阅该流，也要校准队列并继续发送。
        void refreshSessionPendingQueue()
      }
      return
    }
    if (event.status !== 'running') return
    // IM 首条消息会先在服务端创建并提交 session，再发布 run=running；列表刷新不应
    // 等待助手回复后的 sessions 事件，否则新 IM 会话在生成期间或回复失败时不可见。
    if (sessionId.value !== event.session_id) return
    if (streaming.value || sessionSettling.value) {
      deferredRunSession = event.session_id
      return
    }
    // IM run 开始时通过用户级 live 事件通知；只续接当前正在看的会话。
    void resumeStream(event.session_id, event.run_id)
  })

  const deferredSessionRefresh = new Set<number>()
  let deferredPlatformRefresh: { id: number; generation: number } | undefined
  watch([sessionSettling, streaming], ([settling, active]) => {
    if (settling || active || sessionId.value == null) return
    const id = sessionId.value
    if (deferredRunSession === id) {
      deferredRunSession = null
      void readRunState(id).then(result => {
        if (result.active && sessionId.value === id && !streaming.value && !sessionSettling.value) void resumeStream(id)
      }).catch(() => {})
    }
    const platform = deferredPlatformRefresh
    deferredPlatformRefresh = undefined
    if (platform?.id === id && platform.generation === getViewGeneration()) {
      platformChanges.add(id)
      schedulePlatformRefresh()
    }
    if (deferredSessionRefresh.delete(id)) {
      void refreshSessionMessages(id)
      void refreshSessionPendingQueue()
    }
  })

  // 平台事件只提示数据变化，由持久会话状态决定是否续接。
  const platformChanges = new Set<number>()
  let platformRefresh: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  function schedulePlatformRefresh() {
    if (disposed || platformRefresh !== undefined) return
    platformRefresh = setTimeout(async () => {
      const id = sessionId.value
      const generation = getViewGeneration()
      const isCurrent = () => !disposed && id === sessionId.value && generation === getViewGeneration()
      const refreshCurrent = id != null && platformChanges.has(id)
      platformChanges.clear()
      try {
        await fetchSessions()
        if (!refreshCurrent || !platformAccess || !isCurrent()) return
        if (sessionSettling.value || streaming.value) {
          deferredPlatformRefresh = { id, generation }
          return
        }
        const state = await platformAccess.readRunState(id)
        if (!isCurrent()) return
        if (sessionSettling.value || streaming.value) deferredPlatformRefresh = { id, generation }
        else if (state.active) void resumeStream(id, state.runId)
        else await Promise.all([refreshSessionMessages(id), refreshSessionPendingQueue()])
      } catch {
        // 会话切换或下一条状态事件重新读取。
      } finally {
        platformRefresh = undefined
        if (platformChanges.size) schedulePlatformRefresh()
      }
    }, 160)
  }
  const unsubscribePlatform = platformAccess?.subscribeRunChanges?.((id, interactionChanged) => {
    if (interactionChanged && id != null && id === sessionId.value) void refreshSessionMessages(id, true)
    const current = id ?? sessionId.value
    if (current != null) platformChanges.add(current)
    if (id === undefined) void refreshSessionPendingQueue()
    schedulePlatformRefresh()
  })
  const reconcileVisibleSessions = () => {
    if (document.visibilityState !== 'visible') return
    if (!platformAccess) {
      void fetchSessions()
      return
    }
    const id = sessionId.value
    if (id != null) {
      platformChanges.add(id)
      void refreshSessionPendingQueue()
    }
    schedulePlatformRefresh()
  }
  document.addEventListener('visibilitychange', reconcileVisibleSessions)
  onUnmounted(() => {
    disposed = true
    document.removeEventListener('visibilitychange', reconcileVisibleSessions)
    unsubscribePlatform?.()
    if (platformRefresh !== undefined) clearTimeout(platformRefresh)
  })

  // 跨端事件只作为失效通知；正文从数据库按 after_id 拉取，避免漏回放和重复追加。
  watch(() => liveStore.resourceEvent, (event) => {
    if (platformAccess || !event || event.resource !== 'sessions') return
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, any> : {}
    const e = { ...payload, session_id: event.entity_id, origin: event.origin } as any
    const matchesCurrentSession = sessionId.value != null && String(event.entity_id) === String(sessionId.value)
    if (matchesCurrentSession && e.message_update && typeof e.message_update === 'object') {
      const update = e.message_update as { message_id?: number; files?: ChatFile[] }
      const target = messages.value.find(message => message.dbId === Number(update.message_id))
      if (target && Array.isArray(update.files)) target.files = update.files
    }
    const appendedCount = Array.isArray(e.appended) ? e.appended.length : 0
    const isOwnOrigin = Boolean(e.origin && e.origin === CLIENT_ID)
    if (!matchesCurrentSession) return
    const session = sessions.value.find(item => item.id === Number(e.session_id))
    if (session && e.title) session.title = e.title
    if ((!appendedCount && e.messages_changed !== true) || isOwnOrigin) return
    if (sessionSettling.value) {
      deferredSessionRefresh.add(Number(e.session_id))
      return
    }
    void refreshSessionMessages(Number(e.session_id))
  })

  return {
    messages, mkid, now, sessionSettling,
    historyState: historyPagination.state, loadOlderHistory: () => historyPagination.loadOlder(true),
    inputText, inputReferences, thinkingLabels, contextCompactingLabels, streaming, statusKind, statusTyped,
    isTypingText: computed(() => streaming.value && !statusKind.value),
    sessionId, ownerPlatformUserId, isGroupSession, getViewGeneration,
    sessions, sessionsLoading, sessionsLoadFailed, webSessions, imSessions, currentSessionTitle, currentSessionWorkspaceName, currentSessionGoalActive, currentSessionGoalStatus,
    currentSessionFilesystemAuthorized, currentSessionFilesystemAuthorizationEnabled,
    stick,
    fetchSessions, loadSession, newSession, deleteSession, renameSession, resolveSpeaker,
    send, stopStreaming, resumeStream,
    pendingQueue, removeQueued, restorePendingQueueForDraft,
    restorePendingQueueForSession, drainPendingQueue,
    waitForPendingQueueWrites,
    waitForSessionSettlement: (id: number) => waitForSessionSettlement(sessionId, sessionSettling, id),
    waitForStableScrollLayout,
    scrollBottom, alignNewWindowToBottom, onMsgScroll,
    animateGreeting, _revealMessage, _flashChatMessage,
    clearStatus,
  }
}
