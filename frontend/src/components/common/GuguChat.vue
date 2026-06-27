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
         :class="{ 'ai-fab-spin': audioStore.file && !spinningBack, 'ai-fab--typing': fabJumping }"
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
    <div v-if="open" class="chat-window" :class="{ 'win-grow': streaming && !expanded }" :style="windowStyle" ref="windowRef"
      @dragenter="onChatDragEnter" @dragover="onChatDragOver" @dragleave="onChatDragLeave" @drop="onChatDrop">

      <!-- 拖入遮罩（覆盖整个窗口，大小窗通用）-->
      <Transition name="chat-drop-fade">
        <div v-if="isChatDragging" class="chat-drop-overlay">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 16V6M8 10l4-4 4 4"/><path d="M5 19h14"/>
          </svg>
          <span>松开以添加附件</span>
        </div>
      </Transition>


      <!-- 侧边栏（仅大窗） -->
      <div v-if="expanded" class="exp-sidebar panel-left">
        <div class="exp-sidebar-header">
          <span class="exp-sidebar-title">咕咕</span>
        </div>
        <div class="exp-sidebar-divider"></div>
        <div class="exp-session-list">
          <!-- IM 平台：飞书 / QQ，可展开抽屉。未接入 → 扫码连接；接入后 → 该平台会话 -->
          <div v-for="p in IM_PLATFORMS" :key="p.key" class="im-plat">
            <button class="im-plat-head" :class="{ open: imOpen[p.key] }" @click="toggleImPlatform(p.key)">
              <svg class="im-plat-chev" :class="{ open: imOpen[p.key] }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
              <span class="im-plat-name">{{ p.label }}</span>
              <span class="im-plat-badge" :class="{ on: botsOf(p.key).length }">{{ botsOf(p.key).length ? '已接入' : '未接入' }}</span>
            </button>
            <div v-show="imOpen[p.key]" class="im-plat-body">
              <!-- 已接入 → 该平台会话抽屉 -->
              <template v-if="botsOf(p.key).length">
                <div v-for="s in imSessionsOf(p.key)" :key="s.id"
                  class="exp-session-item" :class="{ active: s.id === sessionId }" @click="loadSession(s.id)">
                  <span class="exp-session-title">{{ s.title }}</span>
                  <button class="exp-session-del" @click.stop="deleteSession(s.id)" title="删除"><PhTrash :size="12" weight="bold" /></button>
                </div>
                <div v-if="!imSessionsOf(p.key).length" class="exp-session-empty">暂无对话</div>
              </template>
              <!-- 未接入 → 扫码连接 + 二维码抽屉 -->
              <template v-else>
                <div v-if="connect && connect.platform === p.key" class="im-qr-box">
                  <canvas :ref="setConnectCanvas" class="im-qr-canvas"></canvas>
                  <div class="im-qr-hint">{{ connectHint }}</div>
                  <button class="im-qr-cancel" @click="cancelImConnect">取消</button>
                </div>
                <template v-else>
                  <button class="im-connect-btn" :disabled="connecting === p.key" @click="startImConnect(p.key)">
                    {{ connecting === p.key ? '生成中…' : '扫码连接' }}
                  </button>
                  <div v-if="connectErr && connecting !== p.key" class="im-qr-err">{{ connectErr }}</div>
                </template>
              </template>
            </div>
          </div>

          <!-- 网页对话 -->
          <div v-if="webSessions.length" class="exp-group-divider"></div>
          <div
            v-for="s in webSessions" :key="s.id"
            class="exp-session-item"
            :class="{ active: s.id === sessionId }"
            @click="loadSession(s.id)"
          >
            <span class="exp-session-title">{{ s.title }}</span>
            <button class="exp-session-del" @click.stop="deleteSession(s.id)" title="删除">
              <PhTrash :size="12" weight="bold" />
            </button>
          </div>
        </div>
        <div class="exp-sidebar-divider" style="margin: 0 12px"></div>
        <div class="exp-new-session-wrap">
          <button class="exp-new-session-btn" @click="newSession">
            <PhPencilSimple weight="bold" :size="13" />
            新对话
          </button>
        </div>
      </div>

      <!-- 主区域（始终存在，消息列表永不销毁） -->
      <div class="chat-main" :class="{ 'is-expanded': expanded, 'is-resizing': resizing }">
        <div class="chat-header">
          <span class="chat-title">{{ expanded ? currentSessionTitle : '咕咕' }}</span>
          <span class="popup-status"><em class="status-dot" />在线</span>
          <div class="btn-group">
            <button v-if="!expanded" class="popup-icon-btn" @click="enterExpanded" title="展开">
              <PhArrowsOut weight="bold" :size="13" />
            </button>
            <button v-if="expanded" class="exp-icon-btn" @click="exitExpanded" title="收起">
              <PhArrowsIn weight="bold" :size="14" />
            </button>
            <button class="popup-close-btn" @click="open = false; expanded = false">
              <PhX weight="bold" :size="13" />
            </button>
          </div>
        </div>

        <!-- 单一消息列表 -->
        <div class="chat-messages" ref="messagesEl">
          <div v-for="msg in messages" :key="msg.id" :class="['msg', msg.role]" :data-db-id="msg.dbId || ''">
            <div v-if="msg.role === 'ai' && (msg.text?.trim() || msg.streaming)" class="msg-bubble md-body"><MarkdownView :html="msg.streaming ? renderMdStream(msg.text) : msg.html" /></div>
            <div v-else-if="msg.text" class="msg-bubble">{{ msg.text }}</div>
            <div v-if="msg.files && msg.files.length" class="msg-files">
              <div v-for="f in msg.files" :key="f.file_id" class="msg-file" @click="openFileFromChat(f)" :title="canPreview(f) ? '点击预览' : '点击下载'">
                <span class="msg-file-ext">
                  {{ (f.ext || 'file').toUpperCase().slice(0, 4) }}
                  <template v-if="isImageFile(f)">
                    <img v-if="f._thumbUrl" class="msg-file-thumb" :src="f._thumbUrl"
                      draggable="false" alt="" @error="$event.target.remove()" />
                    <img v-else class="msg-file-thumb" v-lazy-thumb="f.file_id || f.attach_id"
                      decoding="async" draggable="false" alt="" @error="$event.target.remove()" />
                  </template>
                </span>
                <span class="msg-file-info">
                  <span class="msg-file-name">{{ f.name }}.{{ f.ext }}</span>
                  <span class="msg-file-meta">{{ fmtSize(f.size_bytes) }} · {{ canPreview(f) ? '预览' : '下载' }}</span>
                </span>
                <svg class="msg-file-dl" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>
              </div>
            </div>
            <div class="msg-footer">
              <span class="msg-time">{{ msg.time }}</span>
              <button class="msg-copy-btn" @click="copyMsg(msg)" title="复制">
                <PhCheck v-if="copiedId === msg.id" :size="11" weight="bold" />
                <PhCopy  v-else :size="11" />
              </button>
            </div>
          </div>
          <!-- 状态指示：动画队列驱动，:key 让每条重建以重放入场动画；文字走打字机、点点为默认思考态 -->
          <div v-if="statusKind" class="msg ai">
            <div :key="statusSeq" class="msg-bubble status-pop"
                 :class="statusKind === 'dots' ? 'thinking' : 'tool-bubble'">
              <template v-if="statusKind === 'dots'"><span /><span /><span /></template>
              <template v-else>
                <span class="tool-spinner" />
                <span class="tool-label">{{ statusTyped }}</span>
              </template>
            </div>
          </div>
          <div class="msg-sentinel" />
        </div>

        <!-- 输入框 -->
        <div v-if="pendingAtt.length || attUploading" class="chat-att-row">
          <div v-for="a in pendingAtt" :key="a.attach_id" class="chat-att-chip">
            <span class="chat-att-name">{{ a.name }}.{{ a.ext }}</span>
            <button class="chat-att-x" @click="removeAtt(a)" title="移除">×</button>
          </div>
          <span v-if="attUploading" class="chat-att-chip att-up">上传中…</span>
        </div>
        <div class="chat-input-row">
          <button class="att-btn" @click="pickFile" title="添加附件">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7l-5.5 5.5a2.5 2.5 0 0 1-3.5-3.5L9 3.5a1.5 1.5 0 0 1 2 2L5.5 11"/></svg>
          </button>
          <input ref="fileInput" type="file" multiple style="display:none" @change="onFilePicked" />
          <textarea
            v-model="inputText"
            ref="expInputEl"
            placeholder="问问项目进度、截止日期…"
            rows="1"
            @compositionstart="isComposing = true"
            @compositionend="isComposing = false"
            @keydown.enter.exact.prevent="!isComposing && send()"
            @input="autoResize"
          />
          <button class="send-btn" :class="{ 'exp-send-btn': expanded }" @click="streaming ? stopStreaming() : send()">
            <PhArrowRight v-if="!streaming" weight="bold" :size="expanded ? 14 : 13" />
            <PhStop       v-else            weight="fill"  :size="expanded ? 14 : 13" />
          </button>
        </div>
      </div>

    </div>
  </Transition>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import QRCode from 'qrcode'
