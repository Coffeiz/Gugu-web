<template>
  <!-- 迷你播放器 -->
  <GuguChatMiniPlayer
    ref="miniPlayerRef"
    :visible="!!audioStore.file && (miniPinned || open)"
    :style="miniPlayerStyle" :bars-playing="barsPlaying"
    :file-name="audioStore.file ? `${audioStore.file.displayName}.${audioStore.file.ext?.toLowerCase()}` : ''"
    :pinned="miniPinned" @update:pinned="miniPinned = $event"
    :current="audioCurrent" :duration="audioDuration" :seek-pct="audioSeekPct"
    :playing="audioPlaying" :muted="audioMuted" :volume="audioVolume"
    :fmt-time="fmtTime" :on-stop="audioStop" :on-seek="audioSeek" :on-start-drag="audioStartDrag"
    :on-toggle="audioToggle" :on-toggle-mute="audioToggleMute" :on-set-volume="audioSetVolume"
  />

  <audio
    ref="audioEl"
    :src="audioStore.blobUrl ?? undefined"
    @timeupdate="audioCurrent = audioEl?.currentTime ?? 0"
    @durationchange="audioDuration = audioEl?.duration || 0"
    @play="audioPlaying = true"
    @pause="onAudioPause"
    @ended="onAudioEnded"
    @canplay="onCanPlay"
  />

  <!-- 悬浮球 -->
  <GuguChatFab
    ref="fabRef"
    :ripple-active="rippleActive" :fab-z="fabZ"
    :has-audio-file="!!audioStore.file" :spinning-back="spinningBack"
    :fab-jumping="fabJumping" :audio-playing="audioPlaying"
    @click="toggleOpen"
  />

  <!-- 聊天窗口（单一元素，小/大状态通过位置过渡） -->
  <Transition name="chat-open" @after-leave="chatClosing = false">
    <!-- win-grow 排除 resizing：大/小窗位形切换的瞬间 .chat-window 的 top 还需要 0.42s 缓动做纵向过渡，
         一旦带上 win-grow 会把 top 的 transition 撤掉，窗口会瞬间从大窗高跳到小窗高（横轴仍走缓动，纵轴跳一下）。
         resizing 在 _markResizing() / 过渡结束 / 600ms 兜底 时机清掉，回归流式 top 即时跟随。 -->
    <div v-if="open" class="chat-window" :class="{ 'win-grow': streaming && !expanded && !resizing }" :style="windowStyle" ref="windowRef"
      @mousedown.capture="raiseChat"
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

      <!-- 扫码绑定 IM 弹窗：咕咕回复里点 [扫码绑定…](gugu://bind-im/<platform>) 按钮触发，复用现有连接 API -->
      <Transition name="chat-drop-fade">
        <div v-if="chatBind.open" class="cb-overlay" @click.self="closeChatBind">
          <div class="cb-modal popup-menu">
            <div class="cb-title">扫码绑定{{ chatBind.label }}</div>
            <canvas ref="chatBindCanvas" class="cb-qr"></canvas>
            <div v-if="chatBind.err" class="cb-err">{{ chatBind.err }}</div>
            <div v-else class="cb-hint">{{ chatBind.hint || '生成二维码中…' }}</div>
            <button class="cb-cancel" @click="closeChatBind">取消</button>
          </div>
        </div>
      </Transition>


      <!-- 侧边栏（仅大窗） -->
      <GuguChatSidebar
        v-if="expanded" ref="sidebarRef"
        :im-platforms="imPlatformOptions" :im-open="imOpen" :im-highlight="imHighlight"
        :bots-of="botsOf" :im-sessions-of="imSessionsOf"
        :web-sessions="webSessions" :session-id="sessionId"
        :connect="connect" :connect-hint="connectHint" :connect-err="connectErr" :connecting="connecting"
        :on-toggle-platform="toggleImPlatform" :on-set-connect-canvas="setConnectCanvas"
        :on-start-im-connect="startImConnect" :on-cancel-im-connect="cancelImConnect"
        :on-load-session="loadSession" :on-delete-session="deleteSession" :on-new-session="newSession"
      />

      <!-- 主区域（始终存在，消息列表永不销毁） -->
      <div class="chat-main" :class="{ 'is-expanded': expanded, 'is-resizing': resizing }">
        <div class="chat-header">
          <span class="chat-title">{{ expanded ? currentSessionTitle : '咕咕' }}</span>
          <span class="popup-status" :class="'is-' + presenceKind"
                @click="presenceKind === 'offline' && promptConnectIM()"
                :title="presenceTitle">
            <em class="status-dot" />{{ presenceText }}
          </span>
          <div class="btn-group">
            <button v-if="!expanded" class="popup-icon-btn" @click="enterExpanded" title="展开">
              <PhArrowsOut weight="bold" :size="13" />
            </button>
            <button v-if="expanded" class="exp-icon-btn" @click="exitExpanded" title="收起">
              <PhArrowsIn weight="bold" :size="14" />
            </button>
            <button class="popup-close-btn" @click="closeChat">
              <PhX weight="bold" :size="13" />
            </button>
          </div>
        </div>

        <GuguChatMessageList
          ref="messageListRef"
          :messages="messages" :is-group-session="isGroupSession"
          :copied-id="copiedId" :voice-playing-id="voicePlayingId"
          :expanded="expanded" :status-kind="statusKind" :status-typed="statusTyped"
          @copy="copyMsg" @toggle-voice="toggleVoice"
          @open-file="openFileFromChat" @action-click="onChatActionClick"
        />

        <!-- 输入框 -->
        <GuguChatComposer
          ref="composerRef"
          v-model="inputText"
          :pending-att="pendingAtt" :att-uploading="attUploading"
          :recording="recording" :record-secs="recordSecs"
          :expanded="expanded" :streaming="streaming" :vw="vw"
          :on-remove-att="removeAtt" :on-pick-file="pickFile"
          :on-start-record="startRecord" :on-cancel-record="cancelRecord" :on-stop-record="stopRecord"
          :on-file-picked="onFilePicked" :on-paste="onPaste"
          :on-send="() => send()" :on-stop-streaming="stopStreaming"
        />
      </div>

    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted, type ComponentPublicInstance } from 'vue'
import { useRouter } from 'vue-router'
import QRCode from 'qrcode'
import { useAudioStore } from '@/stores/audio'
import { nextZ } from '@/composables/windowz'
import { useProjectStore } from '@/stores/projects'
import { useLiveStore } from '@/stores/live'
import { useUiStore } from '@/stores/ui'
import { usePreviewStore } from '@/stores/preview'
import { agentApi, filesApi, trackApi, userBotsApi, qqConnectApi, feishuConnectApi, wechatConnectApi, authApi, CLIENT_ID } from '@/services/api'
import { getGreeting, prefetchGreeting } from '@/composables/useGreeting'
import { uploadSignal, calendarSignal } from '@/services/cache'
import { playGuguSfx } from '@/services/sfx'
import GuguChatMessageList from './gugu-chat/GuguChatMessageList.vue'
import GuguChatComposer from './gugu-chat/GuguChatComposer.vue'
import GuguChatFab from './gugu-chat/GuguChatFab.vue'
import GuguChatMiniPlayer from './gugu-chat/GuguChatMiniPlayer.vue'
import GuguChatSidebar from './gugu-chat/GuguChatSidebar.vue'
import type { ChatMessage, ChatFile, ChatSession } from './gugu-chat/chatTypes'
import { API_BASE, SMALL_W, SMALL_H, SIDEBAR_W } from './gugu-chat/chatConstants'
import { renderMd, renderMdStream } from './gugu-chat/markdown'
import {
  isImageFile, isAnimatedImageFile, canPreview,
  fmtSize, fmtDur, voiceBar, displayQQFaces,
} from './gugu-chat/messageDisplay'
import { useChatAudio } from './gugu-chat/useChatAudio'
import { useChatAttachments } from './gugu-chat/useChatAttachments'
import { PhX, PhArrowsOut, PhArrowsIn } from '@phosphor-icons/vue'

