<template>
  <!-- 迷你播放器 -->
  <Transition name="mini-player">
    <div v-if="audioStore.file && (miniPinned || open)" class="mini-player" :style="miniPlayerStyle" ref="playerRef">
      <div class="mp-info">
        <span class="mp-bars" :class="{ 'mp-bars--playing': barsPlaying }" ref="barsRef"><i v-for="n in 4" :key="n" /></span>
        <span class="mp-name">{{ audioStore.file.displayName }}.{{ audioStore.file.ext?.toLowerCase() }}</span>
        <div class="btn-group">
          <button class="mp-btn mp-btn--pin" :class="{ 'mp-btn--pinned': miniPinned }"
                  @click="miniPinned = !miniPinned" :title="miniPinned ? '取消固定' : '固定'">
            <PhPushPin v-if="miniPinned" :size="14" weight="fill" />
            <PhPushPinSlash v-else :size="14" weight="regular" />
          </button>
          <button class="mp-btn mp-btn--close popup-close-btn" @click="audioStop" title="关闭">
            <PhX weight="bold" :size="13" />
          </button>
        </div>
      </div>
      <div class="mp-seek-row">
        <span class="mp-time">{{ fmtTime(audioCurrent) }}</span>
        <div class="mp-track" @click="audioSeek" @mousedown="audioStartDrag">
          <div class="mp-fill" :style="{ width: audioSeekPct + '%' }" />
          <div class="mp-thumb" :style="{ left: audioSeekPct + '%' }" />
        </div>
        <span class="mp-time">{{ fmtTime(audioDuration) }}</span>
      </div>
      <div class="mp-controls">
        <div class="mp-vol-spacer" />
        <button class="mp-btn mp-btn--play" @click="audioToggle">
          <PhPlay  v-if="!audioPlaying" weight="fill" :size="16" />
          <PhPause v-else               weight="fill" :size="16" />
        </button>
        <div class="mp-vol-group">
          <button class="mp-vol-btn" @click="audioToggleMute">
            <PhSpeakerHigh  v-if="!audioMuted && audioVolume > 0.5" weight="fill" :size="14" />
            <PhSpeakerLow   v-else-if="!audioMuted && audioVolume > 0" weight="fill" :size="14" />
            <PhSpeakerSlash v-else weight="fill" :size="14" />
          </button>
          <input class="mp-vol-slider" type="range" min="0" max="1" step="0.02" :value="audioVolume" @input="audioSetVolume" />
        </div>
      </div>
    </div>
  </Transition>

  <audio
    ref="audioEl"
    :src="audioStore.blobUrl"
    @timeupdate="audioCurrent = audioEl.currentTime"
    @durationchange="audioDuration = audioEl.duration || 0"
    @play="audioPlaying = true"
    @pause="onAudioPause"
    @ended="onAudioEnded"
    @canplay="onCanPlay"
  />

  <!-- 悬浮球 -->
  <button class="ai-fab" :class="{ 'ai-fab--playing': rippleActive }" ref="fabRef" @click="toggleOpen" title="咕咕">
    <svg ref="fabSvgRef"
         :class="{ 'ai-fab-spin': audioStore.file && !spinningBack }"
         :style="audioStore.file && !spinningBack ? { animationPlayState: audioPlaying ? 'running' : 'paused' } : {}"
         width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 7h.01"/>
      <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>
      <path d="M20 7l2 .5-2 .5"/>
      <path d="M10 18v3"/>
      <path d="M14 17.75V21"/>
    </svg>
  </button>

  <!-- 聊天窗口（单一元素，小/大状态通过位置过渡） -->
  <Transition name="chat-open">
    <div v-if="open" class="chat-window" :style="windowStyle" ref="windowRef">
      <Transition name="layout-switch">

        <!-- 小窗布局 -->
        <div v-if="!expanded" key="small" class="layout-small">
          <div class="popup-header">
            <span class="popup-title">咕咕</span>
            <span class="popup-status">
              <em class="status-dot" />在线
            </span>
            <div class="btn-group">
              <button class="popup-icon-btn" @click="enterExpanded" title="展开">
                <PhArrowsOut weight="bold" :size="13" />
              </button>
              <button class="popup-close-btn" @click="open = false">
                <PhX weight="bold" :size="13" />
              </button>
            </div>
          </div>
          <div class="popup-messages" ref="messagesEl">
            <div v-for="msg in messages" :key="msg.id" :class="['msg', msg.role]">
              <div v-if="msg.role === 'ai'" class="msg-bubble md-body"><span v-html="msg.streaming ? renderMdStream(msg.text) : renderMd(msg.text)" /></div>
              <div v-else class="msg-bubble">{{ msg.text }}</div>
              <div class="msg-footer">
                <span class="msg-time">{{ msg.time }}</span>
                <button class="msg-copy-btn" @click="copyMsg(msg)" title="复制">
                  <PhCheck v-if="copiedId === msg.id" :size="11" weight="bold" />
                  <PhCopy  v-else :size="11" />
                </button>
              </div>
            </div>
            <div v-if="activeTool" class="msg ai">
              <div class="msg-bubble tool-bubble">
                <span class="tool-spinner" />
                <span class="tool-label">{{ activeTool }}</span>
              </div>
            </div>
            <div v-else-if="thinking" class="msg ai">
              <div class="msg-bubble thinking"><span /><span /><span /></div>
            </div>
          </div>
          <div class="popup-input-row">
            <input v-model="inputText" placeholder="问问项目进度、截止日期…" @keydown.enter="send" />
            <button class="send-btn" @click="streaming ? stopStreaming() : send()">
              <PhArrowRight v-if="!streaming" weight="bold" :size="13" />
              <PhStop       v-else            weight="fill" :size="13" />
            </button>
          </div>
        </div>

        <!-- 大窗布局 -->
        <div v-else key="large" class="layout-large">
          <div class="exp-sidebar panel-left">
            <div class="exp-sidebar-header">
              <span class="exp-sidebar-title">咕咕</span>
            </div>
            <div class="exp-new-session-wrap">
              <button class="exp-new-session-btn" @click="newSession">
                <PhPencilSimple weight="bold" :size="13" />
                新对话
              </button>
            </div>
            <div class="exp-session-list">
              <div
                v-for="s in sessions" :key="s.id"
                class="exp-session-item"
                :class="{ active: s.id === sessionId }"
                @click="loadSession(s.id)"
              >
                <span class="exp-session-title">{{ s.title }}</span>
                <button class="exp-session-del" @click.stop="deleteSession(s.id)" title="删除">
                  <PhTrash :size="12" weight="bold" />
                </button>
              </div>
              <div v-if="sessions.length === 0" class="exp-session-empty">暂无对话</div>
            </div>
          </div>
          <div class="exp-main">
            <div class="exp-header">
              <span class="exp-header-title">{{ currentSessionTitle }}</span>
              <span class="popup-status">
                <em class="status-dot" />在线
              </span>
              <button class="exp-icon-btn" @click="exitExpanded" title="收起">
                <PhArrowsIn weight="bold" :size="14" />
              </button>
              <button class="popup-close-btn" @click="open = false; expanded = false">
                <PhX weight="bold" :size="13" />
              </button>
            </div>
            <div class="exp-messages" ref="expMessagesEl">
              <div v-for="msg in messages" :key="msg.id" :class="['msg', msg.role]">
                <div v-if="msg.role === 'ai'" class="msg-bubble md-body"><span v-html="msg.streaming ? renderMdStream(msg.text) : renderMd(msg.text)" /></div>
                <div v-else class="msg-bubble">{{ msg.text }}</div>
                <div class="msg-footer">
                  <span class="msg-time">{{ msg.time }}</span>
                  <button class="msg-copy-btn" @click="copyMsg(msg)" title="复制">
                    <PhCheck v-if="copiedId === msg.id" :size="11" weight="bold" />
                    <PhCopy  v-else :size="11" />
                  </button>
                </div>
              </div>
              <div v-if="activeTool" class="msg ai">
                <div class="msg-bubble tool-bubble">
                  <span class="tool-spinner" />
                  <span class="tool-label">{{ activeTool }}</span>
                </div>
              </div>
              <div v-else-if="thinking" class="msg ai">
                <div class="msg-bubble thinking"><span /><span /><span /></div>
              </div>
            </div>
            <div class="exp-input-row">
              <textarea
                v-model="inputText"
                ref="expInputEl"
                placeholder="问问项目进度、截止日期…"
                rows="1"
                @keydown.enter.exact.prevent="send"
                @input="autoResize"
              />
              <button class="send-btn exp-send-btn" @click="streaming ? stopStreaming() : send()">
                <PhArrowRight v-if="!streaming" weight="bold" :size="14" />
                <PhStop       v-else            weight="fill" :size="14" />
              </button>
            </div>
          </div>
        </div>

      </Transition>
    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { marked } from 'marked'