import { marked } from 'marked'
import hljs from 'highlight.js'
import { useAudioStore } from '@/stores/audio'
import { useProjectStore } from '@/stores/projects'
import { useLiveStore } from '@/stores/live'
import { useUiStore } from '@/stores/ui'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import { agentApi, filesApi, trackApi, userBotsApi, qqConnectApi, feishuConnectApi } from '@/services/api'
import { getGreeting, greeting, prefetchGreeting } from '@/composables/useGreeting'
import { uploadSignal, calendarSignal } from '@/services/cache'
import { getThumb, getCachedThumb, getThumbUrl, getCachedThumbUrl } from '@/composables/useThumbCache'
import MarkdownView from '@/components/common/MarkdownView.vue'

const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1'
import {
  PhPushPin, PhPushPinSlash, PhX, PhPlay, PhPause,
  PhSpeakerHigh, PhSpeakerLow, PhSpeakerSlash,
  PhArrowRight, PhStop, PhArrowsOut, PhArrowsIn,
  PhPencilSimple, PhTrash, PhCopy, PhCheck,
} from '@phosphor-icons/vue'

const SMALL_W   = 360
const SMALL_H   = 360
const SIDEBAR_W = 220

const audioStore    = useAudioStore()
const projectStore  = useProjectStore()
const liveStore     = useLiveStore()
const uiStore       = useUiStore()

// 顶栏全局搜索点「对话」结果：打开聊天面板并切到该会话
watch(() => uiStore.pendingChatSession, async (id) => {
  if (!id) return
  open.value = true
  await loadSession(id)
  const msgId = uiStore.pendingChatMessageId
  uiStore.pendingChatSession = null
  uiStore.pendingChatMessageId = null
  if (msgId) _flashChatMessage(msgId)
})

function _flashChatMessage(dbId) {
  setTimeout(() => {
    const el = messagesEl.value?.querySelector(`[data-db-id="${dbId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('msg-search-flash')
    setTimeout(() => el.classList.remove('msg-search-flash'), 1800)
  }, 200)
}

// 实时：IM（飞书/QQ）来了新消息 → 刷新会话列表，新会话/新标题即时出现
watch(() => liveStore.rev.sessions, () => fetchSessions())

// 消息级实时：若这条 IM 消息属于当前打开的会话，直接把「这一来一回」追加进气泡，
// 不必整列表/整会话 refetch（只传增量）。非当前会话则上面刷新列表即可。
watch(() => liveStore.sessionEvent, async (e) => {
  if (!e || !e.appended?.length || e.session_id !== sessionId.value) return
  for (const m of e.appended) {
    const isAi = m.role === 'assistant'
    messages.value.push({
      id: mkid(),
      role: isAi ? 'ai' : m.role,
      text: m.text || '',
      html: isAi ? renderMd(m.text || '') : null,
      files: (m.files && m.files.length) ? m.files : undefined,
      time: now(),
    })
  }
  await nextTick(); await scrollBottom()
})

// 工具名 → 受影响数据域，咕咕操作后据此刷新前端，免手动刷新页面
// 与后端 RESOURCE_BY_TOOL（app/core/events.py）保持一致——漏了哪个工具，对应视图就不会实时刷新。
const _PROJECT_TOOLS = new Set(['create_project','update_project','delete_project','archive_project','update_stage','set_priority','set_color','add_stage','remove_stage','rename_stage','add_todo','remove_todo','set_stages','update_todo'])
const _CALENDAR_TOOLS = new Set(['create_event','update_event','delete_event'])
const _FILE_TOOLS = new Set(['edit_file','create_document','rename_file','move_items','copy_file','create_folder','delete_file','rename_folder','delete_folder','save_uploaded_file','restore_file','permanent_delete'])

async function refreshAfterTools(usedTools) {
  if (!usedTools.size) return
  const has = (set) => [...usedTools].some(t => set.has(t))
  try {
    if (has(_PROJECT_TOOLS)) await projectStore.fetchProjects()
    if (has(_CALENDAR_TOOLS)) { calendarSignal.value++; projectStore.fetchUpcomingCalEvents?.() }
    // 文件：刷文件管理器（uploadSignal）+ 确定性 bump rev.files 让打开的预览窗重载。
    // 实时 SSE（live.js）是 best-effort（dev 重启 / pub-sub 竞态会丢事件），靠这条回合末兜底保证稳定刷新。
    if (has(_FILE_TOOLS)) { uploadSignal.value++; liveStore.bump('files') }
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
    // 关掉删除线渲染：口语里 ~ 很常见（好的~、稍等~），~~ 叠出来会被 GFM 当删除线；
    // 伙伴语气几乎不需要真删除线，把 ~~x~~ 直接渲染成纯文本 x（保留表格等其它 GFM 能力）。
    r.del = (t) => (t && t.text) || ''
    r.code = ({ text, lang }) => {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(text, { language }).value
      const label = lang || 'code'
      return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${label}</span><button class=\"md-copy-btn\" onclick=\"(function(b){var t=b.closest('.md-code-block').querySelector('code').innerText;var done=function(){b.textContent='已复制 ✓';setTimeout(function(){b.textContent='复制'},1200)};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done).catch(done)}else{var a=document.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(e){}a.remove();done()}})(this)\">复制</button></div><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`
    }
    return r
  })(),
})
function renderMd(text) { return text ? marked.parse(text) : '' }

// 流式渲染专用：补全未闭合的代码围栏，避免 marked 把半段代码块解析成残缺 HTML
// 单条缓存：同一帧内 text 未变则直接返回上次结果，避免重复解析
let _mdStreamCache = null
function renderMdStream(text) {
  if (!text) return ''
  if (_mdStreamCache?.text === text) return _mdStreamCache.html
  const fences = (text.match(/^```/gm) || []).length
  const patched = fences % 2 === 1 ? text + '\n```' : text
  const html = marked.parse(patched)
  _mdStreamCache = { text, html }
  return html
}

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

// ── 窗口状态 ────────────────────────────────────────────
const open       = ref(false)
const expanded   = ref(false)
const resizing   = ref(false)   // 展开/缩小动画期间：关 backdrop-filter、停跟随，降卡顿
let _resizeTimer = null
function _markResizing() {
  resizing.value = true
  if (_resizeTimer) clearTimeout(_resizeTimer)
  _resizeTimer = setTimeout(() => { resizing.value = false }, 420)
}
const miniPinned = ref(localStorage.getItem('gugu_mini_pinned') !== 'false')
watch(miniPinned, v => localStorage.setItem('gugu_mini_pinned', v))

const fabRef      = ref(null)
const windowRef   = ref(null)
const playerRef   = ref(null)
const expInputEl  = ref(null)
const messagesEl  = ref(null)

// 视口尺寸，用于计算小窗绝对坐标
const vw = ref(window.innerWidth)
const vh = ref(window.innerHeight)
function onResize() { vw.value = window.innerWidth; vh.value = window.innerHeight }

// 小窗高度跟随内容：直接用 messages 内容真实高度（scrollHeight，天然含所有气泡 + gap + padding）
//   算窗口该多高，到 maxH 封顶后内部滚动。比旧的「按滚动位移反推」稳——旧法窗口一增高、内容
//   不再溢出，位移 delta 就归零、停止增长（表现为生成到一半窗口不再长高）。
const contentH = ref(SMALL_H)   // 窗口高度（= SMALL_H + 相对基线的新增内容高度），驱动 smallH
let _baseScrollH = 0            // 打开/切会话时的内容高度基线：窗口只随「相对基线新增的内容」长高，
                               // 不一次跳到全部历史高度（否则历史多时一发消息就瞬间全高）

const smallH = computed(() => {
  const maxH = Math.min(vh.value * 0.75, vh.value - 88 - 16)
  return Math.min(maxH, Math.max(SMALL_H, contentH.value))
})

// 内容相对基线增高多少，窗口就增高多少（含用户气泡 + AI 气泡）；到 maxH 封顶后内部滚动
function syncSmallH() {
  const el = messagesEl.value
  if (!el || expanded.value || resizing.value) return
  contentH.value = SMALL_H + Math.max(0, el.scrollHeight - _baseScrollH)
}

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
  // 展开态层级低于咕咕窗口（10001），使播放器显示在窗口后方
  const zIndex = expanded.value ? 10000 : 10002
  return { bottom: `${bottom}px`, transformOrigin: origin, zIndex }
})

