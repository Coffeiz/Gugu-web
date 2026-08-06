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
      :streaming="streaming" :is-chat-dragging="isChatDragging"
      :current-session-title="currentSessionTitle"
      :presence-kind="presenceKind" :presence-text="presenceText" :presence-title="presenceTitle"
      :messages="messages" :is-group-session="isGroupSession"
      :copied-id="copiedId" :voice-playing-id="voicePlayingId"
      :status-kind="statusKind" :status-typed="statusTyped"
      v-model:input-text="inputText"
      :pending-att="pendingAtt" :att-uploading="attUploading"
      :recording="recording" :record-secs="recordSecs" :vw="vw"
      :on-remove-att="removeAtt"
      :on-start-record="startRecord" :on-cancel-record="cancelRecord" :on-stop-record="stopRecord"
      :on-file-picked="onFilePicked" :on-paste="onPaste"
      :on-send="() => send()" :on-stop-streaming="stopStreaming"
      :on-copy="copyMsg" :on-toggle-voice="toggleVoice"
      :on-open-file="openFileFromChat" :on-action-click="onChatActionClick"
      :on-prompt-connect="promptConnectIM"
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
        />
      </template>
    </GuguChatWindow>
  </Transition>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted, type ComponentPublicInstance } from 'vue'
import { useRouter } from 'vue-router'
import { useAudioStore } from '@/stores/audio'
import { useLiveStore } from '@/stores/live'
import { useUiStore } from '@/stores/ui'
import { usePreviewStore } from '@/stores/preview'
import { agentApi, filesApi, trackApi, authApi, CLIENT_ID } from '@/services/api'
import { prefetchGreeting } from '@/composables/useGreeting'
import GuguChatFab from './gugu-chat/GuguChatFab.vue'
import GuguChatMiniPlayer from './gugu-chat/GuguChatMiniPlayer.vue'
import GuguChatSidebar from './gugu-chat/GuguChatSidebar.vue'
import GuguChatBindDialog from './gugu-chat/GuguChatBindDialog.vue'
import GuguChatWindow from './gugu-chat/GuguChatWindow.vue'
import type { ChatMessage, ChatFile, ChatSession, ImPlatformKey } from './gugu-chat/chatTypes'
import { API_BASE } from './gugu-chat/chatConstants'
import { renderMd, renderMdStream } from './gugu-chat/markdown'
import {
  isImageFile, isAnimatedImageFile, canPreview,
  fmtSize, fmtDur, voiceBar,
} from './gugu-chat/messageDisplay'
import { useChatAudio } from './gugu-chat/composables/useChatAudio'
import { useChatAttachments } from './gugu-chat/composables/useChatAttachments'
import { useChatActions } from './gugu-chat/composables/useChatActions'
import { useChatConversation } from './gugu-chat/composables/useChatConversation'
import { useChatImConnect } from './gugu-chat/composables/useChatImConnect'
import { useChatWindow } from './gugu-chat/composables/useChatWindow'

interface QuotaInfo {
  limit_6h?: number | null
  used_6h?: number
  limit_weekly?: number | null
  used_weekly?: number
}

const audioStore    = useAudioStore()
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
})
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
  open, expanded, resizing, chatClosing, fabZ,
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
  // 真实输入框此时仍在从小窗宽度过渡到大窗宽度；用目标宽度离屏测量，避免把旧宽度的行数
  // 带到动画结束才纠正，也不需要为了兜底提前撑高窗口。
  await nextTick()
  composerRef.value?.fitTextarea?.(true)
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
  composerRef.value?.fitTextarea?.(false)
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
  messages, mkid, now,
  inputText, thinkingLabels, streaming, statusKind, statusTyped, isTypingText,
  sessionId, ownerPlatformUserId, isGroupSession,
  sessions, webSessions, imSessions, currentSessionTitle,
  stick, lastTop,
  fetchSessions, loadSession, newSession, deleteSession,
  send, stopStreaming, resumeStream,
  scrollBottom, onMsgScroll,
  animateGreeting, clearStatus,
} = conversation

watch(isTypingText, v => {
  if (v) { fabJumping.value = true; setTimeout(() => { fabJumping.value = false }, 350) }
})

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

// 任何打开路径（FAB / 通知点开 / 展开）都触发一次
watch(open, (v) => { if (v) { animateGreeting(); loadBots(); loadQuota(); pickOfflineLabel() } })

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

/* .cb-* 扫码绑定弹窗样式已随 GuguChatBindDialog.vue 迁移 */
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