import hljs from 'highlight.js'
import { useAudioStore } from '@/stores/audio'
import { useProjectStore } from '@/stores/projects'
import { agentApi } from '@/services/api'
import { uploadSignal, calendarSignal } from '@/services/cache'
import {
  PhPushPin, PhPushPinSlash, PhX, PhPlay, PhPause,
  PhSpeakerHigh, PhSpeakerLow, PhSpeakerSlash,
  PhArrowRight, PhStop, PhArrowsOut, PhArrowsIn,
  PhPencilSimple, PhTrash, PhCopy, PhCheck,
} from '@phosphor-icons/vue'

const SMALL_W   = 316
const SMALL_H   = 360
const SIDEBAR_W = 220

const audioStore    = useAudioStore()
const projectStore  = useProjectStore()

// 工具名 → 受影响数据域，咕咕操作后据此刷新前端，免手动刷新页面
const _PROJECT_TOOLS = new Set(['create_project','update_project','update_stage','add_stage','remove_stage','rename_stage','add_todo','remove_todo','set_priority','archive_project','delete_project'])
const _CALENDAR_TOOLS = new Set(['create_event','update_event','delete_event'])
const _FILE_TOOLS = new Set(['create_document','edit_file','rename_file','move_file','create_folder','delete_file','rename_folder','delete_folder','restore_file','permanent_delete'])

async function refreshAfterTools(usedTools) {
  if (!usedTools.size) return
  const has = (set) => [...usedTools].some(t => set.has(t))
  try {
    if (has(_PROJECT_TOOLS)) await projectStore.fetchProjects()
    if (has(_CALENDAR_TOOLS)) { calendarSignal.value++; projectStore.fetchUpcomingCalEvents?.() }
    if (has(_FILE_TOOLS)) uploadSignal.value++
  } catch (e) { /* 刷新失败不影响对话 */ }
}
const audioEl       = ref(null)
const audioPlaying  = ref(false)
const audioCurrent  = ref(0)
const audioDuration = ref(0)

function progKey() { return audioStore.file ? `audio_prog_${audioStore.file.id}` : null }
function saveProgress() {
  const key = progKey()
  if (!key || !audioEl.value?.duration) return
  const t = audioEl.value.currentTime, d = audioEl.value.duration
  if (t < d - 3) localStorage.setItem(key, t)
  else localStorage.removeItem(key)
}
function restoreProgress() {
  const key = progKey()
  if (!key || !audioEl.value) return
  const saved = localStorage.getItem(key)
  localStorage.removeItem(key)
  if (saved && +saved > 0) audioEl.value.currentTime = +saved
}

const needsRestore = ref(false)
watch(() => audioStore.file?.id, () => { needsRestore.value = true })

const audioSeekPct = computed(() =>
  audioDuration.value ? (audioCurrent.value / audioDuration.value) * 100 : 0
)

const fabSvgRef    = ref(null)
const rippleActive = ref(false)
const barsRef      = ref(null)
const barsPlaying  = ref(false)