// 通知气泡锚点：让通知始终浮在「小窗 / 音乐播放器」上方，不与之重叠。
// 关闭态：浮在 fab（或其上的播放器）上方；小窗态：浮在小窗（及其上播放器）上方；
// 放大态：窗口几乎占满，播放器已缩回 fab，通知仍回到 fab 上方默认位。
const MP_EST_H = 112   // 播放器外高估值（含 padding，用于堆叠避让）
const notifyAnchor = computed(() => {
  const hasPlayer = !!audioStore.file && (miniPinned.value || open.value)
  if (open.value && !expanded.value) {
    const winTop = 88 + smallH.value                          // 小窗顶沿（距视口底）
    return (hasPlayer ? winTop + 8 + MP_EST_H : winTop) + 12
  }
  return hasPlayer ? 88 + MP_EST_H + 12 : 90
})
watch(notifyAnchor, v => { uiStore.chatNotifyAnchor = v }, { immediate: true })

// 通知气泡开合的缩放原点（与音乐播放器同逻辑）：
// 直接浮在咕咕球上方（聊天关闭且无播放器）→ 从球圆心缩放；被小窗/播放器顶高 → 从自身中心缩放。
const notifyOrigin = computed(() => {
  const hasPlayer = !!audioStore.file && (miniPinned.value || open.value)
  if (!open.value && !hasPlayer) {
    return `calc(100% - 25px) calc(100% + ${notifyAnchor.value - 53}px)`
  }
  return '50% 50%'
})
watch(notifyOrigin, v => { uiStore.chatNotifyOrigin = v }, { immediate: true })

async function toggleOpen() {
  open.value = !open.value
  if (open.value) {
    if (!expanded.value) contentH.value = SMALL_H
    trackApi.track('chat_open').catch(() => {})
    await nextTick()
    atBottom.value = true; stick.value = true
    _baseScrollH = messagesEl.value?.scrollHeight || 0   // 基线 = 打开时的历史内容高度
    if (messagesEl.value) scrollToBottom(messagesEl.value)
  }
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', saveProgress)
  // 拉一次状态显示名（目前只用到「思考中」候选文案；失败就保持默认三个点）
  agentApi.getUiLabels?.().then(r => {
    thinkingLabels.value = Array.isArray(r?.thinking) ? r.thinking : (r?.thinking ? [r.thinking] : [])
  }).catch(() => {})
  // 刷新后恢复上次会话（sessionStorage 仍在则拉回那段对话；失败则当作新对话并清除存档）
  const saved = sessionStorage.getItem(SESSION_KEY)
  if (saved) {
    loadSession(Number(saved)).then(() => {
      if (sessionId.value !== Number(saved)) sessionStorage.removeItem(SESSION_KEY)
    })
  } else {
    // 全新对话（无可恢复会话）才需要默认问候 → 此刻后台生成；刷新停在老会话时不空跑。
    prefetchGreeting()
  }
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('beforeunload', saveProgress)
})

// ── 对话状态 ────────────────────────────────────────────
const inputText      = ref('')
const isComposing    = ref(false)
const thinkingLabels = ref([])   // 「思考中」候选文案（后台「状态命名」_thinking，可多个 | 分隔；空=三个点）
const streaming      = ref(false)
// 状态指示走「动画队列」：SSE 事件入队、逐个播放（文字打字机入场），切换太快也排队、不抢拍、不闪。
const statusKind     = ref('')   // '' | 'text'（工具/自定义思考，打字机）| 'dots'（默认思考三点）
const statusTyped    = ref('')   // 当前显示的文字（打字机进度；dots 时为空）
const statusSeq      = ref(0)    // 每播一条 +1，用作 :key 让气泡重建、重放入场动画
const isTypingText   = computed(() => streaming.value && !statusKind.value)
const fabJumping     = ref(false)
watch(isTypingText, v => {
  if (v) { fabJumping.value = true; setTimeout(() => { fabJumping.value = false }, 350) }
})

// ── 状态动画队列 ───────────────────────────────────────────
const STATUS_TYPE_MS = 26    // 打字机每字间隔
const STATUS_HOLD_MS = 160   // 打完后的最短驻留，避免一闪而过
const STATUS_DOTS_MS = 420   // 三点状态的最短驻留
let _statusQ = []
let _statusBusy = false
let _typeTimer = null

function _thinkingItem() {
  // 「思考中」：设了自定义文案就随机取一条走打字机；否则三个点
  const c = thinkingLabels.value
  return c.length ? { kind: 'text', label: c[Math.floor(Math.random() * c.length)] } : { kind: 'dots' }
}

function clearStatus() {       // 立即清空并打断队列（回复开始/结束/切会话）
  _statusQ = []
  _statusBusy = false
  if (_typeTimer) { clearInterval(_typeTimer); _typeTimer = null }
  statusKind.value = ''; statusTyped.value = ''
}

function enqueueStatus(item) { // item: {kind:'text'|'dots'|'hide', label?}
  _statusQ.push(item)
  _pumpStatus()
}

function _pumpStatus() {
  if (_statusBusy) return
  const next = _statusQ.shift()
  if (!next) return
  _statusBusy = true
  _playStatus(next).then(() => { _statusBusy = false; _pumpStatus() })
}

function _playStatus(item) {
  return new Promise(resolve => {
    if (item.kind === 'hide') { statusKind.value = ''; statusTyped.value = ''; resolve(); return }
    statusSeq.value++          // 触发入场动画重放（:key 变化 → 气泡重建）
    statusKind.value = item.kind
    statusTyped.value = ''
    scrollBottom()
    if (item.kind === 'dots') { setTimeout(resolve, STATUS_DOTS_MS); return }
    const full = item.label || ''
    if (!full) { resolve(); return }
    let i = 0
    if (_typeTimer) clearInterval(_typeTimer)
    _typeTimer = setInterval(() => {
      statusTyped.value = full.slice(0, ++i)
      if (i >= full.length) { clearInterval(_typeTimer); _typeTimer = null; setTimeout(resolve, STATUS_HOLD_MS) }
    }, STATUS_TYPE_MS)
  })
}
const sessionId      = ref(null)
const abortCtrl      = ref(null)
const pendingQueue   = ref([])   // 生成中发的消息，排队等流式结束后接着发
const pendingAtt   = ref([])     // 待发送的聊天附件（已上传暂存）
const attUploading = ref(false)
const fileInput    = ref(null)
function pickFile() { fileInput.value && fileInput.value.click() }
async function uploadAttachFiles(files) {
  if (!files.length) return
  attUploading.value = true
  try {
    for (const file of files) {
      try {
        const meta = await agentApi.uploadAttachment(file)
        // 图片附件：本地 objectURL 立即出预览（暂存附件无 file_id，取不到服务端缩略图）
        if (_IMG_EXTS.has((meta.ext || '').toLowerCase())) meta._thumbUrl = URL.createObjectURL(file)
        pendingAtt.value.push(meta)
      } catch (err) {
        messages.value.push({ id: mkid(), role: 'ai', text: '附件上传失败 😵 ' + (err && err.message || ''), time: now() })
      }
    }
  } finally { attUploading.value = false }
}
async function onFilePicked(e) {
  const files = [...(e.target.files || [])]
  e.target.value = ''
  await uploadAttachFiles(files)
}

