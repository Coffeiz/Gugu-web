<template>
  <!-- 播放器：固定=常驻，非固定=随聊天框显隐；
       v-if 条件含 open，聊天框打开时始终为 true，
       切换固定状态不触发 DOM 重建，无动画跳变 -->
  <Transition name="mini-player">
    <div v-if="audioStore.file && (miniPinned || open)" class="mini-player" :style="miniPlayerStyle" ref="playerRef">
      <div class="mp-info">
        <span class="mp-bars" :class="{ 'mp-bars--playing': barsPlaying }" ref="barsRef"><i v-for="n in 4" :key="n" /></span>
        <span class="mp-name">{{ audioStore.file.displayName }}.{{ audioStore.file.ext?.toLowerCase() }}</span>
        <button class="mp-btn mp-btn--pin" :class="{ 'mp-btn--pinned': miniPinned }"
                @click="miniPinned = !miniPinned" :title="miniPinned ? '取消固定' : '固定'">
          <PhPushPin v-if="miniPinned" :size="14" weight="fill" />
          <PhPushPinSlash v-else :size="14" weight="regular" />
        </button>
        <button class="mp-btn mp-btn--close" @click="audioStop" title="关闭">
          <PhX weight="bold" :size="13" />
        </button>
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

  <!-- 隐藏的 audio 元素 -->
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
  <button class="ai-fab" :class="{ 'ai-fab--playing': rippleActive }" ref="fabRef" @click="open = !open" title="咕咕">
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

  <!-- 聊天框 -->
  <Transition name="chat-popup">
    <div v-if="open" class="ai-popup" ref="popupRef">
      <div class="popup-header">
        <span class="popup-title">咕咕</span>
        <span class="popup-status">
          <em class="status-dot" />在线
        </span>
        <button class="popup-close" @click="open = false">
          <PhX weight="bold" :size="13" />
        </button>
      </div>

      <div class="popup-messages" ref="messagesEl">
        <div v-for="(msg, i) in messages" :key="i" :class="['msg', msg.role]">
          <div v-if="msg.role === 'ai'" class="msg-bubble md-body" v-html="renderMd(msg.text)" />
          <div v-else class="msg-bubble">{{ msg.text }}</div>
          <div class="msg-time">{{ msg.time }}</div>
        </div>
        <div v-if="activeTool" class="msg ai">
          <div class="msg-bubble tool-bubble">
            <span class="tool-spinner" />
            <span class="tool-label">{{ activeTool }}</span>
          </div>
        </div>
        <div v-else-if="thinking" class="msg ai">
          <div class="msg-bubble thinking">
            <span /><span /><span />
          </div>
        </div>
      </div>

      <div class="popup-input-row">
        <input
          v-model="inputText"
          placeholder="问问项目进度、截止日期…"
          @keydown.enter="send"
        />
        <button class="send-btn" @click="send" :disabled="streaming">
          <PhArrowRight v-if="!streaming" weight="bold" :size="13" />
          <PhStop       v-else            weight="fill" :size="13" />
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { marked } from 'marked'
import hljs from 'highlight.js'
import { useAudioStore } from '@/stores/audio'
import { PhPushPin, PhPushPinSlash, PhX, PhPlay, PhPause, PhSpeakerHigh, PhSpeakerLow, PhSpeakerSlash, PhArrowRight, PhStop } from '@phosphor-icons/vue'

const audioStore   = useAudioStore()
const audioEl      = ref(null)
const audioPlaying = ref(false)
const audioCurrent = ref(0)
const audioDuration = ref(0)

// ── 进度持久化 ──────────────────────────────────────────
function progKey() {
  return audioStore.file ? `audio_prog_${audioStore.file.id}` : null
}
function saveProgress() {
  const key = progKey()
  if (!key || !audioEl.value || !audioEl.value.duration) return
  const t = audioEl.value.currentTime
  const d = audioEl.value.duration
  if (t < d - 3) localStorage.setItem(key, t)
  else           localStorage.removeItem(key)
}
function restoreProgress() {
  const key = progKey()
  if (!key || !audioEl.value) return
  const saved = localStorage.getItem(key)
  localStorage.removeItem(key)  // 消费一次后立即删除，切歌回来不再恢复
  if (saved && +saved > 0) audioEl.value.currentTime = +saved
}