interface Bot {
  id?: number
  platform: string
  enabled: boolean
}

interface QuotaInfo {
  limit_6h?: number | null
  used_6h?: number
  limit_weekly?: number | null
  used_weekly?: number
}

interface ImConnectState {
  platform: string
  id: string | number
}


const audioStore    = useAudioStore()
const projectStore  = useProjectStore()
const liveStore     = useLiveStore()
const uiStore       = useUiStore()
const router        = useRouter()

// 顶栏全局搜索点「对话」结果 / 笔记里点「@对话」引用卡片：打开聊天面板并切到该会话。
// 不强制展开大窗——默认保持小窗，用户已经开着大窗才维持大窗；对话引用现在锚定的是
// 具体一条消息（见 useMindRefActions.ts），靠 _flashChatMessage 在消息列表里定位闪烁，
// 小窗一样看得见，不需要靠「大窗侧边栏 .active 高亮」这条路。
watch(() => uiStore.pendingChatSession, async (id) => {
  if (!id) return
  open.value = true
  await loadSession(id as number)
  const msgId = uiStore.pendingChatMessageId
  uiStore.pendingChatSession = null
  uiStore.pendingChatMessageId = null
  if (msgId) { await _revealMessage(msgId); _flashChatMessage(msgId) }
})

function _flashChatMessage(dbId: number) {
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

// 工具名 → 受影响数据域，咕咕操作后据此刷新前端，免手动刷新页面
// 与后端 RESOURCE_BY_TOOL（app/core/events.py）保持一致——漏了哪个工具，对应视图就不会实时刷新。
const _PROJECT_TOOLS = new Set(['create_project','update_project','delete_project','archive_project','update_stage','set_priority','set_color','add_stage','remove_stage','rename_stage','add_todo','remove_todo','set_stages','update_todo'])
const _CALENDAR_TOOLS = new Set(['create_event','update_event','delete_event'])
const _FILE_TOOLS = new Set(['edit_file','create_document','rename_file','move_items','copy_file','create_folder','delete_file','rename_folder','delete_folder','save_uploaded_file','restore_file','permanent_delete'])

async function refreshAfterTools(usedTools: Set<string>) {
  if (!usedTools.size) return
  const has = (set: Set<string>) => [...usedTools].some(t => set.has(t))
  try {
    if (has(_PROJECT_TOOLS)) await projectStore.fetchProjects()
    if (has(_CALENDAR_TOOLS)) { calendarSignal.value++; projectStore.fetchUpcomingCalEvents?.() }
    // 文件：刷文件管理器（uploadSignal）+ 确定性 bump rev.files 让打开的预览窗重载。
    // 实时 SSE（live.js）是 best-effort（dev 重启 / pub-sub 竞态会丢事件），靠这条回合末兜底保证稳定刷新。
    if (has(_FILE_TOOLS)) { uploadSignal.value++; liveStore.bump('files') }
  } catch (e) { /* 刷新失败不影响对话 */ }
}
const fabRef        = ref<InstanceType<typeof GuguChatFab> | null>(null)
const miniPlayerRef = ref<InstanceType<typeof GuguChatMiniPlayer> | null>(null)
const rippleActive  = ref(false)
const barsPlaying   = ref(false)
const spinningBack = ref(false)
let rippleTimeout: ReturnType<typeof setTimeout> | null = null

// 悬浮球转场动画在 audioStore.file 清空前触发（拿最后角度做转回归位动画）；
// 播放器机制（暂停/进度/音量/语音条播放）全部收在 useChatAudio。
const {
  audioEl, audioPlaying, audioCurrent, audioDuration, audioSeekPct,
  saveProgress, onCanPlay, onAudioPause, onAudioEnded, audioToggle, audioStop,
  audioVolume, audioMuted, audioSetVolume, audioToggleMute, audioSeek, audioStartDrag, fmtTime,
  voicePlayingId, toggleVoice,
} = useChatAudio({
  onTip: (text) => _chatTip(text),
  onBeforeStop: () => {
    const svgEl = fabRef.value?.svgEl
    if (!svgEl || !audioStore.file) return
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
  },
})

watch(audioPlaying, (playing) => {
  if (playing) {
    miniPlayerRef.value?.barsEl?.querySelectorAll('i').forEach((b) => { (b as HTMLElement).style.cssText = '' })
    barsPlaying.value = true
  } else {
    const bars = miniPlayerRef.value?.barsEl?.querySelectorAll('i') ?? []
    bars.forEach((b) => { (b as HTMLElement).style.height = getComputedStyle(b).height; (b as HTMLElement).style.transition = 'none' })
    barsPlaying.value = false
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bars.forEach((b) => { (b as HTMLElement).style.transition = 'height 0.45s ease-out'; (b as HTMLElement).style.height = '4px' })
    }))
    setTimeout(() => bars.forEach((b) => { (b as HTMLElement).style.cssText = '' }), 500)
  }
})

watch(audioPlaying, (playing) => {
  if (playing) { if (rippleTimeout) clearTimeout(rippleTimeout); rippleActive.value = true }
  else { rippleTimeout = setTimeout(() => { rippleActive.value = false }, 3600) }
})

// ── 窗口状态 ────────────────────────────────────────────
const open       = ref(false)
const expanded   = ref(false)
const resizing   = ref(false)   // 展开/缩小动画期间：关 backdrop-filter、停跟随，降卡顿
let _resizeTimer: ReturnType<typeof setTimeout> | null = null
let _onResizeTransitionEnd: ((e: TransitionEvent) => void) | null = null
function playIncomingMessageSfx() {
  // 聊天窗正在被用户看着时不打断；切到别的标签页或收起聊天窗才提示。
  if (!open.value || document.hidden) playGuguSfx('message')
}
function _markResizing() {
  resizing.value = true
  if (_resizeTimer) clearTimeout(_resizeTimer)
  if (windowRef.value && _onResizeTransitionEnd) {
    windowRef.value.removeEventListener('transitionend', _onResizeTransitionEnd)
  }
  // 用真实 transitionend 结束 resizing，而不是硬编码 420ms 定时器——.chat-window 的位移过渡
  // 也是 0.42s，正常情况下两者前后脚触发看不出差别；但性能不足时（掉帧/主线程繁忙）CSS 过渡
  // 的视觉完成时间会被拖慢，定时器却按固定墙钟时间准点触发，导致 backdrop-filter/跟随在过渡
  // 还没走完时就被重新打开，看起来「闪一下」。定时器保留作兜底（万一没有属性真正变化、不会
  // 触发 transitionend），加了缓冲、不再和过渡时长完全对齐。
  _onResizeTransitionEnd = (e: TransitionEvent) => {
    if (e.target !== windowRef.value) return   // 只认窗口自己的位移过渡，冒泡上来的子元素过渡不算
    if (!['top', 'left', 'right', 'bottom'].includes(e.propertyName)) return
    resizing.value = false
    composerRef.value?.fitTextarea()   // 过渡结束后做一次无视觉差的最终校准，处理浏览器的子像素取整
  }
  windowRef.value?.addEventListener('transitionend', _onResizeTransitionEnd)
  _resizeTimer = setTimeout(() => { resizing.value = false; composerRef.value?.fitTextarea() }, 600)
}
const miniPinned = ref(localStorage.getItem('gugu_mini_pinned') !== 'false')
watch(miniPinned, v => localStorage.setItem('gugu_mini_pinned', String(v)))