// ── 拖入文件添加附件（大小窗都支持）──
const chatDrag = ref(0)
const isChatDragging = computed(() => chatDrag.value > 0)
function _dragHasFiles(e) { return [...(e.dataTransfer?.types || [])].includes('Files') }
function onChatDragEnter(e) { if (_dragHasFiles(e)) { e.preventDefault(); chatDrag.value++ } }
function onChatDragOver(e)  { if (_dragHasFiles(e)) e.preventDefault() }
function onChatDragLeave()  { if (chatDrag.value > 0) chatDrag.value-- }
function onChatDrop(e) {
  if (!_dragHasFiles(e)) return
  e.preventDefault()
  chatDrag.value = 0
  uploadAttachFiles([...(e.dataTransfer?.files || [])])
}
function removeAtt(a) {
  if (a._thumbUrl) URL.revokeObjectURL(a._thumbUrl)   // 未发送即移除，回收 objectURL
  pendingAtt.value = pendingAtt.value.filter(x => x.attach_id !== a.attach_id)
}
let _sessionTurn = 0             // 当前 session 已发消息轮次（埋点用，切换 session 重置）

// 会话 id 存入 sessionStorage：刷新页面保留当前对话，关闭浏览器/标签页才清空（=开新对话）
const SESSION_KEY = 'gugu_session_id'
watch(sessionId, (v) => {
  if (v) sessionStorage.setItem(SESSION_KEY, String(v))
  else sessionStorage.removeItem(SESSION_KEY)
})

function stopStreaming() {
  pendingQueue.value = []   // 停止=放弃排队中的消息
  abortCtrl.value?.abort()
}

const copiedId = ref(null)
function fmtSize(b) {
  if (!b) return ''
  if (b < 1024) return b + ' B'
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1048576).toFixed(1) + ' MB'
}

// ── 图片附件缩略图（与文件库共用 useThumbCache）──
const _IMG_EXTS = new Set(['jpg','jpeg','png','gif','webp','avif','bmp','svg','heic','heif'])
// 缩略图来源优先级：本地 _thumbUrl（刚发的，即时）> file_id（已落库，服务端图）
// > attach_id（刷新后历史里的暂存图，走 /agent/attachment 端点，6h 内有效）；都没有则 ext 角标
function isImageFile(f) {
  if (f._thumbUrl) return true
  const isImg = _IMG_EXTS.has((f.ext || '').toLowerCase())
  return isImg && (!!f.file_id || !!f.attach_id)
}
// IntersectionObserver 懒加载指令：进视口附近才取 card 尺寸缩略图。
// 值为数字 file_id → 文件库缩略图；为字符串 attach_id → 暂存附件缩略图端点。
const vLazyThumb = {
  mounted(el, { value: id }) {
    if (!id) return
    const isAttach = typeof id === 'string'
    const key  = isAttach ? `att:${id}_card` : `${id}_card`
    const cached = isAttach ? getCachedThumbUrl(key) : getCachedThumb(id, 'card')
    if (cached) { el.src = cached; return }
    const fetchThumb = () => isAttach
      ? getThumbUrl(key, `${API_BASE}/agent/attachment/${id}/thumb?size=card`)
      : getThumb(id, 'card')
    const obs = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      obs.disconnect(); el._thumbObs = null
      fetchThumb().then(url => { if (url) el.src = url })
    }, { rootMargin: '200px' })
    obs.observe(el)
    el._thumbObs = obs
  },
  unmounted(el) { el._thumbObs?.disconnect(); el._thumbObs = null },
}