watch(audioPlaying, (playing) => {
  if (playing) {
    barsRef.value?.querySelectorAll('i').forEach(b => { b.style.cssText = '' })
    barsPlaying.value = true
  } else {
    const bars = barsRef.value?.querySelectorAll('i') ?? []
    bars.forEach(b => { b.style.height = getComputedStyle(b).height; b.style.transition = 'none' })
    barsPlaying.value = false
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bars.forEach(b => { b.style.transition = 'height 0.45s ease-out'; b.style.height = '4px' })
    }))
    setTimeout(() => bars.forEach(b => { b.style.cssText = '' }), 500)
  }
})

const spinningBack = ref(false)
let rippleTimeout = null
watch(audioPlaying, (playing) => {
  if (playing) { clearTimeout(rippleTimeout); rippleActive.value = true }
  else { rippleTimeout = setTimeout(() => { rippleActive.value = false }, 3600) }
})

function onCanPlay() {
  audioEl.value.volume = audioVolume.value
  if (needsRestore.value) { needsRestore.value = false; restoreProgress() }
  audioEl.value.play()
}
function onAudioPause() { audioPlaying.value = false }
function onAudioEnded() {
  audioPlaying.value = false
  const key = progKey(); if (key) localStorage.removeItem(key)
}
function audioToggle() {
  if (!audioEl.value) return
  audioPlaying.value ? audioEl.value.pause() : audioEl.value.play()
}
function audioStop() {
  audioEl.value?.pause()
  const svgEl = fabSvgRef.value
  if (svgEl && audioStore.file) {
    const matrix = new DOMMatrix(getComputedStyle(svgEl).transform)
    const angle = Math.atan2(matrix.b, matrix.a) * (180 / Math.PI)
    const normalized = Math.round(((angle % 360) + 360) % 360)
    spinningBack.value = true
    svgEl.style.transform = `rotate(${normalized}deg)`
    svgEl.style.transition = 'none'
    requestAnimationFrame(() => requestAnimationFrame(() => {
      svgEl.style.transition = 'transform 0.65s ease-out'
      svgEl.style.transform = 'rotate(360deg)'
    }))
    setTimeout(() => { svgEl.style.transform = ''; svgEl.style.transition = ''; spinningBack.value = false }, 750)
  }
  audioPlaying.value = false; audioCurrent.value = 0; audioDuration.value = 0
  audioStore.stop()
}

const VOL_KEY    = 'gugu_audio_volume'
const audioVolume = ref(+(localStorage.getItem(VOL_KEY) ?? 0.5))
const audioMuted  = ref(false)
function audioSetVolume(e) {
  audioVolume.value = +e.target.value
  localStorage.setItem(VOL_KEY, audioVolume.value)
  if (audioEl.value) { audioEl.value.volume = audioVolume.value; audioEl.value.muted = false }
  audioMuted.value = false
}
function audioToggleMute() {
  audioMuted.value = !audioMuted.value
  if (audioEl.value) audioEl.value.muted = audioMuted.value
}
function audioSeek(e) {
  if (!audioEl.value || !audioDuration.value) return
  const rect = e.currentTarget.getBoundingClientRect()
  audioEl.value.currentTime = ((e.clientX - rect.left) / rect.width) * audioDuration.value
}
function audioStartDrag(e) {
  audioSeek(e)
  const move = ev => audioSeek(ev)
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}
function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00'
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

marked.use({
  breaks: true, gfm: true,
  renderer: (() => {
    const r = new marked.Renderer()
    r.code = ({ text, lang }) => {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(text, { language }).value
      const label = lang || 'code'
      return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${label}</span><button class="md-copy-btn" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.innerText)">复制</button></div><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`
    }
    return r
  })(),
})
function renderMd(text) { return text ? marked.parse(text) : '' }

