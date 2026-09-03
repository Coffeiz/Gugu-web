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

  <!-- 聊天窗口（单一元素，小/大状态通过位置过渡）。窗口外壳/标题栏/消息列表/输入框
       收在 GuguChatWindow.vue；扫码绑定弹窗与侧边栏通过插槽填充（ref 由本组件持有，
       供 useChatImConnect 使用）。 -->
  <Transition name="chat-open" @after-leave="chatClosing = false">
    <GuguChatWindow
      v-if="open"
      ref="windowRef"
      :window-style="windowStyle" :expanded="expanded" :resizing="resizing"
      :owner-z="chatZ"
      :streaming="streaming" :is-chat-dragging="isChatDragging"
      :current-session-title="currentSessionTitle"
      :current-session-workspace-name="currentSessionWorkspaceName"
      :current-session-goal-active="currentSessionGoalActive"
      :current-session-goal-status="currentSessionGoalStatus"
      :session-id="sessionId"
      :presence-kind="presenceKind" :presence-text="presenceText" :presence-title="presenceTitle"
      :messages="messages" :is-group-session="isGroupSession"
      :copied-id="copiedId" :voice-playing-id="voicePlayingId"
      :status-kind="statusKind" :status-typed="statusTyped"
      :session-settling="sessionSettling"
      v-model:input-text="inputText"
      :references="inputReferences" @update:references="inputReferences = $event"
      :pending-att="pendingAtt" :att-uploading="attUploading"
      :recording="recording" :record-secs="recordSecs" :vw="vw"
      :on-remove-att="removeAtt"
      :on-start-record="startRecord" :on-cancel-record="cancelRecord" :on-stop-record="stopRecord"
      :on-file-picked="onFilePicked" :on-paste="onPaste"
      :on-send="() => send()" :on-stop-streaming="stopStreaming"
      :on-copy="copyMsg" :on-toggle-voice="toggleVoice"
      :on-open-file="openFileFromChat" :on-download="downloadFile" :on-action-click="onChatActionClick"
      :on-interaction-select="onInteractionSelect"
      :on-reference-click="onReferenceClick"
      :on-prompt-connect="promptConnectIM"
      :on-rename-session="renameSession"
      :on-enter-expanded="enterExpanded" :on-exit-expanded="exitExpanded"
      :on-close="closeChat" :on-raise-chat="raiseChat"
      :on-drag-enter="onChatDragEnter" :on-drag-over="onChatDragOver"
      :on-drag-leave="onChatDragLeave" :on-drop="onChatDrop"
    >
      <!-- 扫码绑定 IM 弹窗：咕咕回复里点 [扫码绑定…](gugu://bind-im/<platform>) 按钮触发，复用现有连接 API -->
      <template #bind-dialog>
        <GuguChatBindDialog
          ref="bindDialogRef"
          :open="chatBind.open" :label="chatBind.label" :hint="chatBind.hint" :err="chatBind.err"
          @close="closeChatBind"
        />
      </template>

      <!-- 侧边栏（仅大窗） -->
      <template #sidebar>
        <GuguChatSidebar
          v-if="expanded" ref="sidebarRef"
          :im-platforms="imPlatformOptions" :im-open="imOpen" :im-highlight="imHighlight"
          :bots-of="botsOf" :im-sessions-of="imSessionsOf"
          :web-sessions="webSessions" :session-id="sessionId"
          :connect="connect" :connect-hint="connectHint" :connect-err="connectErr" :connecting="connecting"
          :on-toggle-platform="toggleImPlatform" :on-set-connect-canvas="setConnectCanvas"
          :on-start-im-connect="startImConnect" :on-cancel-im-connect="cancelImConnect"
          :on-load-session="loadSession" :on-delete-session="deleteSession" :on-new-session="newSession"
          :on-rename-session="renameSession"
        />
      </template>
    </GuguChatWindow>
  </Transition>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAudioStore } from '@/stores/audio'
