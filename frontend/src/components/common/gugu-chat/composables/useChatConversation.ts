import { ref, computed, nextTick, onUnmounted, watch, type Ref } from 'vue'
import { agentApi, trackApi, CLIENT_ID } from '@/services/api'
import { useLiveStore } from '@/stores/live'
import { getGreeting } from '@/composables/useGreeting'
import { playGuguSfx } from '@/services/sfx'
import type { ChatMessage, ChatFile, ChatSession } from '../chatTypes'
import { renderMd } from '../markdown'
import { displayQQFaces } from '../messageDisplay'
import { API_BASE } from '../chatConstants'
import { FILE_TOOLS, PROJECT_TOOLS, CALENDAR_TOOLS } from './useChatActions'
import type GuguChatComposer from '../GuguChatComposer.vue'
import type GuguChatMessageList from '../GuguChatMessageList.vue'

interface RawSessionMessage {
  id: number
  role: string
  content: string
  files?: ChatFile[]
  quotedText?: string
  platformUserId?: string | null
  platformUserName?: string | null
  createdAt: string
}

interface StatusItem { kind: 'text' | 'dots' | 'hide'; label?: string }

/**
 * 对话引擎的唯一状态所有权：消息数据、会话列表与切换、流式收发（SSE 消费）、
 * 状态气泡状态机、滚动跟随。这是全组件耦合最深的一块——发送/续看/切会话/
 * 滚动/窗口高度互相牵扯，硬拆成 doc 里设想的多个更细粒度 composable 反而会
 * 制造出一堆双向回调，不如作为一个内聚单元收在一起，对外只暴露窗口尺寸计算
 * 需要的三个钩子（onContentReset/onCaptureBaseScrollH/onSyncSmallH），由
 * GuguChat.vue 组合时接到窗口尺寸那部分状态上。
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
  const streaming = ref(false)
  // 状态气泡贯穿整个生成期：工具/复查/思考只替换同一个气泡的内容，直到真实输出或中断。
  const statusKind = ref('')   // '' | 'text'（工具/自定义思考）| 'dots'（默认思考三点）
  const statusTyped = ref('')  // 当前显示的文字（dots 时为空）
  const isTypingText = computed(() => streaming.value && !statusKind.value)

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

  const sessionId = ref<number | null>(null)
  // 视图代次：切换/新建会话时立即递增，让尚未完成的旧 SSE 流失去写入当前消息列表的资格。
  let _chatViewGeneration = 0
  // 当前会话所属渠道里「owner」的平台身份（仅群聊/IM 用得上）：消息的
  // platformUserId 等于它才归到右侧气泡，否则是群里其他成员，归左侧并标 username。
  const ownerPlatformUserId = ref<string | null>(null)
  // 当前会话是不是群聊——只有群聊才需要在左侧气泡上方标"咕咕"/群成员 username，
  // 1:1 对话左侧默认就是咕咕，不用额外标注，保持原有视觉不变。
  const isGroupSession = ref(false)
  const abortCtrl = ref<AbortController | null>(null)
  const pendingQueue = ref<string[]>([])   // 生成中发的消息，排队等流式结束后接着发

  let _sessionTurn = 0             // 当前 session 已发消息轮次（埋点用，切换 session 重置）

  // 会话 id 存入 sessionStorage：刷新页面保留当前对话，关闭浏览器/标签页才清空。
  // 同时把「最后一段对话」存进 localStorage（跨浏览器重开仍在）——重开浏览器是否接续上次，
  // 由设置 reopenResume 控制（见侧栏开关）；默认关＝重开开新对话（与历史行为一致）。
  const SESSION_KEY = 'gugu_session_id'            // sessionStorage：本标签刷新保留
  const LAST_SESSION_KEY = 'gugu_last_session_id'  // localStorage：最近一段对话（跨浏览器重开可接续）
  watch(sessionId, (v) => {
    if (v) { sessionStorage.setItem(SESSION_KEY, String(v)); localStorage.setItem(LAST_SESSION_KEY, String(v)) }
    else sessionStorage.removeItem(SESSION_KEY)   // 新对话只清当前标签；localStorage 留最后一段供重开接续
  })

  function stopStreaming() {
    pendingQueue.value = []   // 停止=放弃排队中的消息
    abortCtrl.value?.abort()
  }

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

  const sessions = ref<ChatSession[]>([])
  const webSessions = computed(() => sessions.value.filter(s => !s.source || s.source === 'web'))
  const imSessions = computed(() => sessions.value.filter(s => s.source && s.source !== 'web'))
  const currentSessionTitle = computed(() =>
    !sessionId.value ? '新对话' : (sessions.value.find(s => s.id === sessionId.value)?.title ?? '对话')
  )

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

  async function loadSession(id: number) {
    if (id === sessionId.value) return
    const viewGeneration = ++_chatViewGeneration
    abortCtrl.value?.abort()        // 停掉当前会话的流式消费（后端生成不受影响、继续跑）
    streaming.value = false
    try {
      const data = await agentApi.getMessages(String(id))
      if (viewGeneration !== _chatViewGeneration) return
      sessionId.value = id
      ownerPlatformUserId.value = data.session?.ownerPlatformUserId ?? null
      isGroupSession.value = data.session?.chatType === 'group'
      clearStatus()   // 切会话先清掉上个会话残留的状态指示（active 会话下面 resumeStream 会重置）
      // html 先留空、不在这一步就把整个历史都跑一遍 marked.parse——只有真正挂进虚拟列表
      // 视口的那些消息才会被 watch(virtualRows, ...) 补上，减轻长会话打开时的一次性 CPU 尖峰。
      messages.value = data.messages.map((m: RawSessionMessage) => {
        const speaker = resolveSpeaker(m.role, m.platformUserId, m.platformUserName)
        return {
          id: mkid(),
          dbId: m.id,
          role: speaker.role,
          speakerLabel: speaker.speakerLabel,
          platformUserId: m.platformUserId || null,
          text: displayQQFaces(m.content),
          html: null,
          files: m.files && m.files.length ? m.files : undefined,
          quotedText: m.quotedText || undefined,
          time: new Date(m.createdAt).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }),
        }
      })
      options.onContentReset(); _sessionTurn = 0
      await nextTick()
      options.onCaptureBaseScrollH()   // 基线 = 切入会话的历史高度
      scrollBottom(true)
      if (data.active) resumeStream(id)   // 该会话后端正在生成 → 重连续看
    } catch {}
  }

  async function newSession() {
    ++_chatViewGeneration
    abortCtrl.value?.abort()
    streaming.value = false
    sessionId.value = null
    messages.value = []        // 大窗「新对话」是干净起手——不放默认问候（问候只在打开小窗时出现）
    _sessionTurn = 0
    await nextTick()
    options.composerRef.value?.focus()
  }

  async function deleteSession(id: number) {
    try {
      await agentApi.deleteSession(String(id))
      sessions.value = sessions.value.filter(s => s.id !== id)
      if (sessionId.value === id) await newSession()
    } catch {}
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

  // 消费一条 SSE 流，把事件渲染进消息列表。send（POST /chat）和续看（GET .../stream）共用。
  // 返回 { aiIdx, usedTools }，供调用方做收尾（首条空回复兜底、刷新视图）。
  async function consumeStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    ownerSid: number | null,
    viewGeneration = _chatViewGeneration,
  ) {
    const decoder = new TextDecoder()
    let buf = '', aiIdx = -1, aborted = false
    let sid = ownerSid           // 本流归属的会话（新对话在 session_id 事件前为 null）
    let detached = false         // 一旦用户切到别的会话，本流永久脱离、不再污染当前视图
    const usedTools = new Set<string>()
    // 当前看的还是本流的会话吗？切走后置 detached（之后切回靠 loadSession 干净重载，不半路重接）
    const live = () => {
      if (detached || viewGeneration !== _chatViewGeneration) {
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
            const isNew = sessionId.value !== evt.session_id
            // 仅当用户仍停在本流视图（旧会话或新对话）才把视图切到新 id，否则别抢走用户当前会话
            if (viewGeneration === _chatViewGeneration && sessionId.value === (sid ?? ownerSid)) {
              sessionId.value = evt.session_id
            }
            sid = evt.session_id
            if (isNew) await fetchSessions()
          } else if (evt.type === 'session_title') {
            const s = sessions.value.find(s => s.id === sid)   // 按本流会话更新标题，与当前视图无关
            if (s) s.title = evt.title
          } else if (evt.type === '_new_round') {
            // 后端新一轮开始（sanitizer 已重置），前端无需变更视觉状态
          } else if (evt.type === 'tool_call') {
            if (evt.name && !evt.name.startsWith('_')) usedTools.add(evt.name)  // 跳过 _preparing 占位
            // label 已由后端解析（含「状态命名」覆盖 + 复查前缀）；气泡常驻，仅替换文字。
            if (live()) setStatus({ kind: 'text', label: evt.label || evt.name })
          } else if (evt.type === 'tool_done') {
            // 改动类工具一完成就即时 bump 对应资源（走已连好的对话流，不等回合末、不靠 best-effort
            // 的 events SSE）→ 文件预览 / 项目卡 / 日历当场刷新。视图是全局的，切走也该刷，故不受 live() 限制。
            if (evt.name) {
              if (FILE_TOOLS.has(evt.name)) liveStore.bump('files')
              else if (PROJECT_TOOLS.has(evt.name)) liveStore.bump('projects')
              else if (CALENDAR_TOOLS.has(evt.name)) liveStore.bump('calendar')
            }
            // 任一工具结束都回到思考态；下一轮工具调用会继续替换文字，不能让气泡闪退。
            if (live()) setStatus(_thinkingItem())
          } else if (evt.type === 'token') {
            if (live()) {
              clearStatus()   // 真回复开始 → 打断状态队列、收起指示，让位给流式正文
              if (aiIdx === -1) options.playIncomingMessageSfx()
              if (aiIdx === -1) { messages.value.push({ id: mkid(), role: 'ai', text: '', time: now(), streaming: true }); aiIdx = messages.value.length - 1 }
              messages.value[aiIdx].text += evt.content
              await scrollBottom()
            }
          } else if (evt.type === 'file') {
            if (live()) {
              clearStatus()
              if (aiIdx === -1) options.playIncomingMessageSfx()
              if (aiIdx === -1) { messages.value.push({ id: mkid(), role: 'ai', text: '', time: now(), streaming: true }); aiIdx = messages.value.length - 1 }
              const m = messages.value[aiIdx]
              if (!m.files) m.files = []
              m.files.push(evt.file)
              await scrollBottom()
            }
          } else if (evt.type === 'done') {
            if (live()) clearStatus()
          } else if (evt.type === 'error') {
            if (live()) {
              clearStatus()
              playGuguSfx('error')
              messages.value.push({ id: mkid(), role: 'ai', text: evt.message || evt.detail || '咕咕开小差了 😵‍💫 麻烦再说一遍好吗？', time: now() })
              aiIdx = messages.value.length - 1
              await scrollBottom()
            }
          }
        }
      }
    } finally {
      if (!detached && viewGeneration === _chatViewGeneration && aiIdx !== -1 && messages.value[aiIdx]) {
        const m = messages.value[aiIdx]
        m.streaming = false
        m.html = renderMd(m.text)
        if (!m.text?.trim() && !m.files?.length) {
          messages.value.splice(aiIdx, 1)
        }
      }
    }
    return { aiIdx, usedTools, detached, sid, aborted }
  }

  // 续看：打开会话时若它正在生成（messages 接口返回 active），重连看后端跑完。
  async function resumeStream(id: number) {
    if (streaming.value) return            // 本地正在发/看，不重复连
    const viewGeneration = _chatViewGeneration
    const token = localStorage.getItem('user_token') ?? ''
    abortCtrl.value = new AbortController()   // 让下次切会话能 abort 掉这条续看
    streaming.value = true; clearStatus(); setStatus(_thinkingItem())
    try {
      const res = await fetch(`${API_BASE}/agent/sessions/${id}/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: abortCtrl.value.signal,
      })
      if (!res.ok) return
      if (viewGeneration !== _chatViewGeneration || sessionId.value !== id) return   // 期间又切走了，丢弃
      if (!res.body) return
      const r = await consumeStream(res.body.getReader(), id, viewGeneration)
      options.refreshAfterTools(r.usedTools)
    } catch { /* 续看失败/被切走中断都不打扰 */ }
    finally {
      // 仍停在本会话才收尾全局指示，避免切走后清掉新会话续看的状态
      if (viewGeneration === _chatViewGeneration && sessionId.value === id) {
        clearStatus(); streaming.value = false; abortCtrl.value = null
      }
    }
  }

  async function send(forcedText?: string) {
    // forcedText 来自"排队接力"（队首消息）：此时用户气泡已在入队时显示过，不重复推
    const fromInput = forcedText === undefined
    const text = (fromInput ? inputText.value : (forcedText ?? '')).trim()
    const atts = fromInput ? options.pendingAtt.value.slice() : []   // 本次随消息发的附件
    if (!text && !atts.length) return
    if (fromInput) {
      _sessionTurn++
      messages.value.push({ id: mkid(), role: 'user', text, time: now(),
        files: atts.length ? atts.map(a => ({ name: a.name, ext: a.ext, size_bytes: a.size, attach_id: a.attach_id, kind: a.kind, duration: a.duration, upload: true, _thumbUrl: a._thumbUrl, img_width: a.img_width, img_height: a.img_height })) : undefined })
      inputText.value = ''
      options.pendingAtt.value = []
      options.composerRef.value?.resetHeight()
      trackApi.track('chat_message', { turn: _sessionTurn }).catch(() => {})
      await scrollBottom(true)
    }
    // 生成中：把这条排队，等当前流式结束后在 finally 里接着发（气泡已显示）
    if (streaming.value) { pendingQueue.value.push(text); return }

    streaming.value = true; clearStatus(); setStatus(_thinkingItem())
    abortCtrl.value = new AbortController()
    await scrollBottom()
    const token = localStorage.getItem('user_token') ?? ''
    const ownerSid = sessionId.value   // 本次发送归属的会话（新对话为 null，流里拿到 id 后回填）
    const viewGeneration = _chatViewGeneration
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
        body: JSON.stringify({ message: text, session_id: ownerSid, attachments: atts.map(a => a.attach_id),
                               ...(greetingForSession ? { greeting: greetingForSession } : {}) }),
        signal: abortCtrl.value.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('empty response body')

      const r = await consumeStream(res.body.getReader(), ownerSid, viewGeneration)
      resolvedSid = r.sid
      aiIdx = r.aiIdx
      r.usedTools.forEach(t => usedTools.add(t))
      // 用户中途切走了 → 别把兜底气泡塞进当前别的会话视图（回复已在后端，切回会重载）
      if (aiIdx === -1 && !r.detached && !r.aborted) {
        messages.value.push({ id: mkid(), role: 'ai', text: '收到，但没有收到回复，请稍后再试。', time: now() })
        await scrollBottom()
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError' && sessionId.value === resolvedSid) {
        // fetch 抛错=连不上咕咕后端，基本都是网络问题（仅在仍停在本会话时报）
        clearStatus()
        messages.value.push({ id: mkid(), role: 'ai', text: '咕咕网络不太好 📡 可以再发一遍吗？', time: now() })
        await scrollBottom()
      }
    } finally {
      // 仍停在本次发送的会话才收尾全局状态；切走后这些状态归新会话的续看流管，别清掉
      const ownsView = viewGeneration === _chatViewGeneration && sessionId.value === resolvedSid
      if (ownsView) {
        // 流式结束：把该条 AI 消息标记为非流式，触发 markdown 渲染（流式中按纯文本显示，避免半截表格/代码块闪烁）
        if (aiIdx !== -1 && messages.value[aiIdx]) messages.value[aiIdx].streaming = false
        clearStatus(); streaming.value = false; abortCtrl.value = null
        options.loadQuota()   // 回复消耗精力，刷新一次——耗尽时顶部状态即时变「休息中」（不 await，原逻辑就是 fire-and-forget）
        // markdown 重渲染后内容变高，MutationObserver 此时已因 streaming=false 停止跟随，
        // 需在 nextTick 后再滚一次，否则底部时间戳会被截掉
        await scrollBottom()
      }
      // 咕咕若调用了改数据的工具，刷新对应前端视图（项目/日历/文件），免手动刷新页面
      options.refreshAfterTools(usedTools)
      // 生成期间排队的消息：取队首接着发（其自身 finally 会继续取下一条，逐条处理）
      if (ownsView && pendingQueue.value.length) send(pendingQueue.value.shift())
    }
  }

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
    inputText, thinkingLabels, streaming, statusKind, statusTyped, isTypingText,
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