// 设置：重开浏览器时是否接续上次对话（默认关＝开新对话）。开关在个人设置→咕咕设置里，
// 写 localStorage『gugu_reopen_resume』；这里 onMounted 时读一次决定要不要接续。
const reopenResume = ref(localStorage.getItem('gugu_reopen_resume') === '1')

const windowRef   = ref<HTMLElement | null>(null)
// 真实可滚动的消息容器和虚拟列表由 GuguChatMessageList 内部持有；这里通过组件
// 实例暴露的 el/scrollToIndex 访问，不在父组件里重新拿一份 DOM 引用。
const messageListRef = ref<InstanceType<typeof GuguChatMessageList> | null>(null)
const messagesEl = computed(() => messageListRef.value?.el ?? null)
// 输入框的 focus/宽度重量高/清空后收起高度同理，通过 GuguChatComposer 暴露的方法操作。
const composerRef = ref<InstanceType<typeof GuguChatComposer> | null>(null)

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
// 窗口层级：进统一窗口带（点谁谁上，见 composables/windowz.ts）；打开时置顶
const chatZ = ref(nextZ())
function raiseChat() { chatZ.value = nextZ() }
watch(open, v => { if (v) raiseChat() })

// 离场动画尚未结束时窗口仍缩回悬浮球，不能提前把球提到窗口前面。
// after-leave 后才恢复常驻最高层，避免关闭瞬间球盖住窗口。
const chatClosing = ref(false)
const fabZ = computed(() => (open.value || chatClosing.value) ? chatZ.value - 1 : 99999)

const windowStyle = computed(() => {
  if (expanded.value) {
    // 右锚 720px，遇到窄屏时不超过导航栏右边界
    const left = Math.max(SIDEBAR_W + 12, vw.value * 0.4 - 12)
    return { top: '12px', right: '12px', bottom: '12px', left: `${left}px`, zIndex: chatZ.value }
  }
  return {
    top:    `${vh.value - 88 - smallH.value}px`,
    left:   `${vw.value - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--floating-edge')) - SMALL_W}px`,
    right:  'var(--floating-edge)',
    bottom: '88px',
    zIndex: chatZ.value,
  }
})

// 播放器联动：小窗打开时顶到窗口上方，其余情况悬在 fab 上方
const miniPlayerStyle = computed(() => {
  const bottom = (open.value && !expanded.value) ? 88 + smallH.value + 8 : 88
  // 小窗展开时播放器远离 FAB，从自身中心缩放；其他状态从 FAB 圆心缩放
  const origin = (open.value && !expanded.value)
    ? '50% 50%'
    : `calc(100% - 25px) calc(100% + ${bottom - 53}px)`
  // 跟随聊天窗相对层级：展开态在窗后（-1）、小窗态顶在窗前（+1）
  const zIndex = expanded.value ? chatZ.value - 1 : chatZ.value + 1
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
  if (open.value) {
    closeChat()
    return
  }
  open.value = true
  if (open.value) {
    if (!expanded.value) contentH.value = SMALL_H
    trackApi.track('chat_open').catch(() => {})
    await nextTick()
    stick.value = true
    _baseScrollH = messagesEl.value?.scrollHeight || 0   // 基线 = 打开时的历史内容高度
    scrollToBottom()
  }
}

function closeChat() {
  chatClosing.value = true
  open.value = false
  expanded.value = false
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', saveProgress)
  // 拉一次状态显示名（目前只用到「思考中」候选文案；失败就保持默认三个点）
  agentApi.getUiLabels?.().then(r => {
    thinkingLabels.value = Array.isArray(r?.thinking) ? r.thinking : (r?.thinking ? [r.thinking] : [])
  }).catch(() => {})
  // 恢复上次会话：① 本标签刷新 → sessionStorage 仍在，直接接续；② 重开浏览器（sessionStorage 已清）
  //   → 仅当设置「重开接续上次」打开时，从 localStorage 的最近一段接续；否则开新对话。
  const saved = sessionStorage.getItem(SESSION_KEY)
              || (reopenResume.value ? localStorage.getItem(LAST_SESSION_KEY) : null)
  if (saved) {
    messages.value = []   // 续聊：立刻清掉默认问候占位，避免 loadSession 异步加载期间 animateGreeting 闪问候
    loadSession(Number(saved)).then(() => {
      if (sessionId.value !== Number(saved)) {   // 那段会话没了（删了/无权限）→ 清存档、恢复问候、当新对话
        sessionStorage.removeItem(SESSION_KEY)
        localStorage.removeItem(LAST_SESSION_KEY)
        messages.value = [{ id: mkid(), role: 'ai', text: '', html: '', time: now(), _greeting: true }]
        prefetchGreeting()
      }
    })
  } else {
    // 全新对话（无可恢复会话）才需要默认问候 → 此刻后台生成；刷新/接续停在老会话时不空跑。
    prefetchGreeting()
  }
})
onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  window.removeEventListener('beforeunload', saveProgress)
})

// ── 对话状态 ────────────────────────────────────────────
const inputText      = ref('')
const thinkingLabels = ref<string[]>([])   // 「思考中」候选文案（后台「状态命名」_thinking，可多个 | 分隔；空=三个点）
const streaming      = ref(false)
// 状态气泡贯穿整个生成期：工具/复查/思考只替换同一个气泡的内容，直到真实输出或中断。
const statusKind     = ref('')   // '' | 'text'（工具/自定义思考）| 'dots'（默认思考三点）
const statusTyped    = ref('')   // 当前显示的文字（dots 时为空）
const isTypingText   = computed(() => streaming.value && !statusKind.value)
const fabJumping     = ref(false)
watch(isTypingText, v => {
  if (v) { fabJumping.value = true; setTimeout(() => { fabJumping.value = false }, 350) }
})