import { useUiStore } from '@/stores/ui'
import { usePreviewStore } from '@/stores/preview'
import { agentApi, filesApi, trackApi, authApi, getToken } from '@/services/api'
import { prefetchGreeting } from '@/composables/shared/useGreeting'
import GuguChatFab from './GuguChatFab.vue'
import GuguChatMiniPlayer from './GuguChatMiniPlayer.vue'
import GuguChatSidebar from './GuguChatSidebar.vue'
import GuguChatBindDialog from './GuguChatBindDialog.vue'
import GuguChatWindow from './GuguChatWindow.vue'
import type { ChatMessage, ChatFile, ChatReference, ImPlatformKey } from './chatTypes'
import { API_BASE } from './chatConstants'
import { renderMd } from './markdown'
import { canPreview, fmtSize } from './messageDisplay'
import { useChatAudio } from './composables/useChatAudio'
import { useChatAttachments } from './composables/useChatAttachments'
import { useChatActions } from './composables/useChatActions'
import { useChatConversation } from './composables/useChatConversation'
import { useChatImConnect } from './composables/useChatImConnect'
import { useChatWindow } from './composables/useChatWindow'
import { useMindRefActions } from '@/composables/mind/useMindRefActions'
const { t } = useI18n()

interface QuotaInfo {
  limit_6h?: number | null
  used_6h?: number
  limit_weekly?: number | null
  used_weekly?: number
}

const audioStore    = useAudioStore()
const uiStore       = useUiStore()
const router        = useRouter()

// 顶栏全局搜索点「对话」结果 / 笔记里点「@对话」引用卡片：打开聊天面板并切到该会话。
// 不强制展开大窗——默认保持小窗，用户已经开着大窗才维持大窗；对话引用现在锚定的是
// 具体一条消息（见 useMindRefActions.ts），靠 _flashChatMessage 在消息列表里定位闪烁，
// 小窗一样看得见，不需要靠「大窗侧边栏 .active 高亮」这条路。
watch(() => uiStore.pendingChatSession, async (id) => {
  if (!id) return
  open.value = true
  await conversation.loadSession(id as number)
  const msgId = uiStore.pendingChatMessageId
  uiStore.pendingChatSession = null
  uiStore.pendingChatMessageId = null
  if (msgId) { await conversation._revealMessage(msgId); conversation._flashChatMessage(msgId) }
})

// gugu:// 协议链接（复制代码/绑定 IM/打开文件）+ 工具完成后的前端刷新通知，收在 useChatActions。
const { refreshAfterTools, onChatActionClick } = useChatActions({
  router,
  onBindPlatform: (platform) => openChatImBind(platform),
  onOpenObject: (type, id) => { void openChatObject(type, id) },
  onOpenSkill: (slug) => { void router.push({ path: '/skills', query: { skill: slug } }) },
})
const { openMindRef } = useMindRefActions()
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

// ── 窗口状态 / 位置 / 尺寸 / 层级 / 通知锚点 / 小窗高度跟随：见 useChatWindow.ts。
// 该 composable 拥有 chat-window / expanded / resizing / windowStyle / miniPlayerStyle
// / notifyAnchor / notifyOrigin / chatZ / contentH / _baseScrollH / syncSmallH 等。
// 三个钩子（onContentReset / onCaptureBaseScrollH / onSyncSmallH）由它内部定义并
// 暴露，本组件把它们传给 useChatConversation，把「内容变化 → 窗口尺寸跟随」这条
// 链收在 useChatWindow 内闭环，不在本组件里写半透半遮的中间层。
const windowRef = ref<InstanceType<typeof GuguChatWindow> | null>(null)
// 把 GuguChatWindow 暴露的 DOM/组件引用包装成 useChatConversation / useChatWindow 需要的形态。
const messageListRef = computed(() => windowRef.value?.messageListRef ?? null)
const composerRef   = computed(() => windowRef.value?.composerRef ?? null)
const messagesEl    = computed(() => windowRef.value?.messageListRef?.el ?? null)
const windowElRef   = computed(() => windowRef.value?.el ?? null)

const {
  open, expanded, resizing, chatClosing, chatZ, fabZ,
  vw, vh,
  windowStyle, miniPlayerStyle,
  miniPinned, reopenResume,
  raiseChat, closeChat, markResizing, playIncomingMessageSfx,
  resetContentH, captureBaseScrollH, setBaseScrollH, syncSmallH,
  onContentReset, onCaptureBaseScrollH, onSyncSmallH,
  SESSION_KEY, LAST_SESSION_KEY,
} = useChatWindow({
  windowRef: windowElRef,
  composerRef,
  messagesEl,
})

// 通知锚点 / 缩放原点变化已经由 useChatWindow 内 watch 写入 uiStore，这里只读