// 流式渲染专用：补全未闭合的代码围栏，避免 marked 把半段代码块解析成残缺 HTML
function renderMdStream(text) {
  if (!text) return ''
  const fences = (text.match(/^```/gm) || []).length
  const patched = fences % 2 === 1 ? text + '\n```' : text
  return marked.parse(patched)
}

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

// ── 窗口状态 ────────────────────────────────────────────
const open       = ref(false)
const expanded   = ref(false)
const miniPinned = ref(localStorage.getItem('gugu_mini_pinned') !== 'false')
watch(miniPinned, v => localStorage.setItem('gugu_mini_pinned', v))

const fabRef      = ref(null)
const windowRef   = ref(null)
const playerRef   = ref(null)
const expInputEl  = ref(null)
const messagesEl  = ref(null)
const expMessagesEl = ref(null)

// 视口尺寸，用于计算小窗绝对坐标
const vw = ref(window.innerWidth)
const vh = ref(window.innerHeight)
function onResize() { vw.value = window.innerWidth; vh.value = window.innerHeight }

// 小窗高度动态延伸：
//   每次打开/切换小窗时重置 _scrollDelta = 0
//   streaming 自动滚底时，累计 scrollTop 向下移动了多少，超出部分就是窗口需要增高的量
//   用 scrollTop 位移而非 scrollHeight 差值，天然规避大小窗宽度不同导致的换行高度偏差
let _scrollDelta = 0
const msgsGrowth = ref(0)

const smallH = computed(() => {
  const maxH = Math.min(vh.value * 0.75, vh.value - 88 - 16)
  return Math.min(maxH, SMALL_H + msgsGrowth.value)
})

// 单一窗口的位置样式：小状态与大状态都用 top/left/right/bottom 像素值，保证过渡正常
// transition 放在 CSS 而非 inline style，避免覆盖 Vue Transition 的 opacity/transform 动画
const windowStyle = computed(() => {
  if (expanded.value) {
    // 右锚 720px，遇到窄屏时不超过导航栏右边界
    const left = Math.max(SIDEBAR_W + 12, vw.value * 0.4 - 12)
    return { top: '12px', right: '12px', bottom: '12px', left: `${left}px` }
  }
  return {
    top:    `${vh.value - 88 - smallH.value}px`,
    left:   `${vw.value - 28 - SMALL_W}px`,
    right:  '28px',
    bottom: '88px',
  }
})

// 播放器联动：小窗打开时顶到窗口上方，其余情况悬在 fab 上方
const miniPlayerStyle = computed(() => {
  const bottom = (open.value && !expanded.value) ? 88 + smallH.value + 8 : 88
  // 小窗展开时播放器远离 FAB，从自身中心缩放；其他状态从 FAB 圆心缩放
  const origin = (open.value && !expanded.value)
    ? '50% 50%'
    : `calc(100% - 25px) calc(100% + ${bottom - 53}px)`
  return { bottom: `${bottom}px`, transformOrigin: origin }
})

async function toggleOpen() {
  open.value = !open.value
  if (open.value) {
    if (!expanded.value) { _scrollDelta = 0; msgsGrowth.value = 0 }
    await nextTick()
    const el = expanded.value ? expMessagesEl.value : messagesEl.value
    if (el) scrollToBottom(el)
  }
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', saveProgress)
  // 刷新后恢复上次会话（sessionStorage 仍在则拉回那段对话；失败则当作新对话并清除存档）
  const saved = sessionStorage.getItem(SESSION_KEY)
  if (saved) {
    loadSession(Number(saved)).then(() => {
      if (sessionId.value !== Number(saved)) sessionStorage.removeItem(SESSION_KEY)
    })
  }
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('beforeunload', saveProgress)
})

// ── 对话状态 ────────────────────────────────────────────
const inputText      = ref('')
const thinking       = ref(false)
const streaming      = ref(false)
const activeTool     = ref('')
const sessionId      = ref(null)
const abortCtrl      = ref(null)

// 会话 id 存入 sessionStorage：刷新页面保留当前对话，关闭浏览器/标签页才清空（=开新对话）
const SESSION_KEY = 'gugu_session_id'
watch(sessionId, (v) => {
  if (v) sessionStorage.setItem(SESSION_KEY, String(v))
  else sessionStorage.removeItem(SESSION_KEY)
})

function stopStreaming() {
  abortCtrl.value?.abort()
}

const copiedId = ref(null)
function copyMsg(msg) {
  // AI 消息取渲染后的纯文本，用户消息直接取原文
  let text = msg.text
  if (msg.role === 'ai' && msg.text) {
    const tmp = document.createElement('div')
    tmp.innerHTML = renderMd(msg.text)
    text = tmp.innerText || tmp.textContent || msg.text
  }
  const fallback = () => {
    const el = document.createElement('textarea')
    el.value = text
    el.style.cssText = 'position:fixed;top:-9999px;left:0;opacity:0'
    document.body.appendChild(el)
    el.focus(); el.select()
    try { document.execCommand('copy') } catch {}
    document.body.removeChild(el)
  }
  ;(navigator.clipboard ? navigator.clipboard.writeText(text).catch(fallback) : Promise.reject())
    .catch(fallback)
  copiedId.value = msg.id
  setTimeout(() => { if (copiedId.value === msg.id) copiedId.value = null }, 1500)
}

const now = () => {
  const d = new Date()
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
let _mid = 0
const mkid = () => ++_mid

const messages = ref([
  { id: mkid(), role: 'ai', text: '你好！我是咕咕，可以帮你查项目进度、搜索文件、查看截止日期和近期排期，随时问我吧 ✦', time: now() },
])

// ── 展开/收起 ────────────────────────────────────────────
const sessions = ref([])
const currentSessionTitle = computed(() =>
  !sessionId.value ? '新对话' : (sessions.value.find(s => s.id === sessionId.value)?.title ?? '对话')
)

async function fetchSessions() {
  try { sessions.value = await agentApi.listSessions() } catch {}
}

async function enterExpanded() {
  expanded.value = true
  await fetchSessions()
  await nextTick()
  expInputEl.value?.focus()
  if (expMessagesEl.value) expMessagesEl.value.scrollTop = 999999
}

async function exitExpanded() {
  _scrollDelta = 0; msgsGrowth.value = 0  // 先重置，小窗 DOM 以 SMALL_H 直接创建，不产生二次缩小
  expanded.value = false
  await nextTick()
  const el = messagesEl.value
  if (!el) return
  el.scrollTop = 999999
  // CSS transition 让窗口从大尺寸平滑缩小（0.38s），期间 clientHeight 持续变化
  // ResizeObserver 跟着一直滚底，过渡结束后断开
  const ro = new ResizeObserver(() => { el.scrollTop = 999999 })
  ro.observe(el)
  setTimeout(() => ro.disconnect(), 450)
}

async function loadSession(id) {
  if (id === sessionId.value) return
  try {
    const data = await agentApi.getMessages(id)
    sessionId.value = id
    messages.value = data.messages.map(m => ({
      id: mkid(),
      role: m.role === 'assistant' ? 'ai' : m.role,
      text: m.content,
      time: new Date(m.createdAt).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }),
    }))
    _scrollDelta = 0; msgsGrowth.value = 0
    await nextTick(); scrollExpBottom()
  } catch {}
}

async function newSession() {
  sessionId.value = null
  messages.value = []
  await nextTick(); expInputEl.value?.focus()
}

async function deleteSession(id) {
  try {
    await agentApi.deleteSession(id)
    sessions.value = sessions.value.filter(s => s.id !== id)
    if (sessionId.value === id) await newSession()
  } catch {}
}

function autoResize(e) {
  const el = e.target; el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

const NEAR_BOTTOM = 100  // px 阈值

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
}

// 追踪用户是否主动向上翻阅
const userScrolledUp = ref(false)

function onMsgScroll() {
  if (!messagesEl.value) return
  userScrolledUp.value = !isNearBottom(messagesEl.value)
}
function onExpMsgScroll() {
  if (!expMessagesEl.value) return
  userScrolledUp.value = !isNearBottom(expMessagesEl.value)
}

watch(messagesEl, (el, old) => {
  old?.removeEventListener('scroll', onMsgScroll)
  el?.addEventListener('scroll', onMsgScroll, { passive: true })
})
watch(expMessagesEl, (el, old) => {
  old?.removeEventListener('scroll', onExpMsgScroll)
  el?.addEventListener('scroll', onExpMsgScroll, { passive: true })
})

