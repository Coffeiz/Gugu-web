import { ref, computed, nextTick, onUnmounted, watch, type Ref } from 'vue'
import { CLIENT_ID, agentApi } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import { getGreeting } from '@/composables/useGreeting'
import type { ChatMessage, ChatFile, ChatSession } from '../chatTypes'
import { renderMd } from '../markdown'
import { displayQQFaces } from '../messageDisplay'
import { SESSION_KEY, LAST_SESSION_KEY } from '../chatConstants'
import { useChatStream } from './useChatStream'
import { useChatSessions } from './useChatSessions'
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
 * 对外只暴露窗口尺寸计算需要的三个钩子（onContentReset/onCaptureBaseScrollH/
 * onSyncSmallH），由 GuguChat.vue 组合时接到窗口尺寸那部分状态上。
 */
export function useChatConversation(options: {
  composerRef: Ref<InstanceType<typeof GuguChatComposer> | null>
  messageListRef: Ref<InstanceType<typeof GuguChatMessageList> | null>
  pendingAtt: Ref<ChatFile[]>
  refreshAfterTools: (usedTools: Set<string>) => Promise<void>
  loadQuota: () => void
  playIncomingMessageSfx: () => void
  onContentReset: () => void          // 窗口高度回到 SMALL_H 基线
  onCaptureBaseScrollH: () => void    // 记录当前内容高度为新的增高基线
  onSyncSmallH: () => void            // 按内容真实高度重新计算窗口高
}) {
  const liveStore = useLiveStore()
  const messagesEl = computed(() => options.messageListRef.value?.el ?? null)

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
  const thinkingLabels = ref<string[]>([])   // 「思考中」候选文案（后台「状态命名」_thinking，可多个 | 分隔；空=三个点）
  // 状态气泡贯穿整个生成期：工具/复查/思考只替换同一个气泡的内容，直到真实输出或中断。
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

    // 气泡入场未完成时只保留最新状态，避免工具链里的短状态一闪而过。
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
  const bumpViewGeneration = () => ++_chatViewGeneration

  async function fetchSessions() {
    try { sessions.value = await agentApi.listSessions() } catch {}
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

  function replaceMentionIdsForDisplay(text: string, names: Record<string, string>): string {
    let result = text || ''
    for (const [platformUserId, name] of Object.entries(names)) {
      if (!platformUserId || !name) continue
      const escaped = platformUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      result = result.replace(new RegExp(`<@!?${escaped}>|@${escaped}`, 'g'), () => `@${name}`)
    }
    return result
  }

  // 会话 id 存入 sessionStorage：刷新页面保留当前对话，关闭浏览器/标签页才清空。
  // 同时把「最后一段对话」存进 localStorage（跨浏览器重开仍在）——重开浏览器是否接续上次，
  // 由设置 reopenResume 控制（见侧栏开关）；默认关＝重开开新对话（与历史行为一致）。
  watch(sessionId, (v) => {
    if (v) { sessionStorage.setItem(SESSION_KEY, String(v)); localStorage.setItem(LAST_SESSION_KEY, String(v)) }
    else sessionStorage.removeItem(SESSION_KEY)   // 新对话只清当前标签；localStorage 留最后一段供重开接续
  })

  // 会话内定位到某条历史消息（全局搜索跳转用）：先按 dbId 找到下标，用虚拟列表的
  // scrollToIndex 滚过去（数据本来就在 messages 里，不用管它当前有没有挂 DOM），
  // 等它挂载出来再交给 _flashChatMessage 做高亮。
  async function _revealMessage(dbId: number) {
    const idx = messages.value.findIndex(m => m.dbId === dbId)
    if (idx === -1) return
    stick.value = false   // 跳去的多半是历史消息，不该被当成「回到底部」处理
    options.messageListRef.value?.scrollToIndex(idx, { align: 'center', behavior: 'auto' })
    await nextTick()
  }

  function _flashChatMessage(dbId: number) {
    setTimeout(() => {
      const el = messagesEl.value?.querySelector(`[data-db-id="${dbId}"]`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('msg-search-flash')
      setTimeout(() => el.classList.remove('msg-search-flash'), 1800)
    }, 200)
  }

  // 打开对话框时让默认问候像回复一样「打字机」冒出来（生成版 / 兜底都走这套）。每条问候只播一次。
  let _greetTimer: ReturnType<typeof setInterval> | null = null
  function animateGreeting() {
    const m = messages.value
    if (!(m.length === 1 && m[0]._greeting)) return   // 已有真实对话 → 不动
    const msg = m[0]
    if (msg._greetAnimated) return
    msg._greetAnimated = true
    const full = getGreeting()                        // 此刻取最新（生成好就用生成版，否则兜底）
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
  // 上次（多为程序化）滚动后的 scrollTop，用于判别用户上翻。做成 ref（不是 let）——
  // enterExpanded/exitExpanded（窗口域）在强制滚到底时也要同步这个值，避免被
  // onMsgScroll 误判成用户上翻，需要能从外部直接写。
  const _lastTop = ref(0)

  // streaming 用即时滚动跟随，避免 smooth 叠加追不上。用虚拟列表的 scrollToIndex 而不是
  // 直接写 scrollTop——最后一条消息的高度可能还只是估算值（还没被 measureElement 量过），
  // scrollToIndex 会按当前最新的测量/估算结果算，比直接读 scrollHeight 更准。
  function scrollToBottom(smooth = false) {
    const idx = messages.value.length - 1
    if (idx < 0) return
    options.messageListRef.value?.scrollToIndex(idx, { align: 'end', behavior: smooth ? 'smooth' : 'auto' })
    _lastTop.value = messagesEl.value?.scrollTop ?? 0   // 记录落点：程序化滚动产生的 scroll 事件不会误判为上翻
  }

  // 用户上翻 → 停住；滚回接近底部 → 恢复跟随。messagesEl 是真实可滚动容器，scrollHeight
  // 由虚拟列表的占位高度撑出来，即使视口外的消息没挂 DOM，这个距离判断依然准确。
  function onMsgScroll() {
    const el = messagesEl.value; if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stick.value = dist < 40
    _lastTop.value = el.scrollTop
  }

  // 用户发送时强制即时跳到底（大窗用 smooth 会被随后出现的 thinking 气泡/内容打断，看着没到底）；
  // 再补一帧 rAF，兜住附件缩略图/气泡迟一拍布局导致的高度变化
  async function scrollBottom(force = false) {
    await nextTick()
    const el = messagesEl.value; if (!el) return
    options.onSyncSmallH()   // 发送/加载后按内容真实高度更新窗口高（含刚加的用户气泡）
    if (force) {
      stick.value = true
      scrollToBottom()
      requestAnimationFrame(() => { if (stick.value) scrollToBottom() })
    }
    else if (stick.value) scrollToBottom()
  }

  watch(messagesEl, (el, oldEl) => {
    oldEl?.removeEventListener('scroll', onMsgScroll)
    if (!el) return
    el.addEventListener('scroll', onMsgScroll, { passive: true })
  })

  onUnmounted(() => {
    messagesEl.value?.removeEventListener('scroll', onMsgScroll)
  })

  // ── SSE 收发（send/stopStreaming/resumeStream），见 useChatStream.ts ──
  const streamApi = useChatStream({
    messages, mkid, now, inputText, sessionId, sessions,
    getViewGeneration,
    pendingAtt: options.pendingAtt,
    composerRef: options.composerRef,
    setStatus, clearStatus, thinkingItem: _thinkingItem,
    scrollBottom, fetchSessions,
    refreshAfterTools: options.refreshAfterTools,
    loadQuota: options.loadQuota,
    playIncomingMessageSfx: options.playIncomingMessageSfx,
  })
  const { streaming, abortCtrl, resetSessionTurn, send, stopStreaming, resumeStream } = streamApi

  // ── 会话切换（loadSession/newSession/deleteSession），见 useChatSessions.ts ──
  const sessionsApi = useChatSessions({
    messages, mkid, sessionId, sessions, ownerPlatformUserId, isGroupSession,
    resolveSpeaker, bumpViewGeneration, getViewGeneration,
    composerRef: options.composerRef,
    abortCtrl, streaming, resumeStream, resetSessionTurn,
    clearStatus,
    onContentReset: options.onContentReset,
    onCaptureBaseScrollH: options.onCaptureBaseScrollH,
    scrollBottom,
  })
  const { webSessions, imSessions, currentSessionTitle, loadSession, newSession, deleteSession } = sessionsApi

  // 实时：IM（飞书/QQ）来了新消息 → 刷新会话列表，新会话/新标题即时出现
  watch(() => liveStore.rev.sessions, () => fetchSessions())

  // 消息级实时：若这条 IM 消息属于当前打开的会话，直接把「这一来一回」追加进气泡，
  // 不必整列表/整会话 refetch（只传增量）。非当前会话则上面刷新列表即可。
  // origin === 本标签页时是自己发起这轮对话的回声：token 流已经把气泡画出来了，这里跳过，
  // 只让别的标签页/端补上（同一 client-id 每个标签页独立生成，见 services/api.ts）。
  watch(() => liveStore.sessionEvent, async (e) => {
    if (!e || !e.appended?.length || e.session_id !== sessionId.value) return
    if (e.origin && e.origin === CLIENT_ID) return
    for (const m of e.appended) {
      const isAi = m.role === 'assistant'
      const speaker = resolveSpeaker(m.role || 'user', m.platform_user_id, m.platform_user_name)
      const latestNames: Record<string, string> = {}
      for (const existing of messages.value) {
        if (existing.platformUserId && existing.speakerLabel) {
          latestNames[existing.platformUserId] = existing.speakerLabel
        }
      }
      if (m.platform_user_id && m.platform_user_name) {
        latestNames[m.platform_user_id] = m.platform_user_name
      }
      if (m.platform_bot_user_id) {
        latestNames[m.platform_bot_user_id] = '咕咕'
      }
      messages.value.push({
        id: mkid(),
        role: speaker.role,
        speakerLabel: speaker.speakerLabel,
        platformUserId: m.platform_user_id || null,
        text: displayQQFaces(replaceMentionIdsForDisplay(m.text || '', latestNames)),
        html: isAi ? renderMd(displayQQFaces(replaceMentionIdsForDisplay(m.text || '', latestNames))) : null,
        files: (m.files && m.files.length) ? m.files as ChatFile[] : undefined,
        quotedText: m.quoted_text || undefined,
        time: now(),
      })
    }
    await nextTick(); await scrollBottom()
  })

  return {
    messages, mkid, now,
    inputText, thinkingLabels, streaming, statusKind, statusTyped,
    isTypingText: computed(() => streaming.value && !statusKind.value),
    sessionId, ownerPlatformUserId, isGroupSession,
    sessions, webSessions, imSessions, currentSessionTitle,
    stick, lastTop: _lastTop,
    fetchSessions, loadSession, newSession, deleteSession, resolveSpeaker,
    send, stopStreaming, resumeStream,
    scrollBottom, onMsgScroll,
    animateGreeting, _revealMessage, _flashChatMessage,
    clearStatus,
  }
}