async function toggleOpen() {
  if (open.value) { closeChat(); return }
  open.value = true
  if (!expanded.value) resetContentH()
  trackApi.track('chat_open').catch(() => {})
  await nextTick()
  stick.value = true
  captureBaseScrollH()   // 基线 = 打开时的历史内容高度
  await scrollBottom(true)
}

// 展开：调大窗布局 + 加载会话列表 + 滚到底 + 校准输入框
async function enterExpanded() {
  expanded.value = true
  loadBots()
  markResizing()
  // 真实输入框此时仍在从小窗宽度过渡到大窗宽度，输入高度统一在过渡结束后校准，
  // 避免用中间态宽度测量导致窗口先撑高再回落。
  await nextTick()
  trackApi.track('chat_expanded').catch(() => {})
  await fetchSessions()
  await nextTick()
  composerRef.value?.focus?.()
  stick.value = true
  const el = messagesEl.value
  if (!el) return
  el.scrollTop = 999999; lastTop.value = el.scrollTop
  // 展开动画期间容器高度持续变化，用 ResizeObserver 跟底，420ms 动画结束后断开
  const ro = new ResizeObserver(() => { el.scrollTop = 999999; lastTop.value = el.scrollTop })
  ro.observe(el)
  setTimeout(() => { ro.disconnect() }, 450)
}

// 收起：重置 contentH / 冻结基线 / 切回小窗 / 滚到底 / 动画结束后重测基线
async function exitExpanded() {
  resetContentH()   // 先重置，小窗 DOM 以 SMALL_H 直接创建，不产生二次缩小
  // 缩小动画期间冻结增长（grown 恒 0、窗口稳在 SMALL_H）：大窗换行少、
  // scrollHeight 偏小，拿它当基线会让小窗重新换行后的高度全被算成新增 → 顶满
  setBaseScrollH(Infinity)
  expanded.value = false
  markResizing()
  await nextTick()
  const el = messagesEl.value
  if (!el) return
  stick.value = true
  el.scrollTop = 999999; lastTop.value = el.scrollTop
  // CSS transition 让窗口从大尺寸平滑缩小（0.38s），期间 clientHeight 持续变化
  // ResizeObserver 跟着一直滚底，过渡结束后断开；动画结束、小窗布局稳定后再测真实基线
  const ro = new ResizeObserver(() => { el.scrollTop = 999999; lastTop.value = el.scrollTop })
  ro.observe(el)
  setTimeout(() => {
    ro.disconnect()
    captureBaseScrollH()
    syncSmallH()
  }, 450)
}

onMounted(() => {
  window.addEventListener('gugu-quota-changed', onQuotaChanged)
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
  window.removeEventListener('gugu-quota-changed', onQuotaChanged)
  window.removeEventListener('beforeunload', saveProgress)
})

// ── 对话状态：见 useChatConversation.ts（消息/会话/流式/状态气泡机制全部收在那）──
const fabJumping     = ref(false)
function _chatTip(text: string) { messages.value.push({ id: mkid(), role: 'ai', text, time: now() }) }

// 附件（选择/拖拽/粘贴/暂存上传）与语音录制的唯一状态所有权在 useChatAttachments；
// 这里单次实例化，因为 send() 仍需要直接读 pendingAtt 来拼发送 payload。
const {
  pendingAtt, attUploading, uploadAttachFiles, onFilePicked,
  chatDrag, isChatDragging, onChatDragEnter, onChatDragOver, onChatDragLeave, onChatDrop, onPaste,
  removeAtt,
  recording, recordSecs, startRecord, stopRecord, cancelRecord,
} = useChatAttachments({
  onError: (text) => _chatTip(text),
  onVoiceSent: () => { send() },   // 录完即发（含可能已输入的文字）
})

// 对话引擎（消息/会话/SSE 流式收发/状态气泡/滚动跟随）唯一状态所有权，见该文件头注释。
// 三个钩子回调由 useChatWindow 内部定义并通过本组件解构传进来，把「内容变化 → 窗口尺寸跟随」
// 这条链收在 useChatWindow 内闭环，本组件不写中间层。
const conversation = useChatConversation({
  composerRef, messageListRef, pendingAtt,
  refreshAfterTools, loadQuota: () => loadQuota(),
  playIncomingMessageSfx: () => playIncomingMessageSfx(),
  onContentReset, onCaptureBaseScrollH, onSyncSmallH,
})
const {
  messages, mkid, now, sessionSettling,
  inputText, inputReferences, thinkingLabels, streaming, statusKind, statusTyped, isTypingText,
  sessionId, ownerPlatformUserId, isGroupSession,
  sessions, webSessions, imSessions, currentSessionTitle, currentSessionWorkspaceName, currentSessionGoalActive, currentSessionGoalStatus,
  stick, lastTop,
  fetchSessions, loadSession, newSession, deleteSession, renameSession,
  send, stopStreaming,
  scrollBottom, onMsgScroll,
  animateGreeting, clearStatus,
} = conversation