// streaming 用即时滚动跟随，避免 smooth 叠加追不上
function scrollToBottom(el, smooth = false) {
  if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  else el.scrollTop = el.scrollHeight
}

// 用户发送时强制 smooth 滚到底；streaming 跟随时即时
async function scrollBottom(force = false) {
  await nextTick()
  const el = messagesEl.value; if (!el) return
  if (force) { userScrolledUp.value = false; scrollToBottom(el, true) }
  else if (!userScrolledUp.value) scrollToBottom(el)
}
async function scrollExpBottom(force = false) {
  await nextTick()
  const el = expMessagesEl.value; if (!el) return
  if (force) { userScrolledUp.value = false; scrollToBottom(el, true) }
  else if (!userScrolledUp.value) scrollToBottom(el)
}

// MutationObserver：内容变化时跟随（仅 streaming 且用户未上翻）
let msgMo = null, expMsgMo = null

function makeScrollObserver(getEl, trackGrowth = false) {
  return new MutationObserver(() => {
    const el = getEl()
    if (!el) return
    if (!streaming.value || userScrolledUp.value) return
    if (trackGrowth) {
      const prevTop = el.scrollTop
      scrollToBottom(el)
      const step = el.scrollTop - prevTop
      if (step > 0) { _scrollDelta += step; msgsGrowth.value = _scrollDelta }
    } else {
      scrollToBottom(el)
    }
  })
}

watch(messagesEl, (el) => {
  msgMo?.disconnect()
  if (!el) return
  msgMo = makeScrollObserver(() => messagesEl.value, true)
  msgMo.observe(el, { childList: true, subtree: true, characterData: true })
})
watch(expMessagesEl, (el) => {
  expMsgMo?.disconnect()
  if (!el) return
  expMsgMo = makeScrollObserver(() => expMessagesEl.value)
  expMsgMo.observe(el, { childList: true, subtree: true, characterData: true })
})

onUnmounted(() => {
  msgMo?.disconnect(); expMsgMo?.disconnect()
  messagesEl.value?.removeEventListener('scroll', onMsgScroll)
  expMessagesEl.value?.removeEventListener('scroll', onExpMsgScroll)
})