async function downloadFile(f) {
  if (f.attach_id) {
    // 聊天上传的暂存附件：走 /agent/attachment/{id}/download
    const token = localStorage.getItem('user_token') ?? ''
    const res = await fetch(`${API_BASE}/agent/attachment/${f.attach_id}/download`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!res.ok) { console.error('附件下载失败', res.status); return }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${f.name}.${f.ext}`
    document.body.appendChild(a); a.click()
    setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)
    return
  }
  try { await filesApi.download(f.file_id, `${f.name}.${f.ext}`) }
  catch (e) { console.error('下载失败', e) }
}

const previewStore = usePreviewStore()
function canPreview(f) {
  return (!!f.file_id || !!f.attach_id) && isPreviewable(f.ext)
}
function openFileFromChat(f) {
  if (canPreview(f)) {
    previewStore.open({
      id: f.file_id ?? null,
      attach_id: f.attach_id ?? null,
      ext: (f.ext || '').toUpperCase(),
      displayName: f.name,
      size: fmtSize(f.size_bytes),
    })
    return
  }
  downloadFile(f)
}

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

// 默认问候：占位空消息（打开对话框时再以打字机动画显示，文案在那一刻取最新生成版/兜底）
const messages = ref([
  { id: mkid(), role: 'ai', text: '', html: '', time: now(), _greeting: true },
])

// 打开对话框时让默认问候像回复一样「打字机」冒出来（生成版 / 兜底都走这套）。每条问候只播一次。
let _greetTimer = null
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
    if (i >= full.length) { clearInterval(_greetTimer); _greetTimer = null; msg.streaming = false; msg.html = renderMd(full) }
  }, 22)
}
// 任何打开路径（FAB / 通知点开 / 展开）都触发一次
watch(open, (v) => { if (v) animateGreeting() })

// ── 展开/收起 ────────────────────────────────────────────
const sessions = ref([])
const webSessions = computed(() => sessions.value.filter(s => !s.source || s.source === 'web'))
const imSessions  = computed(() => sessions.value.filter(s => s.source && s.source !== 'web'))
const currentSessionTitle = computed(() =>
  !sessionId.value ? '新对话' : (sessions.value.find(s => s.id === sessionId.value)?.title ?? '对话')
)

async function fetchSessions() {
  try { sessions.value = await agentApi.listSessions() } catch {}
}

// ── 侧栏 IM 接入（飞书 / QQ）：未接入显示扫码连接抽屉，接入后变成该平台会话抽屉 ──
const IM_PLATFORMS = [
  { key: 'feishu', label: '飞书', api: feishuConnectApi },
  { key: 'qqbot',  label: 'QQ',   api: qqConnectApi },
]
const bots   = ref([])
const imOpen = reactive({ feishu: false, qqbot: false })
const botsOf = (platform) => bots.value.filter(b => b.platform === platform)
const imSessionsOf = (platform) => imSessions.value.filter(s => s.source === platform)

async function loadBots() {
  try { const r = await userBotsApi.list(); bots.value = r.items || [] } catch {}
}
function toggleImPlatform(key) { imOpen[key] = !imOpen[key] }

// 通用扫码连接（建任务 → 渲染二维码 → 轮询 → 自动写 user_bot，与 ProfileModal 同一套 API）
const connecting    = ref('')        // 正在生成二维码的平台 key
const connect       = ref(null)      // { platform, id } 连接进行中
const connectHint   = ref('')
const connectErr    = ref('')
const connectCanvas = ref(null)
let   connectPoll   = null
function setConnectCanvas(el) { if (el) connectCanvas.value = el }   // v-for 内函数 ref，避免数组 ref

async function startImConnect(platform) {
  const p = IM_PLATFORMS.find(x => x.key === platform)
  connecting.value = platform; connectErr.value = ''
  try {
    const r = await p.api.start()
    connect.value = { platform, id: r.poll_id || r.task_id }   // 飞书 poll_id / QQ task_id
    connectHint.value = platform === 'feishu'
      ? '手机飞书扫码 → 授权创建机器人，授权后自动连接'
      : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'
    await nextTick()
    await QRCode.toCanvas(connectCanvas.value, r.scan_url, { width: 160, margin: 1 })
    _startImPoll(p)
  } catch (e) {
    connectErr.value = e.message || '生成二维码失败'
    connect.value = null
  } finally { connecting.value = '' }
}
function _startImPoll(p) {
  _stopImPoll()
  let tries = 0
  connectPoll = setInterval(async () => {
    tries++
    try {
      const r = await p.api.poll(connect.value.id)
      if (r.status === 'success') { cancelImConnect(); await loadBots(); await fetchSessions() }
      else if (r.status === 'expired') { connectErr.value = '二维码已过期，请重新扫码'; cancelImConnect() }
      else if (r.status === 'fail') { connectErr.value = '连接失败：' + (r.reason || '未知'); cancelImConnect() }
    } catch {}
    if (tries > 100) cancelImConnect()   // ~5 分钟超时
  }, 3000)
}
function _stopImPoll() { if (connectPoll) { clearInterval(connectPoll); connectPoll = null } }
function cancelImConnect() { _stopImPoll(); connect.value = null }

async function enterExpanded() {
  expanded.value = true
  loadBots()
  _markResizing()
  trackApi.track('chat_expanded').catch(() => {})
  await fetchSessions()
  await nextTick()
  expInputEl.value?.focus()
  atBottom.value = true; stick.value = true
  const el = messagesEl.value
  if (!el) return
  el.scrollTop = 999999; _lastTop = el.scrollTop
  // 展开动画期间容器高度持续变化，用 ResizeObserver 跟底，420ms 动画结束后断开
  const ro = new ResizeObserver(() => { el.scrollTop = 999999; _lastTop = el.scrollTop })
  ro.observe(el)
  setTimeout(() => { ro.disconnect() }, 450)
}

async function exitExpanded() {
  contentH.value = SMALL_H  // 先重置，小窗 DOM 以 SMALL_H 直接创建，不产生二次缩小
  _baseScrollH = Infinity   // 缩小动画期间冻结增长（grown 恒 0、窗口稳在 SMALL_H）：大窗换行少、
                            // scrollHeight 偏小，拿它当基线会让小窗重新换行后的高度全被算成新增 → 顶满
  expanded.value = false
  _markResizing()
  await nextTick()
  const el = messagesEl.value
  if (!el) return
  atBottom.value = true; stick.value = true
  el.scrollTop = 999999; _lastTop = el.scrollTop
  // CSS transition 让窗口从大尺寸平滑缩小（0.38s），期间 clientHeight 持续变化
  // ResizeObserver 跟着一直滚底，过渡结束后断开；动画结束、小窗布局稳定后再测真实基线
  const ro = new ResizeObserver(() => { el.scrollTop = 999999; _lastTop = el.scrollTop })
  ro.observe(el)
  setTimeout(() => {
    ro.disconnect()
    _baseScrollH = messagesEl.value?.scrollHeight || 0
    syncSmallH()
  }, 450)
}

async function loadSession(id) {
  if (id === sessionId.value) return
  abortCtrl.value?.abort()        // 停掉当前会话的流式消费（后端生成不受影响、继续跑）
  streaming.value = false
  try {
    const data = await agentApi.getMessages(id)
    sessionId.value = id
    clearStatus()   // 切会话先清掉上个会话残留的状态指示（active 会话下面 resumeStream 会重置）
    messages.value = data.messages.map(m => ({
      id: mkid(),
      dbId: m.id,
      role: m.role === 'assistant' ? 'ai' : m.role,
      text: m.content,
      html: m.role === 'assistant' ? renderMd(m.content) : null,
      files: m.files && m.files.length ? m.files : undefined,
      time: new Date(m.createdAt).toLocaleTimeString('zh', { hour: '2-digit', minute: '2-digit' }),
    }))
    contentH.value = SMALL_H; _sessionTurn = 0
    await nextTick()
    _baseScrollH = messagesEl.value?.scrollHeight || 0   // 基线 = 切入会话的历史高度
    scrollBottom(true)
    if (data.active) resumeStream(id)   // 该会话后端正在生成 → 重连续看
  } catch {}
}

async function newSession() {
  sessionId.value = null
  messages.value = []        // 大窗「新对话」是干净起手——不放默认问候（问候只在打开小窗时出现）
  _sessionTurn = 0
  await nextTick()
  expInputEl.value?.focus()
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

// IntersectionObserver 哨兵取代 scroll 事件 + scrollHeight 读取，消除强制回流
const atBottom = ref(true)
let _sentinelObs = null

// streaming 跟随意图：只有用户主动上翻才取消，回到底部附近恢复。
// 不依赖异步的 atBottom（大窗固定高度时，每个流式块把哨兵顶出视口，IO 会比
// MutationObserver 早一帧把 atBottom 置 false，导致跟随脱手）。
const stick   = ref(true)
let _lastTop  = 0     // 上次（多为程序化）滚动后的 scrollTop，用于判别用户上翻

// streaming 用即时滚动跟随，避免 smooth 叠加追不上
function scrollToBottom(el, smooth = false) {
  if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  else el.scrollTop = el.scrollHeight
  _lastTop = el.scrollTop   // 记录落点：程序化滚动产生的 scroll 事件不会误判为上翻
}

// 用户上翻 → 停住；滚回接近底部 → 恢复跟随
function onMsgScroll() {
  const el = messagesEl.value; if (!el) return
  // 用「距底距离」判定，对窗口增高导致的 scrollTop clamp 鲁棒（不会误判成用户上翻 → 停止跟随）
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight
  stick.value = dist < 40
  _lastTop = el.scrollTop
}

// 用户发送时强制即时跳到底（大窗用 smooth 会被随后出现的 thinking 气泡/内容打断，看着没到底）；
// 再补一帧 rAF，兜住附件缩略图/气泡迟一拍布局导致的高度变化
async function scrollBottom(force = false) {
  await nextTick()
  const el = messagesEl.value; if (!el) return
  syncSmallH()   // 发送/加载后按内容真实高度更新窗口高（含刚加的用户气泡）
  if (force) {
    atBottom.value = true; stick.value = true
    scrollToBottom(el)
    requestAnimationFrame(() => { if (stick.value && messagesEl.value) scrollToBottom(messagesEl.value) })
  }
  else if (stick.value) scrollToBottom(el)   // 跟随用稳健的 stick，不用异步竞态的 atBottom
}

// MutationObserver：内容变化时跟随（仅 streaming 且用户未上翻）
let msgMo = null

watch(messagesEl, (el, oldEl) => {
  msgMo?.disconnect()
  _sentinelObs?.disconnect()
  oldEl?.removeEventListener('scroll', onMsgScroll)
  if (!el) return

  el.addEventListener('scroll', onMsgScroll, { passive: true })

  // IntersectionObserver：观察哨兵 div 是否可见，替代 scrollHeight 读取
  const sentinel = el.querySelector('.msg-sentinel')
  if (sentinel) {
    _sentinelObs = new IntersectionObserver(
      ([entry]) => { atBottom.value = entry.isIntersecting },
      { root: el, threshold: 0 }
    )
    _sentinelObs.observe(sentinel)
  }

  // MutationObserver：streaming 时内容变化自动滚底，小窗模式额外累计高度增量
  msgMo = new MutationObserver(() => {
    const el = messagesEl.value
    if (!el || resizing.value) return
    syncSmallH()                          // 按内容真实高度更新小窗高度（含用户气泡 + AI 气泡）
    if (stick.value) {
      scrollToBottom(el)                                                                          // 立即滚底
      requestAnimationFrame(() => { if (stick.value && messagesEl.value) scrollToBottom(messagesEl.value) })  // 等窗口增高后的布局再滚一次
    }
  })
  msgMo.observe(el, { childList: true, subtree: true })
})

onUnmounted(() => {
  msgMo?.disconnect()
  _sentinelObs?.disconnect()
  messagesEl.value?.removeEventListener('scroll', onMsgScroll)
  _stopImPoll()
})

// 消费一条 SSE 流，把事件渲染进消息列表。send（POST /chat）和续看（GET .../stream）共用。
// 返回 { aiIdx, usedTools }，供调用方做收尾（首条空回复兜底、刷新视图）。
async function consumeStream(reader, ownerSid) {
  const decoder = new TextDecoder()
  let buf = '', aiIdx = -1
  let sid = ownerSid           // 本流归属的会话（新对话在 session_id 事件前为 null）
  let detached = false         // 一旦用户切到别的会话，本流永久脱离、不再污染当前视图
  const usedTools = new Set()
  // 当前看的还是本流的会话吗？切走后置 detached（之后切回靠 loadSession 干净重载，不半路重接）
  const live = () => {
    if (detached) return false
    if (sessionId.value !== (sid ?? ownerSid)) { detached = true; return false }
    return true
  }
  try {
    while (true) {
      let chunk
      try { chunk = await reader.read() }
      catch (e) { if (e.name === 'AbortError') break; throw e }   // 切会话会 abort：优雅收尾，别当网络错
      const { done, value } = chunk
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim(); if (!raw) continue
        let evt; try { evt = JSON.parse(raw) } catch { continue }
        if (evt.type === 'session_id') {
          const isNew = sessionId.value !== evt.session_id
          // 仅当用户仍停在本流视图（旧会话或新对话）才把视图切到新 id，否则别抢走用户当前会话
          if (sessionId.value === (sid ?? ownerSid)) sessionId.value = evt.session_id
          sid = evt.session_id
          if (isNew) await fetchSessions()
        } else if (evt.type === 'session_title') {
          const s = sessions.value.find(s => s.id === sid)   // 按本流会话更新标题，与当前视图无关
          if (s) s.title = evt.title
        } else if (evt.type === '_new_round') {
          // 后端新一轮开始（sanitizer 已重置），前端无需变更视觉状态
        } else if (evt.type === 'tool_call') {
          if (evt.name && !evt.name.startsWith('_')) usedTools.add(evt.name)  // 跳过 _preparing 占位
          // label 已由后端解析（含「状态命名」覆盖 + 复查前缀）；入队走打字机入场，切换太快也不抢拍
          if (live()) enqueueStatus({ kind: 'text', label: evt.label || evt.name })
        } else if (evt.type === 'tool_done') {
          // 改动类工具一完成就即时 bump 对应资源（走已连好的对话流，不等回合末、不靠 best-effort
          // 的 events SSE）→ 文件预览 / 项目卡 / 日历当场刷新。视图是全局的，切走也该刷，故不受 live() 限制。
          if (evt.name) {
            if (_FILE_TOOLS.has(evt.name)) liveStore.bump('files')
            else if (_PROJECT_TOOLS.has(evt.name)) liveStore.bump('projects')
            else if (_CALENDAR_TOOLS.has(evt.name)) liveStore.bump('calendar')
          }
          // 复查轮结束直接隐藏（回复早已显示完，别回落点点被误读为卡住）；主回复轮回到「思考中」
          if (live()) enqueueStatus(evt.verify ? { kind: 'hide' } : _thinkingItem())
        } else if (evt.type === 'token') {
          if (live()) {
            clearStatus()   // 真回复开始 → 打断状态队列、收起指示，让位给流式正文
            if (aiIdx === -1) { messages.value.push({ id: mkid(), role: 'ai', text: '', time: now(), streaming: true }); aiIdx = messages.value.length - 1 }
            messages.value[aiIdx].text += evt.content
            await scrollBottom()
          }
        } else if (evt.type === 'file') {
          if (live()) {
            clearStatus()
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
            messages.value.push({ id: mkid(), role: 'ai', text: evt.message || evt.detail || '咕咕开小差了 😵‍💫 麻烦再说一遍好吗？', time: now() })
            aiIdx = messages.value.length - 1
            await scrollBottom()
          }
        }
      }
    }
  } finally {
    if (!detached && aiIdx !== -1 && messages.value[aiIdx]) {
      const m = messages.value[aiIdx]
      m.streaming = false
      m.html = renderMd(m.text)
      if (!m.text?.trim() && !m.files?.length) {
        messages.value.splice(aiIdx, 1)
      }
    }
  }
  return { aiIdx, usedTools, detached, sid }
}

// 续看：打开会话时若它正在生成（messages 接口返回 active），重连看后端跑完。
async function resumeStream(id) {
  if (streaming.value) return            // 本地正在发/看，不重复连
  const token = localStorage.getItem('user_token') ?? ''
  abortCtrl.value = new AbortController()   // 让下次切会话能 abort 掉这条续看
  streaming.value = true; clearStatus(); enqueueStatus(_thinkingItem())
  try {
    const res = await fetch(`${BASE_URL}/agent/sessions/${id}/stream`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: abortCtrl.value.signal,
    })
    if (!res.ok) return
    if (sessionId.value !== id) return   // 期间又切走了，丢弃
    const r = await consumeStream(res.body.getReader(), id)
    refreshAfterTools(r.usedTools)
  } catch { /* 续看失败/被切走中断都不打扰 */ }
  finally {
    // 仍停在本会话才收尾全局指示，避免切走后清掉新会话续看的状态
    if (sessionId.value === id) { clearStatus(); streaming.value = false; abortCtrl.value = null }
  }
}

async function send(forcedText) {
  // forcedText 来自"排队接力"（队首消息）：此时用户气泡已在入队时显示过，不重复推
  const fromInput = forcedText === undefined
  const text = (fromInput ? inputText.value : forcedText).trim()
  const atts = fromInput ? pendingAtt.value.slice() : []   // 本次随消息发的附件
  if (!text && !atts.length) return
  if (fromInput) {
    _sessionTurn++
    messages.value.push({ id: mkid(), role: 'user', text, time: now(),
      files: atts.length ? atts.map(a => ({ name: a.name, ext: a.ext, size_bytes: a.size, attach_id: a.attach_id, upload: true, _thumbUrl: a._thumbUrl })) : undefined })
    inputText.value = ''
    pendingAtt.value = []
    if (expInputEl.value) expInputEl.value.style.height = 'auto'
    trackApi.track('chat_message', { turn: _sessionTurn }).catch(() => {})
    await scrollBottom(true)
  }
  // 生成中：把这条排队，等当前流式结束后在 finally 里接着发（气泡已显示）
  if (streaming.value) { pendingQueue.value.push(text); return }

  streaming.value = true; clearStatus(); enqueueStatus(_thinkingItem())
  abortCtrl.value = new AbortController()
  await scrollBottom()
  const token = localStorage.getItem('user_token') ?? ''
  const ownerSid = sessionId.value   // 本次发送归属的会话（新对话为 null，流里拿到 id 后回填）
  let resolvedSid = ownerSid         // 流里 session_id 事件后回填成真实 id
  let aiIdx = -1
  const usedTools = new Set()

  // 新会话且当前显示着默认问候 → 把问候随首条消息带给后端，落为本会话首条 assistant 消息，
  // 这样咕咕回复时能看到「自己已经打过招呼」，不会把用户对问候的回复当成对话刚开始。
  const _g0 = messages.value[0]
  const greetingForSession = (ownerSid == null && _g0?._greeting) ? (_g0._greetFull || _g0.text || '') : ''

  try {
    const res = await fetch(`${BASE_URL}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ message: text, session_id: ownerSid, attachments: atts.map(a => a.attach_id),
                             ...(greetingForSession ? { greeting: greetingForSession } : {}) }),
      signal: abortCtrl.value.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const r = await consumeStream(res.body.getReader(), ownerSid)
    resolvedSid = r.sid
    aiIdx = r.aiIdx
    r.usedTools.forEach(t => usedTools.add(t))
    // 用户中途切走了 → 别把兜底气泡塞进当前别的会话视图（回复已在后端，切回会重载）
    if (aiIdx === -1 && !r.detached) {
      messages.value.push({ id: mkid(), role: 'ai', text: '收到，但没有收到回复，请稍后再试。', time: now() })
      await scrollBottom()
    }
  } catch (e) {
    if (e.name !== 'AbortError' && sessionId.value === resolvedSid) {
      // fetch 抛错=连不上咕咕后端，基本都是网络问题（仅在仍停在本会话时报）
      clearStatus()
      messages.value.push({ id: mkid(), role: 'ai', text: '咕咕网络不太好 📡 可以再发一遍吗？', time: now() })
      await scrollBottom()
    }
  } finally {
    // 仍停在本次发送的会话才收尾全局状态；切走后这些状态归新会话的续看流管，别清掉
    const ownsView = sessionId.value === resolvedSid
    if (ownsView) {
      // 流式结束：把该条 AI 消息标记为非流式，触发 markdown 渲染（流式中按纯文本显示，避免半截表格/代码块闪烁）
      if (aiIdx !== -1 && messages.value[aiIdx]) messages.value[aiIdx].streaming = false
      clearStatus(); streaming.value = false; abortCtrl.value = null
      // markdown 重渲染后内容变高，MutationObserver 此时已因 streaming=false 停止跟随，
      // 需在 nextTick 后再滚一次，否则底部时间戳会被截掉
      await scrollBottom()
    }
    // 咕咕若调用了改数据的工具，刷新对应前端视图（项目/日历/文件），免手动刷新页面
    refreshAfterTools(usedTools)
    // 生成期间排队的消息：取队首接着发（其自身 finally 会继续取下一条，逐条处理）
    if (ownsView && pendingQueue.value.length) send(pendingQueue.value.shift())
  }
}
</script>