async function onInteractionSelect(_msg: ChatMessage, option: { id: string; label: string; token: string }) {
  const promptId = _msg.interaction?.promptId
  if (!promptId || !sessionId.value) return
  if (_msg.interaction) {
    _msg.interaction.resolved = true
    _msg.interaction.selectedOptionId = option.id
  }
  try {
    const token = getToken()
    const endpoint = _msg.interaction?.toolCallId
      ? `${API_BASE}/agent/interactions/${promptId}/resume`
      : `${API_BASE}/agent/interactions/${promptId}/respond`
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ token: option.token }),
    })
    if (!res.ok) {
      if (_msg.interaction) {
        _msg.interaction.resolved = false
        _msg.interaction.selectedOptionId = null
      }
      return
    }
  } catch {
    if (_msg.interaction) {
      _msg.interaction.resolved = false
      _msg.interaction.selectedOptionId = null
    }
  }
}

async function onReferenceClick(reference: ChatReference) {
  await openMindRef(reference.type, reference.id)
}

async function openChatObject(type: string, id: number) {
  if (type === 'project' || type === 'event') {
    await openMindRef(type, id)
    return
  }
  const paths: Record<string, string> = {
    canvas: '/mind/canvases', note: '/mind/notes', 'scheduled-task': '/schedules',
  }
  const path = paths[type]
  if (path) {
    // 已在目标页且 query 完全相同时，router.push 是 no-op，页面收不到任何变化；
    // 派发自定义事件让已挂载的页面直接响应（页面侧三种入口都接了同一处理函数）。
    if (router.currentRoute.value.path === path
      && router.currentRoute.value.query.object_id === String(id)) {
      window.dispatchEvent(new CustomEvent('gugu:open-object', { detail: { type, id } }))
      return
    }
    await router.push({ path, query: { object_id: String(id) } })
  }
}

watch(isTypingText, v => {
  if (v) { fabJumping.value = true; setTimeout(() => { fabJumping.value = false }, 350) }
})

const copiedId = ref<number | null>(null)