interface StatusItem { kind: 'text' | 'dots' | 'hide'; label?: string }

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
const sessionId      = ref<number | null>(null)
// 视图代次：切换/新建会话时立即递增，让尚未完成的旧 SSE 流失去写入当前消息列表的资格。
let _chatViewGeneration = 0
// 当前会话所属渠道里「owner」的平台身份（仅群聊/IM 用得上）：消息的
// platformUserId 等于它才归到右侧气泡，否则是群里其他成员，归左侧并标 username。
const ownerPlatformUserId = ref<string | null>(null)
// 当前会话是不是群聊——只有群聊才需要在左侧气泡上方标"咕咕"/群成员 username，
// 1:1 对话左侧默认就是咕咕，不用额外标注，保持原有视觉不变。
const isGroupSession = ref(false)
const abortCtrl      = ref<AbortController | null>(null)
const pendingQueue   = ref<string[]>([])   // 生成中发的消息，排队等流式结束后接着发
function _chatTip(text: string) { messages.value.push({ id: mkid(), role: 'ai', text, time: now() }) }

// 附件（选择/拖拽/粘贴/暂存上传）与语音录制的唯一状态所有权在 useChatAttachments；
// 这里单次实例化，因为 send() 仍需要直接读 pendingAtt 来拼发送 payload。
const {
  pendingAtt, attUploading, fileInput, pickFile, uploadAttachFiles, onFilePicked,
  chatDrag, isChatDragging, onChatDragEnter, onChatDragOver, onChatDragLeave, onChatDrop, onPaste,
  removeAtt,
  recording, recordSecs, startRecord, stopRecord, cancelRecord,
} = useChatAttachments({
  onError: (text) => _chatTip(text),
  onVoiceSent: () => { send() },   // 录完即发（含可能已输入的文字）
})

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

const copiedId = ref<number | null>(null)