<style scoped>
/* ── 悬浮球 ── */
.ai-fab {
  position: fixed; bottom: 28px; right: 28px;
  isolation: isolate; width: 50px; height: 50px; border-radius: 50%;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); border: none;
  cursor: pointer; z-index: 10000;   /* 高于卡片拖拽克隆体（9999） */
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
@keyframes fab-typing {
  0%   { transform: translateY(0); }
  50%  { transform: translateY(-2px); }
  100% { transform: translateY(0); }
}
.ai-fab--typing { animation: fab-typing 0.2s linear 1; }

/* ── 单一聊天窗口 ── */
.chat-window {
  position: fixed;
  z-index: 10001;   /* 高于卡片拖拽克隆体（9999） */
  border: 1px solid rgba(255,255,255,0.7);
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(20,25,50,0.18);
  will-change: top, left, right, bottom;
}
.chat-window::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: 20px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95), inset 1px 0 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(255,255,255,0.3);
  pointer-events: none;
  z-index: 100;
}

/* 主区域负责背景 blur */
.chat-main {
  background: var(--panel-bg);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  transform: translateZ(0);
}

/* 位移过渡放在 CSS，不放 inline style（避免覆盖 Vue transition 的 opacity/transform） */
.chat-window {
  transition: top 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              left 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              right 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              bottom 0.42s cubic-bezier(0.16, 1, 0.3, 1);
}
/* 小窗流式增高：top 即时跟随内容（去掉 0.42s 缓动，否则窗口高度滞后于出字、一跳一跳）。
   left/right/bottom 保留缓动用于开关/位移动画；流式中它们不变，无副作用。 */