async function downloadFile(f: ChatFile) {
  if (f.attach_id) {
    // 聊天上传的暂存附件：走 /agent/attachment/{id}/download
    const token = getToken()
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

// 任何打开路径（FAB / 通知点开 / 展开）都触发一次
watch(open, (v) => {
  if (v) { animateGreeting(); loadBots(); loadQuota(); pickOfflineLabel() }
})

// ── 展开/收起 ────────────────────────────────────────────
// ── 侧栏 IM 接入（飞书 / QQ / 微信）：Bot 列表、侧栏扫码连接、聊天内扫码绑定的唯一
// 状态所有权在 useChatImConnect；这里只持有它要操作的两个子组件 DOM 引用。
const sidebarRef    = ref<InstanceType<typeof GuguChatSidebar> | null>(null)
const bindDialogRef = ref<InstanceType<typeof GuguChatBindDialog> | null>(null)
const {
  bots, imOpen, imPlatformOptions, imOnline, botsOf, imHighlight,
  loadBots, toggleImPlatform, promptConnectIM,
  connecting, connect, connectHint, connectErr, setConnectCanvas,
  startImConnect, cancelImConnect,
  chatBind, openChatImBind, closeChatBind,
} = useChatImConnect({
  sidebarRef, bindDialogRef,
  expanded, enterExpanded: () => enterExpanded(),
  fetchSessions: () => fetchSessions(),
})
const imSessionsOf = (platform: ImPlatformKey) => imSessions.value.filter(s => s.source === platform)

// ── 顶部状态：休息中（精力耗尽）> 在线（任意 IM 启用）> 随机离线 ──
const quota = ref<QuotaInfo | null>(null)
async function loadQuota() { try { quota.value = await authApi.getQuota() } catch {} }
function onQuotaChanged() { loadQuota() }
const energyExhausted = computed(() => {
  const q = quota.value
  if (!q) return false
  return (q.limit_6h != null && (q.used_6h ?? 0) >= q.limit_6h) ||
         (q.limit_weekly != null && (q.used_weekly ?? 0) >= q.limit_weekly)
})
// 离线时随机显示「QQ/微信/飞书 离线」之一（每次打开换一个，暗示这些渠道还没接上）
const _OFFLINE_LABEL_KEYS = ['qqOffline', 'wechatOffline', 'feishuOffline'] as const
const offlineLabel = ref('离线')
function pickOfflineLabel() { offlineLabel.value = t(`chatUi.${_OFFLINE_LABEL_KEYS[Math.floor(Math.random() * _OFFLINE_LABEL_KEYS.length)]}`) }
const presenceKind  = computed(() => energyExhausted.value ? 'resting' : (imOnline.value ? 'online' : 'offline'))
const presenceText  = computed(() => presenceKind.value === 'resting' ? t('chatUi.resting')
                                   : presenceKind.value === 'online'  ? t('chatUi.online') : offlineLabel.value)
const presenceTitle = computed(() => presenceKind.value === 'resting' ? t('chatUi.restingHint')
                                   : presenceKind.value === 'online'  ? t('chatUi.onlineHint')
                                   : t('chatUi.offlineHint'))

</script>

<style scoped>
/* .ai-fab* 已随 GuguChatFab.vue 迁移 */

/* 窗口开/关动画（从右下角 fab 原点缩放），!important 覆盖 .chat-window 的位移 transition。
   Transition 在本组件，class 加在 GuguChatWindow 根元素上（根元素带本组件 scope 属性，
   这里能匹配）。窗口外壳/标题栏/遮罩样式已随 GuguChatWindow.vue 迁移。 */
.chat-open-enter-active {
  transition: opacity 0.22s ease, transform 0.36s cubic-bezier(0.16, 1, 0.3, 1) !important;
  transform-origin: right bottom;
}
.chat-open-leave-active {
  transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(0.7, 0, 0.84, 0) !important;
  transform-origin: right bottom;
  /* Chrome 在变换中的子元素上会提前停止 backdrop-filter 合成；离场根节点保留
     一层同值材质，确保玻璃效果跟随 opacity 一起淡出，而不是先变成普通半透明。 */
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
}
.chat-open-enter-from, .chat-open-leave-to { opacity: 0; transform: scale(0.78); }

/* 消息列表容器与内部结构渲染于 GuguChatMessageList.vue（GuguChatWindow 的子组件），
   需要 :deep() 穿透组件边界匹配。 */
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
:deep(.msg-virtual-row) { position: absolute; top: 0; left: 0; width: 100%; box-sizing: border-box; padding: 0 13px var(--space-xs); }
.chat-main.is-expanded :deep(.msg-virtual-row) { padding: 0 24px var(--space-sm); }
:deep(.msg-virtual-row.is-tool-row), .chat-main.is-expanded :deep(.msg-virtual-row.is-tool-row),
:deep(.msg-virtual-row.is-interaction-row), .chat-main.is-expanded :deep(.msg-virtual-row.is-interaction-row) { padding-bottom: var(--space-xs); }
:deep(.msg.tool .tool-event-bubble) { margin: 0; }
/* 状态指示气泡不在虚拟列表里，是紧跟在占位容器后面的普通流内元素，补回同款左右留白 + gap */
:deep(.chat-messages > .msg) { margin: 8px 13px 12px; }
.chat-main.is-expanded :deep(.chat-messages > .msg) { margin: 12px 24px 20px; }

/* 咕咕回复里的动作按钮：md 里的 gugu:// 链接渲染成按钮（onChatActionClick 拦截点击）——
   跟全局 .press-fx 一套手感（悬停不上浮，只在按下时下沉），这些 <a> 是 markdown 渲染出来的、
   没法在模板里挂 class，数值直接写这里（hover/active 与全局 .press-fx 保持一致） */
/* .msg-bubble.md-body 本体现在渲染于 GuguChatMessageRow.vue（子组件，无 data-v-GuguChat
   属性），这里必须整条选择器都用 :deep() 才能穿透组件边界匹配到，光把内层 a 包 :deep()
   不够——外层 class 名同样带着父组件的 scope 校验。 */
:deep(.msg-bubble.md-body a[href^="gugu://"]:not(.chat-object-card)) {
  display: inline-flex; align-items: center; gap: 5px;
  margin: 3px 4px 3px 0; padding: 5px 12px;
  font-size: 12.5px; font-weight: 600; text-decoration: none;
  color: var(--content-on-accent); background: var(--gugu-chat-send-bg);
  border: 1px solid color-mix(in srgb, var(--action-primary) 22%, transparent);
  border-radius: var(--radius-pill); box-shadow: none;
  cursor: pointer;
  transition:
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard),
    box-shadow var(--motion-hover-control) var(--motion-ease-standard),
    transform var(--motion-hover-control) var(--motion-ease-standard),
    opacity var(--motion-hover-control) var(--motion-ease-standard);
  user-select: none;
}
:deep(.msg-bubble.md-body a.chat-object-card) {
  display: inline-flex; align-items: center; vertical-align: middle; gap: 9px;
  min-width: 210px; max-width: min(340px, 100%); margin: 5px 6px 5px 0; padding: 9px 11px;
  color: var(--content-primary); background: var(--surface-card-solid);
  border: 1px solid var(--border-default); border-radius: var(--card-radius);
  box-shadow: var(--card-shadow); text-decoration: none; cursor: pointer;
  transition: var(--card-motion);
}
:deep(.msg-bubble.md-body a.chat-object-card:hover) {
  color: var(--content-primary); opacity: 1;
  background-color: var(--card-surface-bg-hover); border-color: var(--card-surface-border-hover);
  box-shadow: var(--card-shadow-hover); transform: translateY(-1px);
}
:deep(.msg-bubble.md-body a.chat-object-card:active) { transform: translateY(1px); opacity: 0.93; }
:deep(.chat-object-card-icon) { display: grid; place-items: center; flex: 0 0 27px; width: 27px; height: 27px; border-radius: var(--radius-sm); background: var(--surface-soft-hover); color: var(--action-primary); }
:deep(.chat-object-card-icon-svg) { display: block; width: 16px; height: 16px; fill: currentColor; }
:deep(.chat-object-card-body) { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
:deep(.chat-object-card-body strong) { overflow: hidden; font-size: 12.5px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
:deep(.chat-object-card-body small) { color: var(--content-tertiary); font-size: 10.5px; }
:deep(.chat-object-card-arrow) { display: grid; place-items: center; flex: 0 0 16px; color: var(--content-tertiary); }
:deep(.chat-object-card-arrow-svg) { display: block; width: 14px; height: 14px; fill: currentColor; }
:deep(.msg-bubble.md-body a[href^="gugu://"]:not(.chat-object-card):hover) {
  background: var(--gugu-chat-send-bg); border-color: var(--action-primary-hover);
  box-shadow: none; opacity: 1;
}
:deep(.msg-bubble.md-body a[href^="gugu://"]:not(.chat-object-card):active) { transform: translateY(1px); opacity: 0.93; }

/* .cb-* 扫码绑定弹窗样式已随 GuguChatBindDialog.vue 迁移 */
/* .im-qr-cancel 已随 GuguChatImConnect.vue 迁移 */

/* .exp-send-btn/.send-btn 已随 GuguChatComposer.vue 迁移 */

/* ── 消息气泡 ──
   .msg 本体在 GuguChatMessageList.vue 渲染，.msg-bubble/.msg-files/.msg-footer 等
   在 GuguChatMessageRow.vue 渲染——都是子组件，没有本文件的 data-v-GuguChat 属性，
   整条选择器必须用 :deep() 才能跨组件边界匹配，否则样式全部失效（只剩默认 HTML 样式）。 */
:deep(.msg) { display: flex; flex-direction: column; min-width: 0; }
:deep(.msg.user) { align-items: flex-end; }
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
  background: var(--gugu-chat-assistant-bg); border: 1px solid var(--gugu-chat-assistant-border);
  border-bottom-left-radius: 4px; box-shadow: inset 0 1px 0 var(--gugu-chat-file-highlight);
}
:deep(.msg.member .msg-bubble) {
  background: var(--gugu-chat-member-bg); border: 1px solid var(--gugu-chat-member-border);
  border-bottom-left-radius: 4px;
}
:deep(.msg.user .msg-bubble) {
  background: var(--gugu-chat-user-bg); color: var(--gugu-chat-user-fg);
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
  background: var(--gugu-chat-member-bg); border-left: 2.5px solid var(--gugu-chat-member-border);
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
  /* 和 AI 气泡同款：主题化半透明表面 + 左下角小尾巴 + 内高光。 */
  background: var(--gugu-chat-file-bg); border: 1px solid var(--gugu-chat-file-border);
  border-radius: 14px; border-bottom-left-radius: 5px;
  box-shadow: inset 0 1px 0 var(--gugu-chat-file-highlight), var(--gugu-chat-file-shadow);
  /* transform/opacity 是按下反馈(.press-fx)要用的——跟这里自己的 transition 写一起，
     避免两条规则的 transition 互相整体覆盖、丢掉其中一份 */
  transition: background 0.2s ease, box-shadow 0.25s ease,
    transform 0.15s ease, opacity 0.15s ease;
}
:deep(.msg-file.press-fx:hover) {
  background: var(--gugu-chat-file-bg-hover);
  border-color: var(--gugu-chat-file-border-hover);
  /* 文件气泡自己的 hover 阴影，避免全局 press-fx 规则覆盖主题。 */
  box-shadow: inset 0 1px 0 var(--gugu-chat-file-highlight-hover), var(--gugu-chat-file-shadow-hover);
}
:deep(.msg-file-ext) {
  position: relative; overflow: hidden;
  flex-shrink: 0; width: 34px; height: 34px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: var(--gugu-chat-user-fg); letter-spacing: 0.02em;
  background: var(--gugu-chat-file-ext-bg);
}
/* 图片附件：缩略图覆盖 ext 角标；加载失败时 @error 移除自身，露出底下角标 */
:deep(.msg-file-thumb) {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; display: block;
}
:deep(.msg-file-info) { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
:deep(.msg-file-name) { font-size: 15px; font-weight: 500; color: var(--gugu-chat-file-name); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:deep(.msg-file-meta) { font-size: 12px; color: var(--gugu-chat-file-meta); }
:deep(.msg-file-dl) {
  flex-shrink: 0; color: var(--action-primary); cursor: pointer; border-radius: 4px; padding: 3px;
  margin: -3px; box-sizing: content-box; transition: background 0.12s, color 0.12s;
}
:deep(.msg-file-dl:hover) { background: var(--gugu-chat-file-download-hover); color: var(--action-primary); }
/* 语音条：迷你播放条（播放钮 + 波形 + 时长），和文件卡同款气泡质感 */
:deep(.msg-voice) {
  display: inline-flex; align-items: center; gap: 9px; padding: 8px 13px; cursor: pointer;
  max-width: 100%; box-sizing: border-box; user-select: none;
  background: var(--gugu-chat-voice-bg); border: 1px solid var(--gugu-chat-voice-border);
  border-radius: 14px; border-bottom-left-radius: 5px;
  box-shadow: inset 0 1px 0 var(--gugu-chat-voice-highlight), var(--elevation-card);
  transition: background 0.15s, box-shadow 0.15s;
}
:deep(.msg-voice:hover) { background: var(--surface-glass-hover); box-shadow: inset 0 1px 0 var(--highlight-strong), var(--elevation-card-hover); }
:deep(.msg-voice .mv-btn) {
  flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; color: var(--gugu-chat-user-fg);
  background: var(--gugu-chat-voice-button-bg); box-shadow: var(--elevation-card);
}
:deep(.msg-voice .mv-wave) { display: flex; align-items: center; gap: 2px; height: 18px; }
:deep(.msg-voice .mv-wave i) { width: 2.5px; border-radius: 2px; background: var(--gugu-chat-voice-wave); transition: background 0.2s; }
:deep(.msg-voice.playing .mv-wave i) { background: var(--gugu-chat-voice-wave-playing); animation: mv-pulse 0.9s ease-in-out infinite; }
:deep(.msg-voice .mv-wave i:nth-child(even)) { animation-delay: 0.15s; }
:deep(.msg-voice .mv-wave i:nth-child(3n)) { animation-delay: 0.3s; }
@keyframes mv-pulse { 0%,100% { transform: scaleY(0.6); } 50% { transform: scaleY(1); } }
:deep(.msg-voice .mv-dur) { font-size: 12.5px; color: var(--gugu-chat-voice-duration); font-variant-numeric: tabular-nums; flex-shrink: 0; }
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
:deep(.msg-copy-btn:hover) { background: var(--gugu-chat-copy-hover-bg); color: var(--action-primary); }
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
  border: 2px solid var(--gugu-chat-tool-border); border-top-color: var(--action-primary);
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