// 每次换歌时标记需要恢复
const needsRestore = ref(false)
watch(() => audioStore.file?.id, () => { needsRestore.value = true })

const audioSeekPct = computed(() =>
  audioDuration.value ? (audioCurrent.value / audioDuration.value) * 100 : 0
)

const fabSvgRef   = ref(null)
const rippleActive = ref(false)
const barsRef     = ref(null)
const barsPlaying = ref(false)

watch(audioPlaying, (playing) => {
  if (playing) {
    // 清除所有内联样式，让 CSS 动画接管
    barsRef.value?.querySelectorAll('i').forEach(bar => {
      bar.style.cssText = ''
    })
    barsPlaying.value = true
  } else {
    // 冻结每根条形当前高度，再过渡回静止高度
    const bars = barsRef.value?.querySelectorAll('i') ?? []
    bars.forEach(bar => {
      bar.style.height = getComputedStyle(bar).height
      bar.style.transition = 'none'
    })
    barsPlaying.value = false   // 移除 animation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bars.forEach(bar => {
          bar.style.transition = 'height 0.45s ease-out'
          bar.style.height = '4px'
        })
      })
    })
    setTimeout(() => {
      bars.forEach(bar => { bar.style.cssText = '' })
    }, 500)
  }
})
const spinningBack = ref(false)
let rippleTimeout  = null

watch(audioPlaying, (playing) => {
  if (playing) {
    clearTimeout(rippleTimeout)
    rippleActive.value = true
  } else {
    // 让当前波纹走完（最长一个周期 3.6s）再消失
    rippleTimeout = setTimeout(() => { rippleActive.value = false }, 3600)
  }
})

function onCanPlay() {
  audioEl.value.volume = audioVolume.value
  if (needsRestore.value) {
    needsRestore.value = false
    restoreProgress()
  }
  audioEl.value.play()
}
function onAudioPause() {
  audioPlaying.value = false
}
function onAudioEnded() {
  audioPlaying.value = false
  const key = progKey()
  if (key) localStorage.removeItem(key)
}

function audioToggle() {
  if (!audioEl.value) return
  audioPlaying.value ? audioEl.value.pause() : audioEl.value.play()
}

function audioStop() {
  audioEl.value?.pause()

  // 顺时针摆正：读取当前旋转角，过渡到 360deg（=0）
  const svgEl = fabSvgRef.value
  if (svgEl && audioStore.file) {
    const matrix = new DOMMatrix(getComputedStyle(svgEl).transform)
    const angle = Math.atan2(matrix.b, matrix.a) * (180 / Math.PI)
    const normalized = Math.round(((angle % 360) + 360) % 360)
    spinningBack.value = true          // 移除 CSS 动画，防止干扰过渡
    svgEl.style.transform = `rotate(${normalized}deg)`
    svgEl.style.transition = 'none'
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        svgEl.style.transition = 'transform 0.65s ease-out'
        svgEl.style.transform  = 'rotate(360deg)'
      })
    })
    setTimeout(() => {
      svgEl.style.transform  = ''
      svgEl.style.transition = ''
      spinningBack.value = false
    }, 750)
  }

  audioPlaying.value  = false
  audioCurrent.value  = 0
  audioDuration.value = 0
  audioStore.stop()
}

const VOL_KEY = 'gugu_audio_volume'
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
  const up   = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