async function downloadFile(f: ChatFile) {
  if (f.attach_id) {
    // 聊天上传的暂存附件：走 /agent/attachment/{id}/download
    const token = localStorage.getItem('user_token') ?? ''
    const res = await fetch(`${API_BASE}/agent/attachment/${f.attach_id}/download`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!res.ok) { console.error('附件下载失败', res.status); return }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${f.qq_face ? 'QQ表情' : f.name}.${f.ext}`
    document.body.appendChild(a); a.click()
    setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)
    return
  }
  if (f.file_id == null) return
  try { await filesApi.download(f.file_id, `${f.qq_face ? 'QQ表情' : f.name}.${f.ext}`) }
  catch (e) { console.error('下载失败', e) }
}

const previewStore = usePreviewStore()
function openFileFromChat(f: ChatFile) {
  if (canPreview(f)) {
    const displayName = f.qq_face ? 'QQ表情' : f.name
    previewStore.open({
      id: f.file_id ?? undefined,
      attach_id: f.attach_id ?? null,
      ext: (f.ext || '').toUpperCase(),
      displayName,
      size: fmtSize(f.size_bytes),
      // 真实像素尺寸（有的话）：预览窗口直接按此定尺，不用再靠缩略图猜大小
      imgWidth: f.img_width ?? null,
      imgHeight: f.img_height ?? null,
    })
    return
  }
  downloadFile(f)
}

function copyMsg(msg: ChatMessage) {
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
const messages = ref<ChatMessage[]>([
  { id: mkid(), role: 'ai', text: '', html: '', time: now(), _greeting: true },
])

// ── 长会话虚拟列表 ────────────────────────────────────────────────────────────
// 网络层不变，仍一次性把整条会话历史拉回来（messages 是完整数据，搜索跳转靠它按 dbId
// 定位）。DOM 层（真实可滚动容器 + @tanstack/vue-virtual 实例 + 逐行测量 + html 懒渲染
// 回填）收在 GuguChatMessageList.vue 里，这里只通过 messageListRef 暴露的
// scrollToIndex 驱动滚动，不重新持有一份 virtualizer。

// 会话内定位到某条历史消息（全局搜索跳转用）：先按 dbId 找到下标，用虚拟列表的
// scrollToIndex 滚过去（数据本来就在 messages 里，不用管它当前有没有挂 DOM），
// 等它挂载出来再交给 _flashChatMessage 做高亮。
async function _revealMessage(dbId: number) {
  const idx = messages.value.findIndex(m => m.dbId === dbId)
  if (idx === -1) return
  stick.value = false   // 跳去的多半是历史消息，不该被当成「回到底部」处理
  messageListRef.value?.scrollToIndex(idx, { align: 'center', behavior: 'auto' })
  await nextTick()
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
// 任何打开路径（FAB / 通知点开 / 展开）都触发一次
watch(open, (v) => { if (v) { animateGreeting(); loadBots(); loadQuota(); pickOfflineLabel() } })

// ── 展开/收起 ────────────────────────────────────────────
const sessions = ref<ChatSession[]>([])
const webSessions = computed(() => sessions.value.filter(s => !s.source || s.source === 'web'))
const imSessions  = computed(() => sessions.value.filter(s => s.source && s.source !== 'web'))
const currentSessionTitle = computed(() =>
  !sessionId.value ? '新对话' : (sessions.value.find(s => s.id === sessionId.value)?.title ?? '对话')
)

async function fetchSessions() {
  try { sessions.value = await agentApi.listSessions() } catch {}
}

// ── 侧栏 IM 接入（飞书 / QQ / 微信）：未接入显示扫码连接抽屉，接入后变成该平台会话抽屉 ──
type ImPlatformKey = 'feishu' | 'qq' | 'wechat'
interface ImPlatformApi { start: () => Promise<any>; poll: (id: any) => Promise<any> }
interface ImPlatform { key: ImPlatformKey; label: string; api: ImPlatformApi }
const IM_PLATFORMS: ImPlatform[] = [
  { key: 'feishu',  label: '飞书', api: feishuConnectApi },
  { key: 'qq',   label: 'QQ',   api: qqConnectApi },
  { key: 'wechat',  label: '微信', api: wechatConnectApi },
]
const bots   = ref<Bot[]>([])
const imOpen = reactive<Record<ImPlatformKey, boolean>>({ feishu: false, qq: false, wechat: false })
// Sidebar 只需要 key/label 展示，api 对象（feishuConnectApi 等）留在这里，
// startImConnect/openChatImBind 仍按 IM_PLATFORMS.find(...) 查找。
const imPlatformOptions = computed(() => IM_PLATFORMS.map(p => ({ key: p.key, label: p.label })))
const imOnline    = computed(() => bots.value.some(b => b.enabled))   // 有「启用中」的 IM bot 才算在线（停用/残留不算）

// ── 顶部状态：休息中（精力耗尽）> 在线（任意 IM 启用）> 随机离线 ──
const quota = ref<QuotaInfo | null>(null)
async function loadQuota() { try { quota.value = await authApi.getQuota() } catch {} }
const energyExhausted = computed(() => {
  const q = quota.value
  if (!q) return false
  return (q.limit_6h != null && (q.used_6h ?? 0) >= q.limit_6h) ||
         (q.limit_weekly != null && (q.used_weekly ?? 0) >= q.limit_weekly)
})
// 离线时随机显示「QQ/微信/飞书 离线」之一（每次打开换一个，暗示这些渠道还没接上）
const _OFFLINE_LABELS = ['QQ 离线', '微信离线', '飞书离线']
const offlineLabel = ref('离线')
function pickOfflineLabel() { offlineLabel.value = _OFFLINE_LABELS[Math.floor(Math.random() * _OFFLINE_LABELS.length)] }
const presenceKind  = computed(() => energyExhausted.value ? 'resting' : (imOnline.value ? 'online' : 'offline'))
const presenceText  = computed(() => presenceKind.value === 'resting' ? '休息中'
                                   : presenceKind.value === 'online'  ? '在线' : offlineLabel.value)
const presenceTitle = computed(() => presenceKind.value === 'resting' ? '咕咕精力用完了，歇会儿就回来～'
                                   : presenceKind.value === 'online'  ? '咕咕在线'
                                   : '咕咕还没接到你的微信 / QQ / 飞书——点一下接上，随时随地找它')
const imHighlight = ref(false)
const sidebarRef  = ref<InstanceType<typeof GuguChatSidebar> | null>(null)
const botsOf = (platform: ImPlatformKey) => bots.value.filter(b => b.platform === platform)
const imSessionsOf = (platform: ImPlatformKey) => imSessions.value.filter(s => s.source === platform)

async function loadBots() {
  try { const r = await userBotsApi.list(); bots.value = r.items || [] } catch {}
}
function toggleImPlatform(key: ImPlatformKey) { imOpen[key] = !imOpen[key] }

// 离线状态被点击：展开大窗 → 摊开各 IM 抽屉露出「扫码连接」→ 高亮 IM 区一下（暗示式引导，不强推）
async function promptConnectIM() {
  if (!expanded.value) await enterExpanded()
  else loadBots()
  IM_PLATFORMS.forEach(p => { imOpen[p.key] = true })
  await nextTick()
  sidebarRef.value?.imGroupEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  imHighlight.value = false   // 重置以便点第二次也能重放动画
  await nextTick()
  imHighlight.value = true
  setTimeout(() => { imHighlight.value = false }, 2600)
}

// 通用扫码连接（建任务 → 渲染二维码 → 轮询 → 自动写 user_bot，与 ProfileModal 同一套 API）
const connecting    = ref('')        // 正在生成二维码的平台 key
const connect       = ref<ImConnectState | null>(null)      // { platform, id } 连接进行中
const connectHint   = ref('')
const connectErr    = ref('')
const connectCanvas = ref<HTMLCanvasElement | null>(null)
let   connectPoll: ReturnType<typeof setInterval> | null = null
function setConnectCanvas(el: Element | ComponentPublicInstance | null) { if (el) connectCanvas.value = el as HTMLCanvasElement }   // v-for 内函数 ref，避免数组 ref

async function startImConnect(platform: ImPlatformKey) {
  const p = IM_PLATFORMS.find(x => x.key === platform)
  if (!p) return
  connecting.value = platform; connectErr.value = ''
  try {
    const r = await p.api.start()
    connect.value = { platform, id: r.poll_id || r.task_id }   // 飞书 poll_id / QQ & 微信 task_id
    connectHint.value = platform === 'feishu'
      ? '手机飞书扫码 → 授权创建机器人，授权后自动连接'
      : platform === 'wechat'
        ? '手机微信扫码 → 授权后自动连接'
        : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'
    await nextTick()
    await QRCode.toCanvas(connectCanvas.value, r.scan_url, { width: 160, margin: 1 })
    _startImPoll(p)
  } catch (e: any) {
    connectErr.value = e?.message || '生成二维码失败'
    connect.value = null
  } finally { connecting.value = '' }
}
function _startImPoll(p: ImPlatform) {
  _stopImPoll()
  let tries = 0
  connectPoll = setInterval(async () => {
    tries++
    try {
      const r = await p.api.poll(connect.value?.id)
      if (r.status === 'success') { cancelImConnect(); await loadBots(); await fetchSessions() }
      else if (r.status === 'expired') { connectErr.value = '二维码已过期，请重新扫码'; cancelImConnect() }
      else if (r.status === 'fail') { connectErr.value = '连接失败：' + (r.reason || '未知'); cancelImConnect() }
    } catch {}
    if (tries > 100) cancelImConnect()   // ~5 分钟超时
  }, 3000)
}
function _stopImPoll() { if (connectPoll) { clearInterval(connectPoll); connectPoll = null } }
function cancelImConnect() { _stopImPoll(); connect.value = null }

// ── 聊天内「扫码绑定 IM」：咕咕回复里输出 [文案](gugu://bind-im/<platform>) 当按钮，
//    点击 → 这里弹小窗扫码（复用 IM_PLATFORMS 的 start/poll，与侧栏同一套后端，互不干扰）──
const chatBind = reactive<{ open: boolean; platform: string; label: string; hint: string; err: string; id: string | number | null }>(
  { open: false, platform: '', label: '', hint: '', err: '', id: null }
)
const chatBindCanvas = ref<HTMLCanvasElement | null>(null)
let chatBindPoll: ReturnType<typeof setInterval> | null = null

function onChatActionClick(e: MouseEvent) {
  // 代码块「复制」按钮：渲染时不写内联 onclick（DOMPurify 会剥掉 on*），这里事件委托兜住
  const target = e.target as HTMLElement
  const btn = target.closest?.('.md-copy-btn') as HTMLElement | null
  if (btn) {
    e.preventDefault()
    const text = (btn.closest('.md-code-block')?.querySelector('code') as HTMLElement | null)?.innerText ?? ''
    const done = () => { btn.textContent = '已复制 ✓'; setTimeout(() => { btn.textContent = '复制' }, 1200) }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done)
    } else {
      const a = document.createElement('textarea')
      a.value = text; a.style.position = 'fixed'; a.style.opacity = '0'
      document.body.appendChild(a); a.select()
      try { document.execCommand('copy') } catch {}
      a.remove(); done()
    }
    return
  }
  const a = target.closest?.('a[href^="gugu://"]') as HTMLAnchorElement | null
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href') || ''
  const mBind = href.match(/^gugu:\/\/bind-im\/([a-z]+)/i)
  if (mBind) { openChatImBind(mBind[1]); return }
  const mFile = href.match(/^gugu:\/\/open-file\/(\d+)/i)
  if (mFile) {
    uiStore.pendingFileTarget = { kind: 'file', id: parseInt(mFile[1]) }
    router.push('/files')
  }
}

async function openChatImBind(platform: string) {
  const p = IM_PLATFORMS.find(x => x.key === platform)
  if (!p) return
  _stopChatBindPoll()
  chatBind.platform = platform; chatBind.label = p.label
  chatBind.err = ''; chatBind.hint = ''; chatBind.id = null; chatBind.open = true
  await nextTick()
  try {
    const r = await p.api.start()
    chatBind.id = r.poll_id || r.task_id
    chatBind.hint = platform === 'feishu'
      ? '手机飞书扫码 → 授权创建机器人，授权后自动连接'
      : platform === 'wechat'
        ? '手机微信扫码 → 授权后自动连接'
        : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'
    await nextTick()
    await QRCode.toCanvas(chatBindCanvas.value, r.scan_url, { width: 168, margin: 1 })
    _startChatBindPoll(p)
  } catch (e: any) {
    chatBind.err = e?.message || '生成二维码失败'
  }
}
function _startChatBindPoll(p: ImPlatform) {
  _stopChatBindPoll()
  let tries = 0
  chatBindPoll = setInterval(async () => {
    tries++
    try {
      const r = await p.api.poll(chatBind.id)
      if (r.status === 'success') { closeChatBind(); await loadBots(); await fetchSessions() }
      else if (r.status === 'expired') { chatBind.err = '二维码已过期，关掉再点一次按钮'; _stopChatBindPoll() }
      else if (r.status === 'fail') { chatBind.err = '连接失败：' + (r.reason || '未知'); _stopChatBindPoll() }
    } catch {}
    if (tries > 100) closeChatBind()
  }, 3000)
}
function _stopChatBindPoll() { if (chatBindPoll) { clearInterval(chatBindPoll); chatBindPoll = null } }
function closeChatBind() { _stopChatBindPoll(); chatBind.open = false }

async function enterExpanded() {
  expanded.value = true
  loadBots()
  _markResizing()
  // 真实输入框此时仍在从小窗宽度过渡到大窗宽度；用目标宽度离屏测量，避免把旧宽度的行数
  // 带到动画结束才纠正，也不需要为了兜底提前撑高窗口。
  await nextTick()
  composerRef.value?.fitTextarea(true)
  trackApi.track('chat_expanded').catch(() => {})
  await fetchSessions()
  await nextTick()
  composerRef.value?.focus()
  stick.value = true
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
  composerRef.value?.fitTextarea(false)
  const el = messagesEl.value
  if (!el) return
  stick.value = true
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
    contentH.value = SMALL_H; _sessionTurn = 0
    await nextTick()
    _baseScrollH = messagesEl.value?.scrollHeight || 0   // 基线 = 切入会话的历史高度
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
  composerRef.value?.focus()
}

async function deleteSession(id: number) {
  try {
    await agentApi.deleteSession(String(id))
    sessions.value = sessions.value.filter(s => s.id !== id)
    if (sessionId.value === id) await newSession()
  } catch {}
}

// streaming 跟随意图：只有用户主动上翻才取消，回到底部附近恢复。
const stick   = ref(true)
let _lastTop  = 0     // 上次（多为程序化）滚动后的 scrollTop，用于判别用户上翻

// streaming 用即时滚动跟随，避免 smooth 叠加追不上。用虚拟列表的 scrollToIndex 而不是
// 直接写 scrollTop——最后一条消息的高度可能还只是估算值（还没被 measureElement 量过），
// scrollToIndex 会按当前最新的测量/估算结果算，比直接读 scrollHeight 更准。
function scrollToBottom(smooth = false) {
  const idx = messages.value.length - 1
  if (idx < 0) return
  messageListRef.value?.scrollToIndex(idx, { align: 'end', behavior: smooth ? 'smooth' : 'auto' })
  _lastTop = messagesEl.value?.scrollTop ?? 0   // 记录落点：程序化滚动产生的 scroll 事件不会误判为上翻
}

// 用户上翻 → 停住；滚回接近底部 → 恢复跟随。messagesEl 是真实可滚动容器，scrollHeight
// 由虚拟列表的占位高度撑出来，即使视口外的消息没挂 DOM，这个距离判断依然准确。
function onMsgScroll() {
  const el = messagesEl.value; if (!el) return
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
  _stopImPoll()
  _stopChatBindPoll()
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
            if (_FILE_TOOLS.has(evt.name)) liveStore.bump('files')
            else if (_PROJECT_TOOLS.has(evt.name)) liveStore.bump('projects')
            else if (_CALENDAR_TOOLS.has(evt.name)) liveStore.bump('calendar')
          }
          // 任一工具结束都回到思考态；下一轮工具调用会继续替换文字，不能让气泡闪退。
          if (live()) setStatus(_thinkingItem())
        } else if (evt.type === 'token') {
          if (live()) {
            clearStatus()   // 真回复开始 → 打断状态队列、收起指示，让位给流式正文
            if (aiIdx === -1) playIncomingMessageSfx()
            if (aiIdx === -1) { messages.value.push({ id: mkid(), role: 'ai', text: '', time: now(), streaming: true }); aiIdx = messages.value.length - 1 }
            messages.value[aiIdx].text += evt.content
            await scrollBottom()
          }
        } else if (evt.type === 'file') {
          if (live()) {
            clearStatus()
            if (aiIdx === -1) playIncomingMessageSfx()
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
    refreshAfterTools(r.usedTools)
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
  const atts = fromInput ? pendingAtt.value.slice() : []   // 本次随消息发的附件
  if (!text && !atts.length) return
  if (fromInput) {
    _sessionTurn++
    messages.value.push({ id: mkid(), role: 'user', text, time: now(),
      files: atts.length ? atts.map(a => ({ name: a.name, ext: a.ext, size_bytes: a.size, attach_id: a.attach_id, kind: a.kind, duration: a.duration, upload: true, _thumbUrl: a._thumbUrl, img_width: a.img_width, img_height: a.img_height })) : undefined })
    inputText.value = ''
    pendingAtt.value = []
    composerRef.value?.resetHeight()
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
      loadQuota()   // 回复消耗精力，刷新一次——耗尽时顶部状态即时变「休息中」
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
/* .ai-fab* 已随 GuguChatFab.vue 迁移 */

/* ── 单一聊天窗口 ── */
.chat-window {
  position: fixed;
  /* z-index 由 :style 动态(统一窗口带,点谁谁上) */
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
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
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
.status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--color-success); transition: background .15s, box-shadow .15s; }
/* 离线：克制的暗示——灰点、弱化文字、可点；只在 hover 才微微亮起（点用暖色 + 细光环），平时不抢眼 */
.popup-status.is-offline { color: var(--text-secondary); cursor: pointer; opacity: .85; transition: color .15s, opacity .15s; }
.popup-status.is-offline .status-dot { background: var(--text-secondary); }
.popup-status.is-offline:hover { opacity: 1; color: var(--text-primary); }
.popup-status.is-offline:hover .status-dot { background: var(--color-warning); box-shadow: 0 0 0 3px rgba(176, 120, 88, 0.22); }
/* 休息中（精力耗尽）：暖色、点轻微呼吸，不可点 */
.popup-status.is-resting { color: var(--color-warning); cursor: default; }
.popup-status.is-resting .status-dot { background: var(--color-warning); animation: restPulse 1.8s ease-in-out infinite; }
@keyframes restPulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
/* .im-plat-group/.im-flash 已随 GuguChatSidebar.vue 迁移 */
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

/* .chat-messages 及其内部结构现在整体渲染于 GuguChatMessageList.vue（子组件），
   同样需要 :deep() 才能穿透组件边界匹配。 */
:deep(.chat-messages) {
  flex: 1; overflow-y: auto; overflow-x: hidden; position: relative;
}
.chat-main.is-expanded :deep(.chat-messages .msg-bubble) { max-width: 72%; font-size: 14px; }
.chat-main.is-expanded :deep(.chat-messages .msg-quoted) { max-width: 72%; font-size: 13.5px; }
/* 虚拟列表占位容器：高度由 JS 撑出来（虚拟内容高度 + 顶部留白），撑出的空间给绝对定位的消息行腾地方 */
:deep(.msg-virtual-spacer) { position: relative; width: 100%; }
/* 绝对定位的行不认祖先的 padding（top:0/left:0 是相对边框盒，不是内容盒），
   横向留白（原来 .chat-messages 的左右 padding）和「gap」只能各自摆在每一行自己身上，
   用 box-sizing:border-box 保证不溢出 100% 宽度。 */
:deep(.msg-virtual-row) { position: absolute; top: 0; left: 0; width: 100%; box-sizing: border-box; padding: 0 13px 8px; }
.chat-main.is-expanded :deep(.msg-virtual-row) { padding: 0 24px 12px; }
/* 状态指示气泡不在虚拟列表里，是紧跟在占位容器后面的普通流内元素，补回同款左右留白 + gap */
:deep(.chat-messages > .msg) { margin: 8px 13px 12px; }
.chat-main.is-expanded :deep(.chat-messages > .msg) { margin: 12px 24px 20px; }

/* chat-att-row/chat-input-row/rec-bar/att-btn 自身样式已随 GuguChatComposer.vue 迁移；
   这里只留跨组件的祖先态覆盖（大窗态放大按钮/输入区），用 :deep() 穿透子组件 scope。 */
.chat-main.is-expanded :deep(.att-btn) { height: 32px; }   /* 放大态对齐放大发送按钮(32) */
.chat-main.is-expanded :deep(.chat-input-row) { padding: 14px 20px; gap: 10px; }
.chat-main.is-expanded :deep(.rec-bar) { height: 32px; }   /* 放大态对齐 32 */
/* 大窗的附件/发送按钮为 32px；单行输入也占满同一高度，图标和文字的视觉中线才一致。 */
.chat-main.is-expanded :deep(.chat-input-row textarea) { padding: 5.5px 0; }
/* 小窗输入字号略小，与小窗整体一致 */
.chat-main:not(.is-expanded) :deep(.chat-input-row textarea) { font-size: 13px; }

/* 侧栏相关样式（会话列表、新建会话、IM 平台抽屉、扫码连接框）已随
   GuguChatSidebar.vue 迁移。.exp-icon-btn 仍留着——窗口头部「收起」按钮
   （不在侧栏里）还在用。 */
.exp-icon-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s; flex-shrink: 0;
}
.exp-icon-btn:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.exp-icon-btn svg { display: block; }

/* 咕咕回复里的动作按钮：md 里的 gugu:// 链接渲染成按钮（onChatActionClick 拦截点击）——
   跟全局 .press-fx 一套手感（悬停不上浮，只在按下时下沉），这些 <a> 是 markdown 渲染出来的、
   没法在模板里挂 class，数值直接写这里（hover/active 与全局 .press-fx 保持一致） */
/* .msg-bubble.md-body 本体现在渲染于 GuguChatMessageRow.vue（子组件，无 data-v-GuguChat
   属性），这里必须整条选择器都用 :deep() 才能穿透组件边界匹配到，光把内层 a 包 :deep()
   不够——外层 class 名同样带着父组件的 scope 校验。 */
:deep(.msg-bubble.md-body a[href^="gugu://"]) {
  display: inline-flex; align-items: center; gap: 5px;
  margin: 3px 4px 3px 0; padding: 5px 12px;
  font-size: 12.5px; font-weight: 600; text-decoration: none;
  color: #fff; background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border-radius: 999px; box-shadow: 0 2px 8px rgba(123,127,178,0.28);
  cursor: pointer; transition: box-shadow 0.12s, transform 0.15s ease, opacity 0.15s ease; user-select: none;
}
:deep(.msg-bubble.md-body a[href^="gugu://"]:hover) {
  box-shadow: 0 4px 14px rgba(80,90,110,0.3); opacity: 1;
}
:deep(.msg-bubble.md-body a[href^="gugu://"]:active) { transform: translateY(1px); opacity: 0.93; }

/* 扫码绑定弹窗（聊天上弹小窗）*/
.cb-overlay {
  position: absolute; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  /* 极轻遮罩、不压暗（仅用于点外面关闭 + 一点聚焦）——避免把弹窗玻璃衬得发灰发透，
     让它和右键菜单一样浮在亮内容上、显得更实 */
  background: rgba(0,0,0,0.04);
}
.cb-modal {
  /* 玻璃外观复用全局 .popup-menu（与右键菜单完全一致）；这里只管布局 + 固定宽度（防止加载前后变宽）*/
  display: flex; flex-direction: column; align-items: center; gap: 9px;
  width: 230px; box-sizing: border-box;
  padding: 18px 20px 14px;
}
.cb-title { font-size: 13.5px; font-weight: 700; color: var(--text-primary); }
.cb-qr {
  width: 168px; height: 168px; border-radius: 10px;
  background: #fff; padding: 6px; box-sizing: border-box;
  box-shadow: 0 2px 10px rgba(123,127,178,0.18);
}
.cb-hint, .cb-err {
  font-size: 11.5px; text-align: center; line-height: 1.5; max-width: 190px;
  min-height: 33px;          /* 预留 ~2 行：二维码/提示加载前后弹窗高度不跳 */
  display: flex; align-items: center; justify-content: center;
}
.cb-hint { color: var(--text-secondary); }
.cb-err  { color: rgba(200,80,80,0.9); }
.cb-cancel {
  margin-top: 2px; padding: 5px 16px; font-size: 12px;
  color: var(--text-secondary); background: rgba(123,127,178,0.1);
  border: none; border-radius: 999px; cursor: pointer;
}
.cb-cancel:hover { background: rgba(123,127,178,0.18); }
/* .im-qr-cancel 已随 GuguChatSidebar.vue 迁移 */

/* .exp-send-btn/.send-btn 已随 GuguChatComposer.vue 迁移 */

/* ── 消息气泡 ──
   .msg 本体在 GuguChatMessageList.vue 渲染，.msg-bubble/.msg-files/.msg-footer 等
   在 GuguChatMessageRow.vue 渲染——都是子组件，没有本文件的 data-v-GuguChat 属性，
   整条选择器必须用 :deep() 才能跨组件边界匹配，否则样式全部失效（只剩默认 HTML 样式）。 */
:deep(.msg) { display: flex; flex-direction: column; min-width: 0; }
:deep(.msg.user) { align-items: flex-end; }
:deep(.msg-search-flash) { animation: msg-search-flash 1.8s ease forwards; border-radius: 12px; }
@keyframes msg-search-flash {
  0%   { background: rgba(123,127,178,0.18); }
  35%  { background: rgba(123,127,178,0.18); }
  100% { background: transparent; }
}

:deep(.msg.ai) { align-items: flex-start; }
/* 群成员消息（非 owner、非咕咕）：左侧，跟 ai 同一侧但气泡样式区分开，避免跟
   咕咕的回复混淆。 */
:deep(.msg.member) { align-items: flex-start; }
:deep(.msg-bubble) {
  padding: 9px 13px; border-radius: 13px;
  font-size: var(--gugu-body-size); line-height: var(--gugu-body-line); max-width: 88%;
  word-break: break-word; overflow-wrap: break-word;
}
:deep(.msg.ai .msg-bubble) {
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.65);
  border-bottom-left-radius: 4px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
}
:deep(.msg.member .msg-bubble) {
  background: rgba(123,127,178,0.08); border: 1px solid rgba(123,127,178,0.18);
  border-bottom-left-radius: 4px;
}
:deep(.msg.user .msg-bubble) {
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: white;
  border-bottom-right-radius: 4px;
}
:deep(.msg-speaker) {
  font-size: 11px; color: var(--text-secondary); margin: 0 2px 3px;
  font-weight: 600;
}
/* 引用/回复预览条：浅色小字，跟正文气泡区分开——只是提示"引用了什么"，不是正文。
   截到 8 行，超出部分靠 hover 的原生 title 提示看全文，避免长引用只剩一小段看不出内容。 */
:deep(.msg-quoted) {
  max-width: 88%; margin-bottom: 4px; padding: 6px 10px;
  font-size: 12.5px; line-height: 1.5; color: var(--text-secondary);
  background: rgba(123,127,178,0.08); border-left: 2.5px solid rgba(123,127,178,0.45);
  border-radius: 4px; white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden;
}
:deep(.msg-quoted-thumb) {
  display: block; width: 112px; height: 112px; margin-top: 5px; object-fit: cover;
  border-radius: 8px; cursor: pointer; border: 1px solid rgba(123,127,178,0.18);
}
:deep(.msg-face-image-wrap) {
  max-width: 150px; margin-top: 5px; cursor: pointer; line-height: 0;
}
:deep(.msg-face-image) {
  display: block; width: 128px; height: 128px; max-width: 100%; object-fit: contain;
  border-radius: 12px;
}
/* 咕咕发来的文件卡片 */
:deep(.msg-files) { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; max-width: 88%; min-width: 0; }
/* 按下反馈来自全局 .press-fx（模板里已加）——只要点击下沉，不要悬停抬起：
   这条挤在其它消息气泡中间，抬起会显得跟旁边气泡割裂 */
:deep(.msg-file) {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer;
  max-width: 100%; box-sizing: border-box;
  /* 和 AI 气泡同款：半透明白 + 左下角小尾巴 + 内高光，营造气泡感 */
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.65);
  border-radius: 14px; border-bottom-left-radius: 5px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 3px rgba(80,80,120,0.06);
  /* transform/opacity 是按下反馈(.press-fx)要用的——跟这里自己的 transition 写一起，
     避免两条规则的 transition 互相整体覆盖、丢掉其中一份 */
  transition: background 0.2s ease, box-shadow 0.25s ease,
    transform 0.15s ease, opacity 0.15s ease;
}
:deep(.msg-file.press-fx:hover) {
  background: rgba(255,255,255,0.7);
  /* 覆盖全局 .press-fx.press-fx:hover 的按钮阴影，避免文件气泡 hover 瞬间换影。 */
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 3px 10px rgba(100,110,200,0.14) !important;
}
:deep(.msg-file-ext) {
  position: relative; overflow: hidden;
  flex-shrink: 0; width: 34px; height: 34px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: #fff; letter-spacing: 0.02em;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
}
/* 图片附件：缩略图覆盖 ext 角标；加载失败时 @error 移除自身，露出底下角标 */
:deep(.msg-file-thumb) {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; display: block;
}
:deep(.msg-file-info) { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
:deep(.msg-file-name) { font-size: 15px; font-weight: 500; color: #2a2c3a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:deep(.msg-file-meta) { font-size: 12px; color: #9296ad; }
:deep(.msg-file-dl) { flex-shrink: 0; color: #7b7fb2; }
/* 语音条：迷你播放条（播放钮 + 波形 + 时长），和文件卡同款气泡质感 */
:deep(.msg-voice) {
  display: inline-flex; align-items: center; gap: 9px; padding: 8px 13px; cursor: pointer;
  max-width: 100%; box-sizing: border-box; user-select: none;
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.65);
  border-radius: 14px; border-bottom-left-radius: 5px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 3px rgba(80,80,120,0.06);
  transition: background 0.15s, box-shadow 0.15s;
}
:deep(.msg-voice:hover) { background: rgba(255,255,255,0.72); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 3px 10px rgba(100,110,200,0.14); }
:deep(.msg-voice .mv-btn) {
  flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; color: #fff;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); box-shadow: 0 1px 3px rgba(110,110,170,0.3);
}
:deep(.msg-voice .mv-wave) { display: flex; align-items: center; gap: 2px; height: 18px; }
:deep(.msg-voice .mv-wave i) { width: 2.5px; border-radius: 2px; background: #b0b2cc; transition: background 0.2s; }
:deep(.msg-voice.playing .mv-wave i) { background: #8186bd; animation: mv-pulse 0.9s ease-in-out infinite; }
:deep(.msg-voice .mv-wave i:nth-child(even)) { animation-delay: 0.15s; }
:deep(.msg-voice .mv-wave i:nth-child(3n)) { animation-delay: 0.3s; }
@keyframes mv-pulse { 0%,100% { transform: scaleY(0.6); } 50% { transform: scaleY(1); } }
:deep(.msg-voice .mv-dur) { font-size: 12.5px; color: #7e82a6; font-variant-numeric: tabular-nums; flex-shrink: 0; }
/* 用户(右侧)发的附件卡：气泡尾巴翻到右下、左下回正常圆角、容器右对齐 */
:deep(.msg.user .msg-files) { align-items: flex-end; }
:deep(.msg.user .msg-file) { border-bottom-left-radius: 14px; border-bottom-right-radius: 5px; }
:deep(.msg.user .msg-voice) { border-bottom-left-radius: 14px; border-bottom-right-radius: 5px; }
:deep(.msg-footer) {
  display: flex; align-items: center; gap: 4px;
  margin-top: 3px; padding: 0 3px;
}
:deep(.msg-time) { font-size: 10px; color: var(--text-secondary); }
:deep(.msg-copy-btn) {
  width: 18px; height: 18px; border-radius: 4px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0; opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}
:deep(.msg:hover .msg-copy-btn) { opacity: 1; }
:deep(.msg-copy-btn:hover) { background: rgba(0,0,0,0.07); color: var(--color-primary); }
:deep(.msg-copy-btn svg) { display: block; }

/* ── 思考/工具动画（状态气泡渲染于 GuguChatMessageList.vue，同样需要 :deep()） ── */
:deep(.thinking) { display: flex; gap: 4px; align-items: center; padding: 16px 13px; }
:deep(.thinking span) {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--color-primary); animation: bounce 1.2s infinite; opacity: 0.6;
}
:deep(.thinking span:nth-child(2)) { animation-delay: 0.2s; }
:deep(.thinking span:nth-child(3)) { animation-delay: 0.4s; }
@keyframes bounce { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-5px); } }

/* 状态气泡只在生成开始时入场，后续状态切换只更新文字。 */
:deep(.status-pop) { animation: statusPop 0.3s cubic-bezier(0.2, 0.8, 0.3, 1) both; }
@keyframes statusPop { from { opacity: 0; transform: translateY(7px) scale(0.96); } to { opacity: 1; transform: none; } }

:deep(.tool-bubble) { display: flex; align-items: center; gap: 8px; color: var(--color-primary); }
:deep(.tool-spinner) {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid rgba(123,127,178,0.25); border-top-color: var(--color-primary);
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
:deep(.tool-label) { font-weight: 600; }

/* ── Markdown ── */
/* md 排版由通用组件 MarkdownView 提供；这里只保留聊天气泡的内边距（渲染于
   GuguChatMessageRow.vue，同样需要 :deep()） */
:deep(.md-body) { padding: 10px 13px; }

/* .mini-player 与 .mp-开头的样式已随 GuguChatMiniPlayer.vue 迁移 */
</style>