.chat-window.win-grow {
  transition: left 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              right 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              bottom 0.42s cubic-bezier(0.16, 1, 0.3, 1);
}


/* 窗口开/关动画（从右下角 fab 原点缩放），!important 覆盖上方位移 transition */
/* 入场：极快启动、平滑减速（无过冲）；出场：平滑加速收缩 */
.chat-open-enter-active {
  transition: opacity 0.22s ease, transform 0.36s cubic-bezier(0.16, 1, 0.3, 1) !important;
  transform-origin: right bottom;
}
.chat-open-leave-active {
  transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(0.7, 0, 0.84, 0) !important;
  transform-origin: right bottom;
}
.chat-open-enter-from, .chat-open-leave-to { opacity: 0; transform: scale(0.78); }

/* ── 拖入附件遮罩 ── */
.chat-drop-overlay {
  position: absolute; inset: 0; z-index: 120;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  pointer-events: none;   /* 让拖拽事件穿透到 .chat-window，drop/dragleave 才能正常触发 */
  background: rgba(123,127,178,0.16);
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  border: 2px dashed rgba(123,127,178,0.6); border-radius: 20px;
  color: var(--color-primary); font-size: 14px; font-weight: 600;
}
.chat-drop-fade-enter-active, .chat-drop-fade-leave-active { transition: opacity 0.15s ease; }
.chat-drop-fade-enter-from, .chat-drop-fade-leave-to { opacity: 0; }

/* ── 单一布局 ── */
.chat-window { display: flex; }
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }

.chat-header {
  display: flex; align-items: center; gap: 9px;
  padding: 13px 14px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.5);
  flex-shrink: 0;
}
.chat-main.is-expanded .chat-header { padding: 16px 20px 12px; }
.chat-title { font-size: 13px; font-weight: 700; flex: 1; }
.chat-main.is-expanded .chat-title { font-size: 14px; font-weight: 600; }
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

.chat-messages {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  padding: 12px 13px;
  display: flex; flex-direction: column; gap: 8px;
}
.chat-main.is-expanded .chat-messages { padding: 20px 24px; gap: 12px; }
.chat-main.is-expanded .chat-messages .msg-bubble { max-width: 72%; font-size: 14px; }
.msg-sentinel { flex-shrink: 0; height: 1px; }

.chat-att-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 6px; }
.chat-att-chip { display: flex; align-items: center; gap: 5px; max-width: 180px;
  padding: 3px 8px; border-radius: 8px; font-size: 11px; color: var(--color-primary);
  background: rgba(123,127,178,0.1); border: 1px solid rgba(123,127,178,0.2); }
.chat-att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-att-x { background: none; border: none; cursor: pointer; color: var(--color-primary);
  font-size: 13px; line-height: 1; padding: 0; opacity: 0.6; }
.chat-att-x:hover { opacity: 1; }
.chat-att-chip.att-up { color: var(--text-secondary); background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.08); }
.att-btn { flex-shrink: 0; background: none; border: none; cursor: pointer; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center; height: 28px; padding: 0;
  opacity: 0.7; transition: opacity 0.15s, color 0.15s; }   /* 与发送按钮(28)等高，底对齐时中心也对齐 */
.chat-main.is-expanded .att-btn { height: 32px; }   /* 放大态对齐放大发送按钮(32) */
.att-btn:hover { opacity: 1; color: var(--color-primary); }
.chat-input-row {
  display: flex; align-items: flex-end; gap: 8px;   /* 输入框多行增高时，附件/发送按钮贴底对齐 */
  padding: 10px 13px;
  border-top: 1px solid rgba(255,255,255,0.65);
  background: rgba(255,255,255,0.55);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  flex-shrink: 0;
}
.chat-main.is-expanded .chat-input-row { padding: 14px 20px; gap: 10px; }
.chat-input-row input {
  flex: 1; border: none; background: none;
  font-size: 13px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
  line-height: 1.5; padding: 2px 0;
}
.chat-input-row textarea {
  flex: 1; border: none; background: none;
  font-size: 14px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
  resize: none; line-height: 1.5; max-height: 120px; overflow-y: auto;
  display: block; padding: 4px 0; vertical-align: middle;
}
/* 小窗输入字号略小，与小窗整体一致 */
.chat-main:not(.is-expanded) .chat-input-row textarea { font-size: 13px; }

.exp-sidebar {
  width: 210px; flex-shrink: 0;
  display: flex; flex-direction: column;
}
.exp-sidebar-header {
  display: flex; align-items: center;
  padding: 16px 14px 12px;
  flex-shrink: 0;
}
.exp-sidebar-divider {
  height: 1px; flex-shrink: 0; margin: 0 4px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
}
.exp-group-divider {
  height: 1px; flex-shrink: 0; margin: 4px 2px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
}
.exp-sidebar-title { flex: 1; font-size: 14px; font-weight: 700; color: var(--text-primary); text-align: center; }