marked.use({
  breaks: true,
  gfm: true,
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

function renderMd(text) {
  if (!text) return ''
  return marked.parse(text)
}

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

const open = ref(false)
const miniPinned = ref(localStorage.getItem('gugu_mini_pinned') !== 'false')
watch(miniPinned, v => localStorage.setItem('gugu_mini_pinned', v))
const fabRef = ref(null)
const popupRef = ref(null)
const playerRef = ref(null)

// 播放器定位在聊天框上方，观察聊天框高度
const chatPopupHeight = ref(370)  // 预估聊天框高度，首次打开 enter 动画 origin 正确
let popupRo = null

watch(open, async (v) => {
  if (v) {
    await nextTick()
    if (popupRef.value) {
      chatPopupHeight.value = popupRef.value.offsetHeight
      popupRo = new ResizeObserver(() => {
        chatPopupHeight.value = popupRef.value?.offsetHeight ?? 0
      })
      popupRo.observe(popupRef.value)
    }
  } else {
    popupRo?.disconnect(); popupRo = null
    // 保留高度值，让下次 enter 动画也能用正确的 transform-origin
  }
})

const miniPlayerStyle = computed(() => {
  // 聊天框打开时播放器在上方
  const bottom = open.value && chatPopupHeight.value
    ? 88 + chatPopupHeight.value + 8
    : 88
  // 让播放器的 transform-origin 指向 fab 圆心
  // 聊天框开：player.bottom = 88+height+8，fab.bottom = 53 → 差值 = height+43
  // 聊天框关：player.bottom = 88，fab.bottom = 53 → 差值 = 35
  const originY = (open.value && chatPopupHeight.value)
    ? chatPopupHeight.value + 43
    : 35
  return {
    bottom: `${bottom}px`,
    transformOrigin: `calc(100% - 25px) calc(100% + ${originY}px)`,
  }
})

function handleClickOutside(e) {
  if (!open.value) return
  if (fabRef.value?.contains(e.target)) return
  if (popupRef.value?.contains(e.target)) return
  if (playerRef.value?.contains(e.target)) return
  open.value = false
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside, true)
  window.addEventListener('beforeunload', saveProgress)
})
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside, true)
  window.removeEventListener('beforeunload', saveProgress)
})

const inputText = ref('')
const thinking = ref(false)
const streaming = ref(false)
const activeTool = ref('')   // 当前正在执行的工具名
const messagesEl = ref(null)
const sessionId = ref(null)