async function send() {
  const text = inputText.value.trim()
  if (!text || streaming.value) return
  messages.value.push({ id: mkid(), role: 'user', text, time: now() })
  inputText.value = ''
  if (expInputEl.value) expInputEl.value.style.height = 'auto'
  await scrollBottom(true); await scrollExpBottom(true)

  thinking.value = true; streaming.value = true
  abortCtrl.value = new AbortController()
  await scrollBottom(); await scrollExpBottom()
  const token = localStorage.getItem('user_token') ?? ''
  let aiIdx = -1
  const usedTools = new Set()

  try {
    const res = await fetch(`${BASE_URL}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ message: text, session_id: sessionId.value }),
      signal: abortCtrl.value.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim(); if (!raw) continue
        let evt; try { evt = JSON.parse(raw) } catch { continue }
        if (evt.type === 'session_id') {
          const isNew = sessionId.value !== evt.session_id
          sessionId.value = evt.session_id
          if (isNew) await fetchSessions()
        } else if (evt.type === 'session_title') {
          const s = sessions.value.find(s => s.id === sessionId.value)
          if (s) s.title = evt.title
        } else if (evt.type === '_new_round') {
          // 后端新一轮开始（sanitizer 已重置），前端无需变更视觉状态
        } else if (evt.type === 'tool_call') {
          thinking.value = false; activeTool.value = evt.label || evt.name
          if (evt.name) usedTools.add(evt.name)
          await scrollBottom(); await scrollExpBottom()
        } else if (evt.type === 'tool_done') {
          activeTool.value = ''; thinking.value = true
          await scrollBottom(); await scrollExpBottom()
        } else if (evt.type === 'token') {
          thinking.value = false; activeTool.value = ''
          if (aiIdx === -1) { messages.value.push({ id: mkid(), role: 'ai', text: '', time: now(), streaming: true }); aiIdx = messages.value.length - 1 }
          messages.value[aiIdx].text += evt.content
          await scrollBottom(); await scrollExpBottom()
        } else if (evt.type === 'done') {
          thinking.value = false; activeTool.value = ''
        } else if (evt.type === 'error') {
          thinking.value = false; activeTool.value = ''
          messages.value.push({ id: mkid(), role: 'ai', text: evt.message || evt.detail || '出错了，请稍后再试。', time: now() })
          aiIdx = messages.value.length - 1
          await scrollBottom(); await scrollExpBottom()
        }
      }
    }
    if (aiIdx === -1) {
      messages.value.push({ id: mkid(), role: 'ai', text: '收到，但没有收到回复，请稍后再试。', time: now() })
      await scrollBottom(); await scrollExpBottom()
    }
  } catch (e) {
    thinking.value = false
    if (e.name !== 'AbortError') {
      messages.value.push({ id: mkid(), role: 'ai', text: `连接失败：${e.message}`, time: now() })
      await scrollBottom(); await scrollExpBottom()
    }
  } finally {
    // 流式结束：把该条 AI 消息标记为非流式，触发 markdown 渲染（流式中按纯文本显示，避免半截表格/代码块闪烁）
    if (aiIdx !== -1 && messages.value[aiIdx]) messages.value[aiIdx].streaming = false
    thinking.value = false; activeTool.value = ''; streaming.value = false; abortCtrl.value = null
    // markdown 重渲染后内容变高，MutationObserver 此时已因 streaming=false 停止跟随，
    // 需在 nextTick 后再滚一次，否则底部时间戳会被截掉
    await scrollBottom(); await scrollExpBottom()
    // 咕咕若调用了改数据的工具，刷新对应前端视图（项目/日历/文件），免手动刷新页面
    refreshAfterTools(usedTools)
  }
}
</script>

<style scoped>
/* ── 悬浮球 ── */
.ai-fab {
  position: fixed; bottom: 28px; right: 28px;
  isolation: isolate; width: 50px; height: 50px; border-radius: 50%;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); border: none;
  cursor: pointer; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 18px rgba(123,127,178,0.32), inset 0 1px 0 rgba(255,255,255,0.45);
  transition: transform 0.2s, box-shadow 0.2s;
}
.ai-fab:hover { transform: scale(1.08); box-shadow: 0 7px 24px rgba(123,127,178,0.42), inset 0 1px 0 rgba(255,255,255,0.5); }
.ai-fab svg { position: relative; z-index: 1; }
.ai-fab-spin { animation: fab-spin 8s linear infinite; transform-origin: center; }
@keyframes fab-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.ai-fab--playing::before, .ai-fab--playing::after {
  content: ''; position: absolute; inset: 0; border-radius: 50%;
  border: 1.5px solid rgba(123,127,178,0.75); pointer-events: none;
  animation: fab-ripple 3.6s ease-out infinite;
}
.ai-fab--playing::after { animation-delay: 1.8s; }
@keyframes fab-ripple { 0% { transform: scale(0.4); opacity: 0.8; } 100% { transform: scale(1.55); opacity: 0; } }

/* ── 单一聊天窗口 ── */
.chat-window {
  position: fixed;
  z-index: 1001;
  border: 1px solid rgba(255,255,255,0.7);
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(20,25,50,0.18);
}
.chat-window::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: 20px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95), inset 1px 0 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(255,255,255,0.3);
  pointer-events: none;
  z-index: 100;
}

/* 小窗和大窗主区域负责背景 blur */
.layout-small, .exp-main {
  background: var(--panel-bg);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
}

/* 位移过渡放在 CSS，不放 inline style（避免覆盖 Vue transition 的 opacity/transform） */
.chat-window {
  transition: top 0.38s cubic-bezier(0.22,1,0.36,1),
              left 0.38s cubic-bezier(0.22,1,0.36,1),
              right 0.38s cubic-bezier(0.22,1,0.36,1),
              bottom 0.38s cubic-bezier(0.22,1,0.36,1);
}

/* 窗口开/关动画（从右下角 fab 原点缩放），!important 覆盖上方位移 transition */
.chat-open-enter-active {
  transition: opacity 0.26s, transform 0.34s cubic-bezier(0.22, 1.12, 0.36, 1) !important;
  transform-origin: right bottom;
}
.chat-open-leave-active {
  transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(0.55, 0, 1, 0.7) !important;
  transform-origin: right bottom;
}
.chat-open-enter-from, .chat-open-leave-to { opacity: 0; transform: scale(0.05); }

/* 内部布局切换：无动画，随窗口位移即时切换 */
.layout-switch-enter-active, .layout-switch-leave-active { transition: none; }
.layout-switch-leave-to { display: none; }

/* ── 小窗布局 ── */
.layout-small { display: flex; flex-direction: column; height: 100%; }

.popup-header {
  display: flex; align-items: center; gap: 9px;
  padding: 13px 14px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.5);
  flex-shrink: 0;
}
.popup-title { font-size: 13px; font-weight: 700; flex: 1; }
.popup-status { font-size: 11px; color: var(--color-success); display: flex; align-items: center; gap: 4px; }
.status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--color-success); }
.btn-group { display: flex; align-items: center; gap: 2px; }

.popup-icon-btn {
  width: 26px; height: 26px; border-radius: 7px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.popup-icon-btn:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.popup-icon-btn svg { display: block; }
.popup-close-btn {
  width: 26px; height: 26px; border-radius: 7px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.popup-close-btn svg { display: block; }
.popup-close-btn:hover { background: rgba(200,80,80,0.1) !important; color: rgba(200,80,80,0.8) !important; }

.popup-messages {
  flex: 1; overflow-y: auto;
  padding: 12px 13px;
  display: flex; flex-direction: column; gap: 8px;
}
.popup-input-row {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 13px;
  border-top: 1px solid rgba(255,255,255,0.65);
  background: rgba(255,255,255,0.55);
  backdrop-filter: blur(12px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  flex-shrink: 0;
}
.popup-input-row input {
  flex: 1; border: none; background: none;
  font-size: 13px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
}
.popup-input-row input::placeholder { color: var(--text-secondary); }

/* ── 大窗布局 ── */
.layout-large { display: flex; height: 100%; }

.exp-sidebar {
  width: 210px; flex-shrink: 0;
  display: flex; flex-direction: column;
}
.exp-sidebar-header {
  display: flex; align-items: center;
  padding: 16px 14px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.5);
  flex-shrink: 0;
}
.exp-sidebar-title { flex: 1; font-size: 14px; font-weight: 700; color: var(--text-primary); }

.exp-new-session-wrap { padding: 8px 10px 4px; }
.exp-new-session-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 8px 14px; border-radius: 99px; border: none; cursor: pointer;
  font-size: 12.5px; font-weight: 600; font-family: var(--font-sans);
  color: var(--color-primary);
  background: rgba(123,127,178,0.1);
  border: 1px solid rgba(123,127,178,0.18);
  transition: background 0.15s, box-shadow 0.15s;
}
.exp-new-session-btn:hover {
  background: rgba(123,127,178,0.18);
  box-shadow: 0 2px 8px rgba(123,127,178,0.15);
}
.exp-new-session-btn svg { display: block; }
.exp-icon-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s; flex-shrink: 0;
}
.exp-icon-btn:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.exp-icon-btn svg { display: block; }

.exp-session-list {
  flex: 1; overflow-y: auto;
  padding: 8px;
  display: flex; flex-direction: column; gap: 2px;
}
.exp-session-item {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; border-radius: 9px; cursor: pointer;
  transition: background 0.12s;
}
.exp-session-item:hover { background: rgba(255,255,255,0.55); }
.exp-session-item.active { background: rgba(123,127,178,0.12); }
.exp-session-title {
  flex: 1; font-size: 12.5px; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.exp-session-del {
  width: 20px; height: 20px; border-radius: 5px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0; transition: opacity 0.12s, background 0.12s; flex-shrink: 0;
}
.exp-session-item:hover .exp-session-del { opacity: 1; }
.exp-session-del:hover { background: rgba(200,80,80,0.1); color: rgba(200,80,80,0.8); }
.exp-session-del svg { display: block; }
.exp-session-empty { font-size: 12px; color: var(--text-secondary); padding: 12px 10px; }

.exp-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.exp-header {
  display: flex; align-items: center; gap: 9px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.5);
  flex-shrink: 0;
}
.exp-header-title { flex: 1; font-size: 14px; font-weight: 600; color: var(--text-primary); }

.exp-messages {
  flex: 1; overflow-y: auto;
  padding: 20px 24px;
  display: flex; flex-direction: column; gap: 12px;
}
.exp-messages .msg-bubble { max-width: 72%; font-size: 14px; }

.exp-input-row {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid rgba(255,255,255,0.65);
  background: rgba(255,255,255,0.55);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  flex-shrink: 0;
}
.exp-input-row textarea {
  flex: 1; border: none; background: none;
  font-size: 14px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
  resize: none; line-height: 1.5; max-height: 120px; overflow-y: auto;
  display: block; padding: 0; vertical-align: middle;
}
.exp-input-row textarea::placeholder { color: var(--text-secondary); }
.exp-send-btn { width: 32px; height: 32px; border-radius: 9px; }

/* ── 通用发送按钮 ── */
.send-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: white;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: transform 0.15s; flex-shrink: 0;
}
.send-btn svg { display: block; }
.send-btn:hover:not(:disabled) { transform: scale(1.1); }
.send-btn:disabled { opacity: 0.55; cursor: default; }

/* ── 消息气泡 ── */
.msg { display: flex; flex-direction: column; }
.msg.user { align-items: flex-end; }
.msg.ai { align-items: flex-start; }
.msg-bubble {
  padding: 9px 13px; border-radius: 13px;
  font-size: 13px; line-height: 1.5; max-width: 88%;
}
.msg.ai .msg-bubble {
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.65);
  border-bottom-left-radius: 4px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
}
.msg.user .msg-bubble {
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: white;
  border-bottom-right-radius: 4px;
}
.msg-footer {
  display: flex; align-items: center; gap: 4px;
  margin-top: 3px; padding: 0 3px;
}
.msg-time { font-size: 10px; color: var(--text-secondary); }
.msg-copy-btn {
  width: 18px; height: 18px; border-radius: 4px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0; opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}
.msg:hover .msg-copy-btn { opacity: 1; }
.msg-copy-btn:hover { background: rgba(0,0,0,0.07); color: var(--color-primary); }
.msg-copy-btn svg { display: block; }

/* ── 思考/工具动画 ── */
.thinking { display: flex; gap: 4px; align-items: center; padding: 16px 13px; }
.thinking span {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-primary); animation: bounce 1.2s infinite; opacity: 0.6;
}
.thinking span:nth-child(2) { animation-delay: 0.2s; }
.thinking span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }

.tool-bubble { display: flex; align-items: center; gap: 8px; padding: 10px 13px; font-size: 12px; color: var(--color-primary); }
.tool-spinner {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid rgba(123,127,178,0.25); border-top-color: var(--color-primary);
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.tool-label { font-size: 12px; font-weight: 600; }

/* ── Markdown ── */
.md-body { padding: 10px 13px; }
.md-body :deep(p) { margin: 0 0 8px; line-height: 1.6; }
.md-body :deep(p:last-child) { margin-bottom: 0; }
.md-body :deep(h1),.md-body :deep(h2),.md-body :deep(h3) { font-weight: 700; margin: 10px 0 6px; line-height: 1.3; }
.md-body :deep(h1) { font-size: 14px; }
.md-body :deep(h2) { font-size: 13px; }
.md-body :deep(h3) { font-size: 12px; }
.md-body :deep(ul),.md-body :deep(ol) { margin: 4px 0 8px 18px; padding: 0; }
.md-body :deep(ul) { list-style: disc; }
.md-body :deep(ol) { list-style: decimal; }
.md-body :deep(li) { margin-bottom: 6px; line-height: 1.6; display: list-item; }
.md-body :deep(li:last-child) { margin-bottom: 0; }
.md-body :deep(li > ul), .md-body :deep(li > ol) { margin: 2px 0 2px 14px; }

/* 表格 */
.md-body :deep(table) {
  width: 100%; border-collapse: collapse; margin: 8px 0;
  font-size: 12.5px; border-radius: 8px; overflow: hidden;
}
.md-body :deep(th) {
  background: rgba(123,127,178,0.1); font-weight: 600;
  padding: 7px 12px; text-align: left;
  border-bottom: 1px solid rgba(123,127,178,0.2);
}
.md-body :deep(td) {
  padding: 6px 12px;
  border-bottom: 1px solid rgba(0,0,0,0.05);
}
.md-body :deep(tr:last-child td) { border-bottom: none; }
.md-body :deep(tr:nth-child(even) td) { background: rgba(0,0,0,0.02); }
.md-body :deep(strong) { font-weight: 700; }
.md-body :deep(em) { font-style: italic; opacity: 0.85; }
.md-body :deep(code) { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 11px; background: rgba(0,0,0,0.07); border-radius: 4px; padding: 1px 5px; }
.md-body :deep(a) { color: var(--color-primary); text-decoration: underline; }
.md-body :deep(blockquote) { border-left: 3px solid var(--color-primary); margin: 6px 0; padding: 4px 10px; opacity: 0.75; font-style: italic; }
.md-body :deep(hr) { border: none; border-top: 1px solid rgba(0,0,0,0.08); margin: 8px 0; }
.md-body :deep(.md-code-block) { margin: 8px 0; border-radius: 8px; overflow: hidden; border: 1px solid rgba(0,0,0,0.1); font-size: 11px; }
.md-body :deep(.md-code-header) { display: flex; align-items: center; justify-content: space-between; padding: 5px 10px; background: rgba(0,0,0,0.06); border-bottom: 1px solid rgba(0,0,0,0.08); }
.md-body :deep(.md-code-lang) { font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: lowercase; letter-spacing: 0.04em; }
.md-body :deep(.md-copy-btn) { font-size: 10px; font-weight: 600; color: var(--color-primary); background: none; border: none; cursor: pointer; padding: 0; opacity: 0.7; transition: opacity 0.15s; }
.md-body :deep(.md-copy-btn:hover) { opacity: 1; }
.md-body :deep(pre) { margin: 0; padding: 10px 12px; overflow-x: auto; background: rgba(0,0,0,0.04); }
.md-body :deep(pre code) { background: none; padding: 0; border-radius: 0; font-size: 11px; line-height: 1.6; }
.md-body :deep(.hljs-keyword) { color: #7b5cf0; }
.md-body :deep(.hljs-string) { color: #2d7a4f; }
.md-body :deep(.hljs-comment) { color: #9a9a9a; font-style: italic; }
.md-body :deep(.hljs-number) { color: #b07858; }
.md-body :deep(.hljs-function) { color: #4a7fb5; }
.md-body :deep(.hljs-title) { color: #4a7fb5; font-weight: 600; }
.md-body :deep(.hljs-attr) { color: #b07858; }
.md-body :deep(.hljs-built_in) { color: #5a9e88; }
.md-body :deep(.hljs-variable) { color: #1e2028; }

/* ── 迷你播放器 ── */
.mini-player {
  position: fixed; right: 28px; width: 316px;
  transition: bottom 0.28s cubic-bezier(0.34, 1.2, 0.64, 1);
  background: var(--panel-bg); backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(255,255,255,0.65); border-radius: 20px;
  box-shadow: var(--glass-shadow-lg); padding: 12px 14px 10px;
  z-index: 1002; display: flex; flex-direction: column; gap: 7px;
}
.mp-info { display: flex; align-items: center; gap: 7px; min-width: 0; }
.mp-name { font-size: 12px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.mp-bars { display: flex; align-items: flex-end; gap: 2px; height: 14px; flex-shrink: 0; }
.mp-bars i { display: block; width: 2.5px; border-radius: 99px; background: rgba(100,110,200,0.55); height: 4px; }
.mp-bars--playing i { animation: mp-eq 0.55s ease-in-out infinite alternate; }
.mp-bars--playing i:nth-child(1) { animation-duration: 0.55s; }
.mp-bars--playing i:nth-child(2) { animation-duration: 0.42s; animation-delay: 0.1s; }
.mp-bars--playing i:nth-child(3) { animation-duration: 0.65s; animation-delay: 0.05s; }
.mp-bars--playing i:nth-child(4) { animation-duration: 0.48s; animation-delay: 0.15s; }
@keyframes mp-eq { from { height: 3px; } to { height: 13px; } }
.mp-seek-row { display: flex; align-items: center; gap: 6px; }
.mp-time { font-size: 10px; color: var(--text-secondary); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.mp-track { flex: 1; height: 3px; border-radius: 99px; background: rgba(100,110,200,0.12); position: relative; cursor: pointer; }
.mp-track:hover .mp-thumb { opacity: 1; }
.mp-fill { height: 100%; border-radius: 99px; background: linear-gradient(to right, rgba(100,110,200,0.65), rgba(140,120,210,0.75)); pointer-events: none; }
.mp-thumb { position: absolute; top: 50%; transform: translate(-50%,-50%); width: 10px; height: 10px; border-radius: 50%; background: rgba(100,110,200,0.9); pointer-events: none; opacity: 0; transition: opacity 0.15s; }
.mp-btn--pin { width: 24px; height: 24px; border-radius: 6px; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; background: none; color: var(--text-secondary); transition: background 0.12s, color 0.12s; }
.mp-btn--pin svg { display: block; }
.mp-btn--pin:hover { background: rgba(100,110,200,0.12); color: rgba(100,110,200,0.9); }
.mp-btn--pinned { color: rgba(100,110,200,0.8); }
.mp-btn--pinned:hover { background: rgba(100,110,200,0.12); color: rgba(100,110,200,1); }
.mp-btn--close { width: 24px; height: 24px; border-radius: 6px; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; background: none; color: var(--text-secondary); transition: background 0.12s, color 0.12s; }
.mp-btn--close:hover { background: rgba(200,80,80,0.1) !important; color: rgba(200,80,80,0.8) !important; }
.mp-controls { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; }
.mp-btn { border: none; cursor: pointer; border-radius: 8px; display: flex; align-items: center; justify-content: center; transition: transform 0.15s, background 0.12s; }
.mp-btn--play { width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg, rgba(110,115,190,0.85), rgba(140,120,200,0.9)); color: white; justify-self: center; box-shadow: 0 3px 10px rgba(100,110,200,0.28), inset 0 1px 0 rgba(255,255,255,0.32); }
.mp-btn--play svg { display: block; }
.mp-btn--play:hover { transform: scale(1.08); }
.mp-btn--play:active { transform: scale(0.93); }
.mp-vol-group { display: flex; align-items: center; gap: 4px; justify-self: end; }
.mp-vol-btn { width: 22px; height: 22px; border: none; border-radius: 6px; background: none; color: var(--text-secondary); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.12s, color 0.12s; }
.mp-vol-btn:hover { background: rgba(0,0,0,0.07); color: var(--text-primary); }
.mp-vol-btn svg { display: block; }
.mp-vol-slider { width: 60px; height: 3px; cursor: pointer; accent-color: rgba(100,110,200,0.75); }
.mini-player-enter-active { transition: opacity 0.26s, transform 0.32s cubic-bezier(.22,1.12,.36,1); }
.mini-player-leave-active { transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(.55,0,1,.7); }
.mini-player-enter-from, .mini-player-leave-to { opacity: 0; transform: scale(0.05); }
</style>