.exp-new-session-wrap {
  padding: 10px 10px 12px;
  flex-shrink: 0;
}
.exp-new-session-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 12.5px; font-weight: 700; font-family: var(--font-sans);
  color: var(--color-primary);
  background: rgba(255,255,255,0.82);
  border: 1px solid rgba(255,255,255,0.95);
  box-shadow: 0 2px 8px rgba(123,127,178,0.12), inset 0 1px 0 rgba(255,255,255,1);
  transition: background 0.15s, box-shadow 0.15s;
}
.exp-new-session-btn:hover {
  background: rgba(255,255,255,0.95);
  box-shadow: 0 5px 16px rgba(123,127,178,0.22), inset 0 1px 0 rgba(255,255,255,1);
}
.exp-new-session-btn:active {
  transform: translateY(1px);
  box-shadow: 0 1px 4px rgba(123,127,178,0.1), inset 0 1px 0 rgba(255,255,255,1);
  transition: transform 0.05s, box-shadow 0.05s;
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
.exp-session-item.active .exp-session-title { font-weight: 700; }
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
.exp-session-source {
  flex-shrink: 0; font-size: 11px; font-weight: 600; line-height: 1;
  font-family: var(--font-sans); letter-spacing: 0.01em;
  padding: 2px 5px; border-radius: 4px;
}
.exp-session-source.src-qqbot { background: rgba(18,183,245,0.15); color: #0c8fc0; }
.exp-session-source.src-feishu { background: rgba(66,133,244,0.15); color: #3b6fc4; }

/* IM 平台抽屉（飞书 / QQ） */
.im-plat { display: flex; flex-direction: column; }
.im-plat-head {
  display: flex; align-items: center; gap: 7px;
  padding: 8px 10px; border-radius: 9px; border: none; cursor: pointer;
  background: none; font-family: var(--font-sans);
  transition: background 0.12s;
}
.im-plat-head:hover { background: rgba(255,255,255,0.55); }
.im-plat-head.open { background: rgba(123,127,178,0.08); }
.im-plat-chev { color: var(--text-secondary); transition: transform 0.18s ease; flex-shrink: 0; }
.im-plat-chev.open { transform: rotate(-180deg); }
.im-plat-name { flex: 1; text-align: left; font-size: 12.5px; font-weight: 700; color: var(--text-primary); }
.im-plat-badge {
  flex-shrink: 0; font-size: 10.5px; font-weight: 600; line-height: 1;
  padding: 2px 6px; border-radius: 4px;
  background: rgba(123,127,178,0.12); color: var(--text-secondary);
}
.im-plat-badge.on { background: rgba(74,180,120,0.16); color: #2f9e63; }
.im-plat-body {
  display: flex; flex-direction: column; gap: 2px;
  padding: 2px 0 6px;
}
.im-connect-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  margin: 4px 0 2px;
  padding: 9px 14px; border-radius: var(--radius-sm); cursor: pointer;
  font-size: 12.5px; font-weight: 700; font-family: var(--font-sans);
  color: var(--color-primary);
  background: rgba(255,255,255,0.82);
  border: 1px solid rgba(255,255,255,0.95);
  box-shadow: 0 2px 8px rgba(123,127,178,0.12), inset 0 1px 0 rgba(255,255,255,1);
  transition: background 0.15s, box-shadow 0.15s;
}
.im-connect-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.95);
  box-shadow: 0 5px 16px rgba(123,127,178,0.22), inset 0 1px 0 rgba(255,255,255,1);
}
.im-connect-btn:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: 0 1px 4px rgba(123,127,178,0.1), inset 0 1px 0 rgba(255,255,255,1);
  transition: transform 0.05s, box-shadow 0.05s;
}
.im-connect-btn:disabled { opacity: 0.6; cursor: default; }
.im-qr-box {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 12px 8px 10px;
}
.im-qr-canvas {
  width: 160px; height: 160px; border-radius: 10px;
  background: #fff; padding: 6px; box-sizing: border-box;
  box-shadow: 0 2px 10px rgba(123,127,178,0.18);
}
.im-qr-hint { font-size: 11.5px; color: var(--text-secondary); text-align: center; line-height: 1.5; }
.im-qr-err { font-size: 11.5px; color: rgba(200,80,80,0.9); padding: 4px 0; }
.im-qr-cancel {
  font-size: 11.5px; color: var(--text-secondary); background: none; border: none;
  cursor: pointer; padding: 3px 10px; border-radius: 6px; transition: background 0.12s;
}
.im-qr-cancel:hover { background: rgba(123,127,178,0.12); color: var(--text-primary); }

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
.msg { display: flex; flex-direction: column; min-width: 0; }
.msg.user { align-items: flex-end; }
.msg-search-flash { animation: msg-search-flash 1.8s ease forwards; border-radius: 12px; }
@keyframes msg-search-flash {
  0%   { background: rgba(123,127,178,0.18); }
  35%  { background: rgba(123,127,178,0.18); }
  100% { background: transparent; }
}

.msg.ai { align-items: flex-start; }
.msg-bubble {
  padding: 9px 13px; border-radius: 13px;
  font-size: var(--gugu-body-size); line-height: var(--gugu-body-line); max-width: 88%;
  word-break: break-word; overflow-wrap: break-word;
}
.msg.ai .msg-bubble {
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.65);
  border-bottom-left-radius: 4px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
}
.msg.user .msg-bubble {
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: white;
  border-bottom-right-radius: 4px;
}
/* 咕咕发来的文件卡片 */
.msg-files { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; max-width: 88%; min-width: 0; }
.msg-file {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer;
  max-width: 100%; box-sizing: border-box;
  /* 和 AI 气泡同款：半透明白 + 左下角小尾巴 + 内高光，营造气泡感 */
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.65);
  border-radius: 14px; border-bottom-left-radius: 5px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 3px rgba(80,80,120,0.06);
  transition: background 0.15s, box-shadow 0.15s;
}
.msg-file:hover {
  background: rgba(255,255,255,0.7);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 3px 10px rgba(100,110,200,0.14);
}
.msg-file-ext {
  position: relative; overflow: hidden;
  flex-shrink: 0; width: 34px; height: 34px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: #fff; letter-spacing: 0.02em;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
}
/* 图片附件：缩略图覆盖 ext 角标；加载失败时 @error 移除自身，露出底下角标 */
.msg-file-thumb {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; display: block;
}
.msg-file-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.msg-file-name { font-size: 15px; font-weight: 500; color: #2a2c3a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-file-meta { font-size: 12px; color: #9296ad; }
.msg-file-dl { flex-shrink: 0; color: #7b7fb2; }
/* 用户(右侧)发的附件卡：气泡尾巴翻到右下、左下回正常圆角、容器右对齐 */
.msg.user .msg-files { align-items: flex-end; }
.msg.user .msg-file { border-bottom-left-radius: 14px; border-bottom-right-radius: 5px; }
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

/* 状态气泡入场动画（:key 变化触发重建 → 每个状态都「冒」一下；文字本身再走打字机） */
.status-pop { animation: statusPop 0.3s cubic-bezier(0.2, 0.8, 0.3, 1) both; }
@keyframes statusPop { from { opacity: 0; transform: translateY(7px) scale(0.96); } to { opacity: 1; transform: none; } }

.tool-bubble { display: flex; align-items: center; gap: 8px; color: var(--color-primary); }
.tool-spinner {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid rgba(123,127,178,0.25); border-top-color: var(--color-primary);
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.tool-label { font-weight: 600; }

/* ── Markdown ── */
/* md 排版由通用组件 MarkdownView 提供；这里只保留聊天气泡的内边距 */
.md-body { padding: 10px 13px; }

/* ── 迷你播放器 ── */
.mini-player {
  position: fixed; right: 28px; box-sizing: border-box; width: 360px;   /* border-box 外宽 360，与小窗/气泡严格对齐 */
  transition: bottom 0.28s cubic-bezier(0.34, 1.2, 0.64, 1);
  background: var(--panel-bg); backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);
  border: 1px solid rgba(255,255,255,0.65); border-radius: 20px;
  box-shadow: var(--glass-shadow-lg); padding: 12px 14px 10px;
  z-index: 10002; display: flex; flex-direction: column; gap: 7px;   /* 高于卡片拖拽克隆体（9999） */
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