const now = () => {
  const d = new Date()
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

const messages = ref([
  { role: 'ai', text: '你好！我是咕咕，可以帮你查项目进度、搜索文件、查看截止日期和近期排期，随时问我吧 ✦', time: now() },
])

async function send() {
  const text = inputText.value.trim()
  if (!text || streaming.value) return
  messages.value.push({ role: 'user', text, time: now() })
  inputText.value = ''
  await scrollBottom()

  thinking.value = true
  streaming.value = true

  const token = localStorage.getItem('user_token') ?? ''
  let aiIdx = -1

  try {
    const res = await fetch(`${BASE_URL}/agent/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message: text, session_id: sessionId.value }),
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop()

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw) continue
        let evt
        try { evt = JSON.parse(raw) } catch { continue }

        if (evt.type === 'session_id') {
          sessionId.value = evt.session_id
        } else if (evt.type === 'tool_call') {
          thinking.value = false
          activeTool.value = evt.label || evt.name
          await scrollBottom()
        } else if (evt.type === 'tool_done') {
          activeTool.value = ''
          thinking.value = false
          await scrollBottom()
        } else if (evt.type === 'token') {
          thinking.value = false
          activeTool.value = ''
          if (aiIdx === -1) {
            messages.value.push({ role: 'ai', text: '', time: now() })
            aiIdx = messages.value.length - 1
          }
          messages.value[aiIdx].text += evt.content
          await scrollBottom()
        } else if (evt.type === 'done') {
          thinking.value = false
          activeTool.value = ''
        } else if (evt.type === 'error') {
          thinking.value = false
          activeTool.value = ''
          messages.value.push({ role: 'ai', text: evt.detail, time: now() })
          await scrollBottom()
        }
      }
    }

    if (aiIdx === -1) {
      messages.value.push({ role: 'ai', text: '收到，但没有收到回复，请稍后再试。', time: now() })
      await scrollBottom()
    }
  } catch (e) {
    thinking.value = false
    messages.value.push({ role: 'ai', text: `连接失败：${e.message}`, time: now() })
    await scrollBottom()
  } finally {
    thinking.value = false
    activeTool.value = ''
    streaming.value = false
  }
}

async function scrollBottom() {
  await nextTick()
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
}
</script>

<style scoped>
.ai-fab {
  position: fixed;
  bottom: 28px; right: 28px;
  isolation: isolate;
  width: 50px; height: 50px;
  border-radius: 50%;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border: none;
  cursor: pointer;
  z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 18px rgba(123,127,178,0.32), inset 0 1px 0 rgba(255,255,255,0.45);
  transition: transform 0.2s, box-shadow 0.2s;
}
.ai-fab:hover {
  transform: scale(1.08);
  box-shadow: 0 7px 24px rgba(123,127,178,0.42), inset 0 1px 0 rgba(255,255,255,0.5);
}

.ai-popup {
  position: fixed;
  bottom: 88px; right: 28px;
  width: 316px;
  background: rgba(242, 242, 248, 0.9);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 20px;
  box-shadow: var(--glass-shadow-lg);
  display: flex; flex-direction: column;
  z-index: 998;
  overflow: hidden;
}

/* 内嵌播放器（非固定，在聊天框顶部） */
.mp-inline {
  padding: 10px 13px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.5);
  background: rgba(123, 127, 178, 0.06);
  display: flex; flex-direction: column; gap: 7px;
}

.popup-header {
  display: flex; align-items: center; gap: 9px;
  padding: 13px 14px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.5);
}
.popup-title { font-size: 13px; font-weight: 700; flex: 1; }
.popup-status {
  font-size: 11px; color: var(--color-success);
  display: flex; align-items: center; gap: 4px;
}
.status-dot {
  display: inline-block; width: 6px; height: 6px;
  border-radius: 50%; background: var(--color-success);
}
.popup-close {
  width: 22px; height: 22px; border-radius: 6px; border: none; padding: 0;
  background: rgba(0,0,0,0.04); color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.popup-close svg { display: block; }
.popup-close:hover { background: rgba(200,80,80,0.1); color: rgba(200,80,80,0.8); }

.popup-messages {
  flex: 1; overflow-y: auto;
  padding: 12px 13px;
  display: flex; flex-direction: column; gap: 8px;
  max-height: 270px;
}

.msg { display: flex; flex-direction: column; }
.msg.user { align-items: flex-end; }
.msg.ai { align-items: flex-start; }

.msg-bubble {
  padding: 9px 13px;
  border-radius: 13px;
  font-size: 13px;
  line-height: 1.5;
  max-width: 88%;
}
.msg.ai .msg-bubble {
  background: rgba(255,255,255,0.5);
  border: 1px solid rgba(255,255,255,0.65);
  border-bottom-left-radius: 4px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
}
.msg.user .msg-bubble {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white;
  border-bottom-right-radius: 4px;
}
.msg-time { font-size: 10px; color: var(--text-secondary); margin-top: 3px; padding: 0 3px; }

/* 思考动画 */
.thinking {
  display: flex; gap: 4px; align-items: center;
  padding: 12px 16px;
}
.thinking span {
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: bounce 1.2s infinite;
  opacity: 0.6;
}
.thinking span:nth-child(2) { animation-delay: 0.2s; }
.thinking span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-5px); }
}

.popup-input-row {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 13px;
  border-top: 1px solid rgba(255,255,255,0.5);
  background: rgba(255,255,255,0.28);
}
.popup-input-row input {
  flex: 1; border: none; background: none;
  font-size: 13px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
}
.popup-input-row input::placeholder { color: var(--text-secondary); }
.send-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: transform 0.15s; flex-shrink: 0;
}
.send-btn svg { display: block; }
.send-btn:hover:not(:disabled) { transform: scale(1.1); }
.send-btn:disabled { opacity: 0.55; cursor: default; }

/* 弹出动画 */
.chat-popup-enter-active {
  transition: opacity 0.26s, transform 0.32s cubic-bezier(.22, 1.12, .36, 1);
  transform-origin: calc(100% - 25px) calc(100% + 35px);
}
.chat-popup-leave-active {
  transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(.55, 0, 1, .7);
  transform-origin: calc(100% - 25px) calc(100% + 35px);
}
.chat-popup-enter-from,
.chat-popup-leave-to { opacity: 0; transform: scale(0.05); }

/* ── 工具调用气泡 ── */
.tool-bubble {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; font-size: 12px;
  color: var(--color-primary); opacity: 0.85;
}
.tool-spinner {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid rgba(123,127,178,0.25);
  border-top-color: var(--color-primary);
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.tool-label { font-size: 11px; font-weight: 600; }

/* ── Markdown 渲染 ── */
.md-body { padding: 10px 13px; }
.md-body :deep(p) { margin: 0 0 8px; line-height: 1.6; }
.md-body :deep(p:last-child) { margin-bottom: 0; }
.md-body :deep(h1),.md-body :deep(h2),.md-body :deep(h3) {
  font-weight: 700; margin: 10px 0 6px; line-height: 1.3;
}
.md-body :deep(h1) { font-size: 14px; }
.md-body :deep(h2) { font-size: 13px; }
.md-body :deep(h3) { font-size: 12px; }
.md-body :deep(ul),.md-body :deep(ol) { margin: 4px 0 8px 16px; padding: 0; }
.md-body :deep(li) { margin-bottom: 3px; line-height: 1.5; }
.md-body :deep(strong) { font-weight: 700; }
.md-body :deep(em) { font-style: italic; opacity: 0.85; }
.md-body :deep(code) {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px; background: rgba(0,0,0,0.07);
  border-radius: 4px; padding: 1px 5px;
}
.md-body :deep(a) { color: var(--color-primary); text-decoration: underline; }
.md-body :deep(blockquote) {
  border-left: 3px solid var(--color-primary);
  margin: 6px 0; padding: 4px 10px;
  opacity: 0.75; font-style: italic;
}
.md-body :deep(hr) { border: none; border-top: 1px solid rgba(0,0,0,0.08); margin: 8px 0; }

/* 代码块 */
.md-body :deep(.md-code-block) {
  margin: 8px 0; border-radius: 8px; overflow: hidden;
  border: 1px solid rgba(0,0,0,0.1);
  font-size: 11px;
}
.md-body :deep(.md-code-header) {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 10px;
  background: rgba(0,0,0,0.06);
  border-bottom: 1px solid rgba(0,0,0,0.08);
}
.md-body :deep(.md-code-lang) {
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: lowercase; letter-spacing: 0.04em;
}
.md-body :deep(.md-copy-btn) {
  font-size: 10px; font-weight: 600; color: var(--color-primary);
  background: none; border: none; cursor: pointer; padding: 0;
  opacity: 0.7; transition: opacity 0.15s;
}
.md-body :deep(.md-copy-btn:hover) { opacity: 1; }
.md-body :deep(pre) {
  margin: 0; padding: 10px 12px; overflow-x: auto;
  background: rgba(0,0,0,0.04);
}
.md-body :deep(pre code) {
  background: none; padding: 0; border-radius: 0;
  font-size: 11px; line-height: 1.6;
}

/* ── 迷你播放器 ── */
.mini-player {
  position: fixed;
  right: 28px;
  width: 316px;
  transition: bottom 0.28s cubic-bezier(0.34, 1.2, 0.64, 1);
  background: rgba(242, 242, 248, 0.9);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 20px;
  box-shadow: var(--glass-shadow-lg);
  padding: 12px 14px 10px;
  z-index: 999;
  display: flex; flex-direction: column; gap: 7px;
}

.mp-info {
  display: flex; align-items: center; gap: 7px;
  min-width: 0;
}
.mp-name {
  font-size: 12px; font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1;
}

/* 均衡器小图标 */
.mp-bars {
  display: flex; align-items: flex-end; gap: 2px;
  height: 14px; flex-shrink: 0;
}
.mp-bars i {
  display: block; width: 2.5px; border-radius: 99px;
  background: rgba(100, 110, 200, 0.55);
  height: 4px;
}
.mp-bars--playing i { animation: mp-eq 0.55s ease-in-out infinite alternate; }
.mp-bars--playing i:nth-child(1) { animation-duration: 0.55s; }
.mp-bars--playing i:nth-child(2) { animation-duration: 0.42s; animation-delay: 0.1s; }
.mp-bars--playing i:nth-child(3) { animation-duration: 0.65s; animation-delay: 0.05s; }
.mp-bars--playing i:nth-child(4) { animation-duration: 0.48s; animation-delay: 0.15s; }
@keyframes mp-eq { from { height: 3px; } to { height: 13px; } }

/* 进度条 */
.mp-seek-row {
  display: flex; align-items: center; gap: 6px;
}
.mp-time {
  font-size: 10px; color: var(--text-secondary);
  font-variant-numeric: tabular-nums; flex-shrink: 0;
}
.mp-track {
  flex: 1; height: 3px; border-radius: 99px;
  background: rgba(100, 110, 200, 0.12);
  position: relative; cursor: pointer;
}
.mp-track:hover .mp-thumb { opacity: 1; }
.mp-fill {
  height: 100%; border-radius: 99px;
  background: linear-gradient(to right, rgba(100, 110, 200, 0.65), rgba(140, 120, 210, 0.75));
  pointer-events: none;
}
.mp-thumb {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 10px; height: 10px; border-radius: 50%;
  background: rgba(100, 110, 200, 0.9);
  pointer-events: none; opacity: 0; transition: opacity 0.15s;
}

/* 关闭按钮（在 info 行右侧） */
.mp-btn--pin {
  width: 22px; height: 22px; border-radius: 6px; border: none;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0;
  background: rgba(0,0,0,0.04); color: var(--text-secondary);
  transition: background 0.12s, color 0.12s;
}
.mp-btn--pin svg { display: block; }
.mp-btn--pin:hover { background: rgba(100,110,200,0.12); color: rgba(100,110,200,0.9); }
.mp-btn--pinned { color: rgba(100,110,200,0.8); background: rgba(100,110,200,0.1); }
.mp-btn--pinned:hover { background: rgba(100,110,200,0.18); color: rgba(100,110,200,1); }

.mp-btn--close {
  width: 22px; height: 22px; border-radius: 6px; border: none;
  background: rgba(0,0,0,0.04); color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.mp-btn--close svg { display: block; }
.mp-btn--close:hover { background: rgba(200,80,80,0.1); color: rgba(200,80,80,0.8); }

/* 控制行：三列 grid，左右等宽，播放居中 */
.mp-controls {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 0;
}
.mp-btn {
  border: none; cursor: pointer; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  transition: transform 0.15s, background 0.12s;
}
.mp-btn--play {
  width: 34px; height: 34px; border-radius: 50%;
  background: linear-gradient(135deg, rgba(110,115,190,0.85), rgba(140,120,200,0.9));
  color: white; justify-self: center;
  box-shadow: 0 3px 10px rgba(100,110,200,0.28),
              inset 0 1px 0 rgba(255,255,255,0.32);
}
.mp-btn--play svg { display: block; }
.mp-btn--play:hover  { transform: scale(1.08); box-shadow: 0 5px 14px rgba(100,110,200,0.38), inset 0 1px 0 rgba(255,255,255,0.38); }
.mp-btn--play:active { transform: scale(0.93); }

/* 音量组（右列，右对齐） */
.mp-vol-group {
  display: flex; align-items: center; gap: 4px;
  justify-self: end;
}
.mp-vol-spacer { /* 左侧占位，宽度由 grid 1fr 决定 */ }
.mp-vol-btn {
  width: 22px; height: 22px; border: none; border-radius: 6px;
  background: rgba(0,0,0,0.04); color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.mp-vol-btn:hover { background: rgba(0,0,0,0.07); color: var(--text-primary); }
.mp-vol-btn svg { display: block; }
.mp-vol-slider {
  width: 60px; height: 3px; cursor: pointer;
  accent-color: rgba(100, 110, 200, 0.75);
}

/* 动画 */
.mini-player-enter-active { transition: opacity 0.26s, transform 0.32s cubic-bezier(.22, 1.12, .36, 1); }
.mini-player-leave-active { transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(.55, 0, 1, .7); }
/* transform-origin 由 miniPlayerStyle 内联设置，始终指向 fab 圆心 */
.mini-player-enter-from,
.mini-player-leave-to { opacity: 0; transform: scale(0.05); }

/* fab 播放中：图标旋转 + 外圈脉冲 */
.ai-fab svg {
  position: relative;
  z-index: 1; /* 让图标浮在 ::before / ::after 波纹之上 */
}
.ai-fab-spin {
  animation: fab-spin 8s linear infinite;
  transform-origin: center;
}
@keyframes fab-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
.ai-fab--playing::before,
.ai-fab--playing::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(123, 127, 178, 0.75);
  pointer-events: none;
  animation: fab-ripple 3.6s ease-out infinite;
}
.ai-fab--playing::after {
  animation-delay: 1.8s;
}
@keyframes fab-ripple {
  0%   { transform: scale(0.4); opacity: 0.8; }
  100% { transform: scale(1.55); opacity: 0; }
}

/* ── highlight.js 配色（适配亮色气泡） ── */
.md-body :deep(.hljs-keyword)  { color: #7b5cf0; }
.md-body :deep(.hljs-string)   { color: #2d7a4f; }
.md-body :deep(.hljs-comment)  { color: #9a9a9a; font-style: italic; }
.md-body :deep(.hljs-number)   { color: #b07858; }
.md-body :deep(.hljs-function) { color: #4a7fb5; }
.md-body :deep(.hljs-title)    { color: #4a7fb5; font-weight: 600; }
.md-body :deep(.hljs-attr)     { color: #b07858; }
.md-body :deep(.hljs-built_in) { color: #5a9e88; }
.md-body :deep(.hljs-variable) { color: #1e2028; }
</style>
