<template>
  <!-- 迷你播放器 -->
  <GuguChatMiniPlayer
    :visible="!!audioStore.file && (miniPinned || open)"
    :style="miniPlayerStyle" :bars-playing="audioPlaying" :wave-bars="audioBars"
    :file-name="audioStore.file ? `${audioStore.file.displayName}.${audioStore.file.ext?.toLowerCase()}` : ''"
    :playlist="audioStore.playlist" :current-track-id="audioStore.file?.id ?? null"
    :pinned="miniPinned" @update:pinned="miniPinned = $event"
    :current="audioCurrent" :duration="audioDuration" :seek-pct="audioSeekPct"
    :playing="audioPlaying" :muted="audioMuted" :volume="audioVolume"
    :playback-mode="audioStore.playbackMode" :on-cycle-playback-mode="audioStore.cyclePlaybackMode"
    :fmt-time="fmtTime" :on-stop="audioStop" :on-start-drag="audioStartDrag"
    :on-toggle="audioToggle" :on-toggle-mute="audioToggleMute" :on-set-volume="audioSetVolume"
    :on-previous="audioStore.previousTrack" :on-next="audioStore.nextTrack"
    :on-select-track="selectAudioTrack" @load-playlist-durations="audioStore.loadPlaylistDurations"
  />

  <audio
    ref="audioEl"
    :src="audioStore.blobUrl ?? undefined"
    @timeupdate="audioCurrent = audioEl?.currentTime ?? 0"
    @durationchange="onAudioDurationChange"
    @play="onAudioPlay"
    @pause="onAudioPause"
    @ended="onAudioEnded"
    @canplay="onCanPlay"
  />

  <FilesystemAuthorizationDialog
    :show="sessionAuthorization.open.value"
    :busy="sessionAuthorization.busy.value"
    subject-type="session"
    :subject-name="currentSessionTitle"
    @close="sessionAuthorization.close"
    @confirm="confirmSessionAuthorization"
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
  <Transition name="chat-open" @after-enter="animateGreeting(() => open)" @after-leave="finishChatClose" @leave-cancelled="chatClosing = false">
    <GuguChatWindow
      v-if="open || chatClosing"
      v-show="open"
      :inert="!open"
      ref="windowRef"
      :window-style="windowStyle" :expanded="expanded" :resizing="resizing"
      :owner-z="chatZ"
      :streaming="streaming" :can-interrupt-detached-run="canInterruptDetachedRun"
      :interrupt-pending="interruptPending" :on-interrupt-detached-run="interruptDetachedRun" :is-chat-dragging="isChatDragging" :drop-files-as-references="!!referenceDroppedFile"
      :automatic-mode-enabled="automaticModeEnabled"
      :automatic-mode-available="automaticModeButtonVisible"
      :automatic-mode-saving="automaticModeSaving"
      :on-toggle-automatic-mode="toggleAutomaticMode"
      :current-session-title="currentSessionTitle"
      :current-session-workspace-name="currentSessionWorkspaceName"
      :current-session-goal-active="currentSessionGoalActive"
      :current-session-goal-status="currentSessionGoalStatus"
      :filesystem-authorized="sessionFilesystemAuthorized"
      :filesystem-authorization-enabled="currentSessionFilesystemAuthorizationEnabled"
      :session-id="sessionId"
      :interaction-answer-mode="interactionAnswerMode"
      :presence-kind="presenceKind" :presence-text="presenceText" :presence-title="presenceTitle"
      :messages="messages" :is-group-session="isGroupSession"
      :copied-id="copiedId" :voice-playing-id="voicePlayingId" :voice-bars="voiceBars"
      :status-kind="statusKind" :status-typed="statusTyped"
      :session-settling="sessionSettling"
      :history-state="historyState" :on-load-history="loadOlderHistory"
      :pending-queue="visiblePendingQueue" @remove-queued="removeQueued"
      v-model:input-text="inputText"
      :references="inputReferences" @update:references="inputReferences = $event"
      :pending-att="pendingAtt" :att-uploading="attUploading"
      :recording="recording" :record-secs="recordSecs" :vw="vw"
      :voice-input-available="voiceInputAvailable"
      :on-remove-att="removeAtt"
      :on-start-record="startRecord" :on-cancel-record="cancelRecord" :on-stop-record="stopRecord"
      :on-file-picked="onFilePicked" :on-paste="onPaste"
      :on-send="onChatSend" :on-stop-streaming="stopStreaming"
      :on-copy="copyMsg" :on-toggle-voice="toggleVoice"
      :on-open-file="openFileFromChat" :on-download="downloadFile" :on-action-click="onChatActionClick"
      :on-interaction-select="onInteractionSelect"
      :on-interaction-text-submit="onInteractionTextSubmit"
      :on-secret-submit="onSecretSubmit"
      :on-secret-cancel="onSecretCancel"
      :on-reference-click="onReferenceClick"
      :on-prompt-connect="promptConnectIM"
      :on-filesystem-authorization="toggleSessionAuthorization"
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
          :sessions-loading="sessionsLoading" :sessions-load-failed="sessionsLoadFailed" :on-retry-sessions="fetchSessions"
          :session-badges="webSessionBadges"
          :connect="connect" :connect-hint="connectHint" :connect-err="connectErr" :connecting="connecting"
          :telegram-token-dialog-open="telegramTokenDialogOpen"
          :telegram-connecting="telegramConnecting"
          :telegram-connect-error="telegramConnectError"
          :on-open-telegram-token-dialog="openTelegramTokenDialog"
          :on-close-telegram-token-dialog="closeTelegramTokenDialog"
          :on-submit-telegram-token="submitTelegramToken"
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
import type { ChatHttpStreamAccess } from './chatHttpStream'
import { respondToHttpInteraction, type ChatInteractionAccess } from './chatInteractionAccess'
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAudioStore } from '@/stores/audio'
import type { AudioTrack } from '@/stores/audio'
import { useUiStore } from '@/stores/ui'
import { usePreferencesStore } from '@/stores/preferences'
import { usePreviewStore } from '@/stores/preview'
import { agentApi, filesApi, workspacesApi } from '@/services/api'
import { isUnauthorizedResponse } from '@/services/authSession'
import GuguChatFab from './GuguChatFab.vue'
import GuguChatMiniPlayer from './GuguChatMiniPlayer.vue'
import GuguChatSidebar from './GuguChatSidebar.vue'
import GuguChatBindDialog from './GuguChatBindDialog.vue'
import GuguChatWindow from './GuguChatWindow.vue'
import FilesystemAuthorizationDialog from '@/components/common/filesystem/FilesystemAuthorizationDialog.vue'
import type { ResolveChatCommand } from './chatCommands'
import { CHAT_REF_ACCEPTS, CHAT_REF_FAB_SURFACE_ID, CUSTOM_REPLY_OPTION_ID, findPendingTextInteractionId, type ChatMessage, type ChatFile, type ChatReference, type QueuedMessagePayload, type ImPlatformKey } from './chatTypes'
import { runtime } from '@/interaction/runtime'
import { useRuntimeAction } from '@/interaction/runtime/vue'
import { API_BASE } from './chatConstants'
import { canPreview, fmtSize } from './messageDisplay'
import { useChatAudio } from './composables/useChatAudio'
import { useChatAttachments } from './composables/useChatAttachments'
import { useChatActions } from './composables/useChatActions'
import { copyTextToClipboard } from './composables/copyTextToClipboard'
import type { ReadHistoryThroughMessage } from './composables/sessionMessageSync'
import { useChatConversation, type ChatConversationAccess, type ChatGreetingAccess } from './composables/useChatConversation'
import { useWebSessionBadges } from './composables/useWebSessionBadges'
import { useAuthStore } from '@/stores/auth'
import { runChatNavigation } from './composables/chatNavigation'
import { restoreStartupSession } from './composables/startupSessionRestore'
import { useChatImConnect, type ChatImAccess } from './composables/useChatImConnect'
import { useChatWindow } from './composables/useChatWindow'
import { useMindRefActions } from '@/composables/mind/useMindRefActions'
import { useFilesystemAuthorization, type FilesystemAuthorizationApi } from '@/composables/useFilesystemAuthorization'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import { getDraftPendingQueueId, isPendingQueueRecoveryNeeded, setPendingQueueRecoveryNeeded } from './composables/chatPendingQueueStorage'
const { t } = useI18n()

interface QuotaInfo {
  limit_6h?: number | null
  used_6h?: number
  limit_weekly?: number | null
  used_weekly?: number
}

const audioStore    = useAudioStore()
const uiStore       = useUiStore()
const preferencesStore = usePreferencesStore()
const router        = useRouter()
const automaticModeGlobalEnabled = ref(false)
const automaticModeStatusLoaded = ref(false)
const automaticModeSaving = ref(false)
const localAutomaticMode = ref(false)
const automaticModeEnabled = computed(() => props.automaticModeAccess ? localAutomaticMode.value : preferencesStore.automaticModeEnabled)
const automaticModeButtonVisible = computed(() =>
  (props.automaticModeAccess || preferencesStore.loaded) && automaticModeStatusLoaded.value && automaticModeGlobalEnabled.value,
)

async function refreshAutomaticMode() {
  if (props.automaticModeAccess) {
    const value = await props.automaticModeAccess.read()
    if (!automaticModeSaving.value) localAutomaticMode.value = value
    automaticModeGlobalEnabled.value = true
    return
  }
  const refreshed = await preferencesStore.refreshAutomaticModeEnabled()
  if (refreshed) preferencesStore.notifyAutomaticModeChanged()
}

async function toggleAutomaticMode() {
  if (!automaticModeButtonVisible.value || automaticModeSaving.value || chatCommandRunning) return
  automaticModeSaving.value = true
  try {
    if (props.automaticModeAccess)
      localAutomaticMode.value = await props.automaticModeAccess.write(!localAutomaticMode.value)
    else await preferencesStore.saveAutomaticModeEnabled(!preferencesStore.automaticModeEnabled)
  } catch {
    showAppError(t('chatUi.networkError'))
  } finally {
    automaticModeSaving.value = false
  }
}

// 顶栏全局搜索点「对话」结果 / 笔记里点「@对话」引用卡片：打开聊天面板并切到该会话。
// 不强制展开大窗——默认保持小窗，用户已经开着大窗才维持大窗；对话引用现在锚定的是
// 具体一条消息（见 useMindRefActions.ts），靠 _flashChatMessage 在消息列表里定位闪烁，
// 小窗一样看得见，不需要靠「大窗侧边栏 .active 高亮」这条路。
watch(() => uiStore.pendingChatNavigation, (request) => {
  if (!request) return
  void runChatNavigation(request, {
    isCurrent: uiStore.isCurrentChatNavigation,
    open: () => { open.value = true },
    // 窗口使用 v-if；首次打开时先等消息列表挂载，再等待可能进行中的启动恢复结算。
    mount: () => nextTick(),
    loadSession: (id) => conversation.loadSession(id),
    waitForSessionSettlement: (id) => conversation.waitForSessionSettlement(id),
    waitForStableScrollLayout: () => conversation.waitForStableScrollLayout(),
    currentSessionId: () => sessionId.value,
    clear: uiStore.clearChatNavigation,
    reveal: (id) => conversation._revealMessage(id),
    flash: (id) => conversation._flashChatMessage(id),
    showUnavailable: () => showAppError(t('chatUi.messageUnavailable')),
  })
})

// gugu:// 协议链接（复制代码/绑定 IM/打开文件）+ 工具完成后的前端刷新通知，收在 useChatActions。
const { refreshAfterTools, onChatActionClick } = useChatActions({
  router,
  onBindPlatform: (platform) => openChatImBind(platform),
  onOpenObject: (type, id) => { void openChatObject(type, id) },
  onOpenSkill: (skillId) => { void router.push({ path: '/skills', query: { skill: skillId } }) },
})
const { openMindRef } = useMindRefActions()
const fabRef        = ref<InstanceType<typeof GuguChatFab> | null>(null)
const rippleActive  = ref(false)
const spinningBack = ref(false)
let rippleTimeout: ReturnType<typeof setTimeout> | null = null

// 悬浮球在聊天窗口关闭时仍接收可引用卡片。它使用独立 Surface，落点后由父组件
// 打开并展开聊天，再复用 Composer 的引用解析逻辑插入 @ 卡片。
const fabRefSurfaceGeneration = runtime.surfaces.register({
  id: CHAT_REF_FAB_SURFACE_ID,
  type: 'chat-composer',
  layout: 'grid',
  accepts: [...CHAT_REF_ACCEPTS],
  element: null,
})
const fabRefTargetGeneration = runtime.targets.register({
  id: `${CHAT_REF_FAB_SURFACE_ID}:target`,
  surfaceId: CHAT_REF_FAB_SURFACE_ID,
  accepts: [...CHAT_REF_ACCEPTS],
  priority: 10,
  element: null,
})
watch(fabRef, fab => runtime.targets.setElement(`${CHAT_REF_FAB_SURFACE_ID}:target`, fab?.dropTargetEl ?? null), { flush: 'post' })
onUnmounted(() => {
  runtime.targets.unregister(`${CHAT_REF_FAB_SURFACE_ID}:target`, fabRefTargetGeneration)
  runtime.surfaces.unregister(CHAT_REF_FAB_SURFACE_ID, fabRefSurfaceGeneration)
})

// 悬浮球转场动画在 audioStore.file 清空前触发（拿最后角度做转回归位动画）；
// 播放器机制（暂停/进度/音量/语音条播放）全部收在 useChatAudio。
const props = defineProps<{
  greetingAccess?: ChatGreetingAccess
  readInteractionSession?: (promptId: number) => Promise<{ session_id: number }>
  readQuota?: () => Promise<QuotaInfo>
  trackMessageSent?: (turn: number) => void
  trackChatEvent?: (event: 'chat_open' | 'chat_expanded') => void
  sessionAccess?: ChatConversationAccess
  localSessionBadges?: boolean
  httpStream?: ChatHttpStreamAccess
  resolveChatCommand?: ResolveChatCommand
  automaticModeAccess?: { read(): Promise<boolean>; write(value: boolean): Promise<boolean> }
  readHistoryThroughMessage?: ReadHistoryThroughMessage
  readUiLabels?: () => Promise<{ thinking?: string | string[]; contextCompacting?: string | string[] }>
  imAccess?: ChatImAccess
  respondToInteraction?: ChatInteractionAccess
  readVoiceAvailability?: () => Promise<{ available: boolean }>
  cancelSession?: (id: number) => Promise<{ outcome: string }>
  readPendingQueue?: (queueId: string) => Promise<{ items: QueuedMessagePayload[] }>
  readImportedQueues?: () => Promise<{ queues: Array<{ items: QueuedMessagePayload[] }> }>
  isAttachmentExpired?: (error: unknown) => boolean
  referenceDroppedFile?: (file: File) => Promise<ChatReference>
  openPlatformReference?: (reference: Pick<ChatReference, 'type' | 'id'>) => Promise<boolean>
  uploadAttachment?: (file: File, voice?: boolean) => Promise<ChatFile>
  deleteDraftAttachment?: (id: string) => Promise<unknown>
  readAttachment?: (id: string) => Promise<Blob>
}>()

const {
  audioEl, audioPlaying, audioCurrent, audioDuration, audioSeekPct, audioBars,
  saveProgress, onCanPlay, onAudioPlay, onAudioPause, onAudioEnded, audioToggle, audioStop,
  onAudioDurationChange,
  audioVolume, audioMuted, audioSetVolume, audioToggleMute, audioStartDrag, fmtTime,
  voicePlayingId, voiceBars, toggleVoice,
} = useChatAudio({
  readAttachment: props.readAttachment,
  isAttachmentExpired: props.isAttachmentExpired,
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

function selectAudioTrack(track: AudioTrack) {
  void audioStore.play(track)
}

watch(audioPlaying, (playing) => {
  if (playing) { if (rippleTimeout) clearTimeout(rippleTimeout); rippleActive.value = true }
  else { rippleTimeout = setTimeout(() => { rippleActive.value = false }, 3600) }
})

// 窗口尺寸、层级与通知锚点由 useChatWindow 管理。
const windowRef = ref<InstanceType<typeof GuguChatWindow> | null>(null)
// 把 GuguChatWindow 暴露的 DOM/组件引用包装成 useChatConversation / useChatWindow 需要的形态。
const messageListRef = computed(() => windowRef.value?.messageListRef ?? null)
const composerRef   = computed(() => windowRef.value?.composerRef ?? null)
const messagesEl    = computed(() => windowRef.value?.messageListRef?.el ?? null)
const windowElRef   = computed(() => windowRef.value?.el ?? null)

const {
  open, expanded, resizing, chatClosing, chatZ, fabZ,
  vw,
  windowStyle, miniPlayerStyle,
  miniPinned, reopenResume,
  raiseChat, closeChat, finishChatClose, openInLastMode, markResizing, playIncomingMessageSfx,
  onSyncSmallH, enableCompactGrowth,
  SESSION_KEY, LAST_SESSION_KEY,
} = useChatWindow({
  windowRef: windowElRef,
  composerRef,
  messagesEl,
})

// 通知锚点 / 缩放原点变化已经由 useChatWindow 内 watch 写入 uiStore，这里只读

async function toggleOpen() {
  if (open.value) { closeChat(); return }
  openInLastMode()
  if (expanded.value) void fetchSessions()
  props.trackChatEvent?.('chat_open')
  await alignNewWindowToBottom()
}

useRuntimeAction(async action => {
  if (action.type !== 'move' && action.type !== 'move-group') return
  if (action.toSurfaceId !== CHAT_REF_FAB_SURFACE_ID) return
  if (!expanded.value) await enterExpanded()
  const objectIds = action.type === 'move-group' ? action.objectIds : [action.objectId]
  await composerRef.value?.handleRuntimeReferenceDrop?.(objectIds)
})

// 已打开的小窗保留滚动锚点；从悬浮球打开时直接挂载大窗。
async function enterExpanded() {
  const opening = !open.value
  if (!opening) markResizing()
  expanded.value = true
  open.value = true
  if (opening) props.trackChatEvent?.('chat_open')
  else loadBots()
  // 真实输入框此时仍在从小窗宽度过渡到大窗宽度，输入高度统一在过渡结束后校准，
  // 避免用中间态宽度测量导致窗口先撑高再回落。
  await nextTick()
  props.trackChatEvent?.('chat_expanded')
  void fetchSessions()
  if (opening) await scrollBottom(true)
  composerRef.value?.focus?.()
}

// 收起期间保留底部锚点，尺寸过渡结束后重新测量。
function exitExpanded() {
  markResizing()
  expanded.value = false
}

onMounted(() => {
  if (!preferencesStore.loaded) void preferencesStore.fetch()
  if (props.automaticModeAccess) {
    void refreshAutomaticMode().catch(() => {}).finally(() => { automaticModeStatusLoaded.value = true })
  } else void workspacesApi.status().then(status => {
    automaticModeGlobalEnabled.value = status.automaticModeGlobalEnabled === true
  }).catch(() => {
    automaticModeGlobalEnabled.value = false
  }).finally(() => {
    automaticModeStatusLoaded.value = true
  })
  window.addEventListener('gugu-quota-changed', onQuotaChanged)
  window.addEventListener('beforeunload', saveProgress)
  // 小窗也需要会话权限摘要，避免只有展开聊天窗口后才知道当前 Session 的授权状态。
  void fetchSessions()
  if (props.readUiLabels) {
    props.readUiLabels().then(r => {
      thinkingLabels.value = Array.isArray(r?.thinking) ? r.thinking : (r?.thinking ? [r.thinking] : [])
      contextCompactingLabels.value = Array.isArray(r?.contextCompacting)
        ? r.contextCompacting
        : (r?.contextCompacting ? [r.contextCompacting] : [])
    }).catch(() => {})
  }
  // 恢复上次会话：① 本标签刷新 → sessionStorage 仍在，直接接续；② 重开浏览器（sessionStorage 已清）
  //   → 仅当设置「重开接续上次」打开时，从 localStorage 的最近一段接续；否则开新对话。
  const hasSecretPromptLink = Boolean(props.readInteractionSession && router.currentRoute.value.query.mcp_credential_prompt)
  const saved = hasSecretPromptLink ? null : sessionStorage.getItem(SESSION_KEY)
              || (reopenResume.value ? localStorage.getItem(LAST_SESSION_KEY) : null)
  if (saved) {
    messages.value = []   // 续聊：立刻清掉默认问候占位，避免 loadSession 异步加载期间 animateGreeting 闪问候
    void restoreStartupSession({
      loadSession: () => loadSession(Number(saved), true),
      onUnavailable: () => {
        sessionStorage.removeItem(SESSION_KEY)
        localStorage.removeItem(LAST_SESSION_KEY)
        messages.value = [{ id: mkid(), role: 'ai', text: '', html: '', time: now(), _greeting: true }]
        void props.greetingAccess?.prefetch()
      },
      onFailure: () => showAppError(t('chatUi.networkError')),
    })
  } else {
    void recoverPendingQueue()
    // 全新对话（无可恢复会话）才需要默认问候 → 此刻后台生成；刷新/接续停在老会话时不空跑。
    void props.greetingAccess?.prefetch()
  }
  if (hasSecretPromptLink) void openSecretPromptLink()
})

async function openSecretPromptLink() {
  const rawPromptId = router.currentRoute.value.query.mcp_credential_prompt
  const promptId = Number(Array.isArray(rawPromptId) ? rawPromptId[0] : rawPromptId)
  if (!Number.isSafeInteger(promptId) || promptId <= 0) return
  open.value = true
  expanded.value = true
  try {
    if (!props.readInteractionSession) return
    const { session_id: targetSessionId } = await props.readInteractionSession(promptId)
    if (!Number.isSafeInteger(targetSessionId) || targetSessionId <= 0) return
    await loadSession(targetSessionId, true)
    if (sessionId.value === targetSessionId) {
      await router.replace({
        query: { ...router.currentRoute.value.query, mcp_credential_prompt: undefined },
      })
    }
  } catch {
    _chatTip(t('chatUi.messageUnavailable'))
  }
}
onUnmounted(() => {
  stopPendingQueueRecovery = true
  window.removeEventListener('gugu-quota-changed', onQuotaChanged)
  window.removeEventListener('beforeunload', saveProgress)
})

// ── 对话状态：见 useChatConversation.ts（消息/会话/流式/状态气泡机制全部收在那）──
const fabJumping     = ref(false)
function _chatTip(text: string) { messages.value.push({ id: mkid(), role: 'ai', text, time: now() }) }

// 附件（选择/拖拽/粘贴/暂存上传）与语音录制的唯一状态所有权在 useChatAttachments；
// 这里单次实例化，因为 send() 仍需要直接读 pendingAtt 来拼发送 payload。
const {
  pendingAtt, attUploading, onFilePicked,
  isChatDragging, onChatDragEnter, onChatDragOver, onChatDragLeave, onChatDrop, onPaste,
  removeAtt,
  recording, recordSecs, startRecord, stopRecord, cancelRecord,
} = useChatAttachments({
  onDropFiles: props.referenceDroppedFile ? async files => {
    const targetView = getViewGeneration()
    for (const file of files) {
      try {
        const reference = await props.referenceDroppedFile!(file)
        if (getViewGeneration() !== targetView) return
        if (inputReferences.value.length >= 50) return
        composerRef.value?.insertReferenceChip(reference)
      } catch (error) {
        if (getViewGeneration() === targetView)
          _chatTip(error instanceof Error ? error.message : t('mindUi.referenceMissing'))
      }
    }
  } : undefined,
  uploadAttachment: props.uploadAttachment,
  deleteDraftAttachment: props.deleteDraftAttachment,
  onError: (text) => _chatTip(text),
  onVoiceSent: () => { onChatSend() },   // 录完即发（含可能已输入的文字）
})

// 对话引擎（消息/会话/SSE 流式收发/状态气泡/滚动跟随）唯一状态所有权，见该文件头注释。


// 三个钩子回调由 useChatWindow 内部定义并通过本组件解构传进来，把「内容变化 → 窗口尺寸跟随」
// 这条链收在 useChatWindow 内闭环，本组件不写中间层。
const conversation = useChatConversation({
  greetingAccess: props.greetingAccess,
  deleteDraftAttachment: props.deleteDraftAttachment,
  sessionAccess: props.sessionAccess,
  httpStream: props.httpStream,
  cancelSession: props.cancelSession,
  readHistoryThroughMessage: props.readHistoryThroughMessage,
  composerRef, messageListRef, pendingAtt,
  refreshAfterTools, loadQuota: () => loadQuota(),
  trackMessageSent: props.trackMessageSent,
  onAutomaticModeCommand: () => refreshAutomaticMode().catch(() => {}),
  playIncomingMessageSfx: () => playIncomingMessageSfx(),
  onSyncSmallH,
  onQueuePersistenceError: () => showAppError(t('chatUi.pendingQueuePersistFailed')),
  onQueueDispatchError: () => showAppError(t('chatUi.networkError')),
  onPresentFile: (file) => previewStore.open({
    id: file.file_id,
    ext: (file.ext || '').toUpperCase(),
    displayName: file.name || `文件 #${file.file_id}`,
  }),
})
const {
  messages, mkid, now, sessionSettling, historyState, loadOlderHistory,
  inputText, inputReferences, thinkingLabels, contextCompactingLabels, streaming, statusKind, statusTyped, isTypingText,
  sessionId, getViewGeneration, isGroupSession,
  sessions, sessionsLoading, sessionsLoadFailed, webSessions, imSessions, currentSessionTitle, currentSessionWorkspaceName, currentSessionGoalActive, currentSessionGoalStatus,
  currentSessionFilesystemAuthorized, currentSessionFilesystemAuthorizationEnabled,
  restorePendingQueueForDraft,
  fetchSessions, loadSession, newSession, deleteSession, renameSession,
  send, stopStreaming, resumeStream,
  pendingQueue, removeQueued,
  scrollBottom, alignNewWindowToBottom,
  animateGreeting,
} = conversation

watch(streaming, active => {
  if (active && open.value && !expanded.value) enableCompactGrowth()
})

const badgeAuth = useAuthStore()
const webSessionBadges = useWebSessionBadges({
  sessions, sessionId, visible: open,
  accountId: computed(() => props.localSessionBadges ? 'desktop-local' : badgeAuth.user?.id ?? null),
  persist: !props.localSessionBadges,
})

// 业务空状态可以请求打开聊天并预填一条配置指令；只消费一次，绝不自动发送。
watch(() => uiStore.pendingChatPrefill, async (prompt) => {
  if (!prompt) return
  uiStore.pendingChatPrefill = null
  open.value = true
  inputText.value = prompt
  await nextTick()
  // 首次打开时编辑器刚完成挂载，明确把光标放到预填文本末尾。
  composerRef.value?.focusEnd?.()
}, { immediate: true })

const interruptPending = ref(false)
const canInterruptDetachedRun = computed(() => !streaming.value && sessions.value.some(session =>
  session.id === sessionId.value && (!session.source || session.source === 'web') && session.isRunning))
async function interruptDetachedRun() {
  const id = sessionId.value
  if (id == null || !canInterruptDetachedRun.value || interruptPending.value) return
  interruptPending.value = true
  try {
    const result = await (props.cancelSession ?? (id => agentApi.cancelSession(String(id))))(id)
    if (sessionId.value !== id) return
    if (result.outcome === 'requested') await resumeStream(id)
    else await loadSession(id, true)
    await fetchSessions()
  } catch {
    if (sessionId.value === id) showAppError(t('chatUi.cancelFailed'))
  } finally {
    interruptPending.value = false
  }
}

const visiblePendingQueue = computed(() => pendingQueue.value.filter(item => item.sessionId === sessionId.value))

let stopPendingQueueRecovery = false

async function recoverPendingQueue() {
  try {
    const localSnapshot = isPendingQueueRecoveryNeeded()
      ? await (props.readPendingQueue ?? agentApi.getPendingQueue)(getDraftPendingQueueId()).catch(() => ({ items: [] }))
      : { items: [] }
    const importedSnapshots = await (props.readImportedQueues ?? agentApi.listImportedDraftQueues)().catch(() => ({ queues: [] }))
    if (stopPendingQueueRecovery || sessionId.value != null) return
    const importedItems = importedSnapshots.queues.flatMap(queue => queue.items)
    restorePendingQueueForDraft([...localSnapshot.items, ...importedItems])
    setPendingQueueRecoveryNeeded(
      localSnapshot.items.length > 0 || importedItems.length > 0 || pendingQueue.value.length > 0,
    )
  } catch {
    // 不在页面后台轮询；恢复标记保留，下次打开聊天时再读服务端快照。
  }
}

watch(sessionId, (current, previous) => {
  if (current === null && previous !== null) void recoverPendingQueue()
})

// 授权/撤销成功后立即更新标题栏；会话列表刷新只负责把本地状态重新校准到服务端。
const sessionFilesystemAuthorized = ref(false)
watch([sessionId, currentSessionFilesystemAuthorized], ([id, authorized]) => {
  sessionFilesystemAuthorized.value = id != null && Boolean(authorized)
}, { immediate: true })

const sessionAuthorizationApi: FilesystemAuthorizationApi = {
  request: agentApi.requestFilesystemAuthorization,
  confirm: agentApi.confirmFilesystemAuthorization,
  revoke: agentApi.revokeFilesystemAuthorization,
}
const sessionAuthorization = useFilesystemAuthorization(sessionAuthorizationApi)

async function toggleSessionAuthorization() {
  if (sessionId.value == null || !currentSessionFilesystemAuthorizationEnabled.value) return
  try {
    if (sessionFilesystemAuthorized.value) {
      await sessionAuthorization.revoke(sessionId.value)
      const session = sessions.value.find(item => item.id === sessionId.value)
      if (session) session.filesystemAuthorized = false
      sessionFilesystemAuthorized.value = false
      await fetchSessions()
      return
    }
    await sessionAuthorization.request({ id: sessionId.value, name: currentSessionTitle.value })
  } catch (error) {
    _chatTip(errorMessage(error))
  }
}

async function confirmSessionAuthorization() {
  try {
    await sessionAuthorization.confirm()
    sessionFilesystemAuthorized.value = true
    await fetchSessions()
    sessionAuthorization.close()
  } catch (error) {
    _chatTip(errorMessage(error))
  }
}

const interactionAnswerMode = computed(() => {
  if (!sessionId.value) return 'inline' as const
  const activeSession = sessions.value.find(session => session.id === sessionId.value)
  return activeSession && (!activeSession.source || activeSession.source === 'web') ? 'inline' as const : 'composer' as const
})
const pendingCustomPromptId = computed(() => findPendingTextInteractionId(messages.value, interactionAnswerMode.value))

async function onInteractionSelect(message: ChatMessage, option: { id: string; label: string; token: string; selectedOptionIds?: string[]; customAnswer?: string }) {
  const interaction = message.interaction
  const currentSessionId = sessionId.value
  if (!interaction?.promptId || !currentSessionId) return
  const custom = option.id === CUSTOM_REPLY_OPTION_ID && !option.customAnswer
  if (custom && (!interaction.allowTextInput || interaction.kind === 'confirm')) return

  const resumesTool = !custom && Boolean(interaction.toolCallId)
  interaction.submitting = true
  if (!custom) interaction.customInputActive = false

  try {
    const result = await (props.respondToInteraction ?? respondToHttpInteraction)({
      action: 'select', sessionId: currentSessionId, runId: message.runId,
      promptId: interaction.promptId, token: option.token, resume: resumesTool, selectedOptionIds: option.selectedOptionIds, customAnswer: option.customAnswer,
    })
    if (result.status !== 'accepted') {
      if (result.status === 'expired' && !custom) {
        // 服务端拒绝后清除旧令牌的选择状态，保持运行历史中的卡片可见。
        interaction.resolved = true
        interaction.selectedOptionId = null
        interaction.submissionRejected = true
        interaction.responseText = result.detail ?? t('chatUi.interactionSubmitFailed')
      } else if (result.status !== 'unauthorized') {
        _chatTip(t('chatUi.interactionSubmitFailed'))
      }
      return
    }

    if (custom) {
      interaction.customInputActive = true
      if (interactionAnswerMode.value === 'composer') {
        await nextTick()
        composerRef.value?.focus?.()
      }
      return
    }

    interaction.resolved = true
    interaction.selectedOptionIds = option.selectedOptionIds
    interaction.customAnswer = option.customAnswer
    interaction.selectedOptionId = option.id
    interaction.responseText = option.label
    if (resumesTool && !interaction.delegated && sessionId.value === currentSessionId)
      void resumeStream(currentSessionId, result.runId ?? message.runId)
  } catch {
    _chatTip(t('chatUi.interactionSubmitFailed'))
    if (!custom) {
      interaction.resolved = false
      interaction.selectedOptionId = null
    }
  } finally {
    interaction.submitting = false
  }
}

function onSecretSubmit(message: ChatMessage, values: Record<string, string>) {
  return resolveSecretInteraction(message, { action: 'submit', values })
}

function onSecretCancel(message: ChatMessage) {
  return resolveSecretInteraction(message, { action: 'cancel' })
}

async function resolveSecretInteraction(
  message: ChatMessage,
  request: { action: 'submit'; values: Record<string, string> } | { action: 'cancel' },
) {
  const interaction = message.interaction
  if (!interaction?.promptId || !interaction.secretFields?.length) return
  const cancel = request.action === 'cancel'
  const failure = cancel ? 'chatUi.interactionSubmitFailed' : 'chatUi.secretSubmitFailed'
  const currentSessionId = sessionId.value
  try {
    if (!currentSessionId) throw new Error(t(failure))
    const result = await (props.respondToInteraction ?? respondToHttpInteraction)({
      action: 'secrets', sessionId: currentSessionId, runId: message.runId,
      promptId: interaction.promptId, secrets: cancel ? null : request.values,
    })
    if (result.status !== 'accepted') {
      if (result.status !== 'unauthorized') _chatTip(t(failure))
      return
    }
    interaction.resolved = true
    if (cancel) interaction.selectedOptionId = 'cancel'
    interaction.responseText = t(cancel ? 'chatUi.confirmationCancelled' : 'chatUi.secretSubmitted')
    if (result.runId && !interaction.delegated && sessionId.value === currentSessionId) void resumeStream(currentSessionId, result.runId)
  } catch {
    _chatTip(t(failure))
  } finally {
    interaction.submitting = false
  }
}

async function onInteractionTextSubmit(message: ChatMessage, text: string) {
  const interaction = message.interaction
  const promptId = interaction?.promptId
  const answer = text.trim()
  const currentSessionId = sessionId.value
  if (!promptId || !currentSessionId || !interaction?.allowTextInput || interaction.kind === 'confirm' || !answer) {
    if (interaction) interaction.submitting = false
    return
  }
  try {
    const result = await (props.respondToInteraction ?? respondToHttpInteraction)({
      action: 'text', sessionId: currentSessionId, runId: message.runId, promptId, text: answer,
    })
    if (result.status !== 'accepted') {
      if (result.status !== 'unauthorized') _chatTip(t('chatUi.interactionSubmitFailed'))
      return
    }
    interaction.resolved = true
    interaction.selectedOptionId = CUSTOM_REPLY_OPTION_ID
    interaction.responseText = answer
    interaction.customInputActive = false
    if (result.runId && !interaction.delegated && sessionId.value === currentSessionId) {
      void resumeStream(currentSessionId, result.runId)
      return
    }
    await nextTick()
    await scrollBottom()
  } catch {
    _chatTip(t('chatUi.interactionSubmitFailed'))
  } finally {
    interaction.submitting = false
  }
}

let chatCommandRunning = false
async function runChatCommand(): Promise<boolean> {
  if (!props.resolveChatCommand || pendingAtt.value.length || inputReferences.value.length) return false
  const draft = inputText.value
  const ownerSession = sessionId.value
  const generation = getViewGeneration()
  const execute = props.resolveChatCommand(draft.trim(), ownerSession)
  if (!execute) return false
  if (chatCommandRunning || automaticModeSaving.value) return true
  chatCommandRunning = true
  try {
    const result = await execute()
    if ('automaticModeEnabled' in result && result.automaticModeEnabled !== undefined) {
      localAutomaticMode.value = result.automaticModeEnabled
      automaticModeGlobalEnabled.value = true
    }
    if (getViewGeneration() === generation && sessionId.value === ownerSession) {
      const draftUnchanged = inputText.value === draft
      if (draftUnchanged) {
        inputText.value = ''
        composerRef.value?.resetHeight()
      }
      if (!('newSession' in result)) {
        _chatTip(result.text)
        if (result.refreshSessions) void fetchSessions()
      }
      else if (draftUnchanged) await newSession()
    }
  } catch {
    showAppError(t('chatUi.networkError'))
  } finally {
    chatCommandRunning = false
  }
  return true
}

async function onChatSend() {
  if (sessionSettling.value) return
  const promptId = pendingCustomPromptId.value
  if (!promptId) {
    if (await runChatCommand()) return
    await send()
    return
  }
  const message = messages.value.find(item => item.interaction?.promptId === promptId)
  const text = inputText.value.trim()
  if (!message?.interaction?.allowTextInput || message.interaction.kind === 'confirm' || !text) return
  await onInteractionTextSubmit(message, text)
  if (message.interaction.resolved) {
    inputText.value = ''
    composerRef.value?.resetHeight()
  }
}

async function onReferenceClick(reference: Pick<ChatReference, 'type' | 'id'>) {
  try {
    if (await props.openPlatformReference?.(reference)) return
    await openMindRef(reference.type, reference.id)
  } catch (error) {
    _chatTip(error instanceof Error ? error.message : t('mindUi.referenceMissing'))
  }
}

async function openChatObject(type: string, id: number) {
  if (type === 'project' || type === 'event') {
    await onReferenceClick({ type, id })
    return
  }
  const paths: Record<string, string> = {
    canvas: '/canvases', note: '/notes', 'scheduled-task': '/schedules',
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
    let blob: Blob
    if (props.readAttachment) {
      try {
        blob = await props.readAttachment(f.attach_id)
      } catch {
        showAppError(t('filesUi.downloadFailed'))
        return
      }
    } else {
      const res = await fetch(`${API_BASE}/agent/attachment/${f.attach_id}/download`, { credentials: 'include' })
      if (isUnauthorizedResponse(res)) return
      if (!res.ok) { console.error('附件下载失败', res.status); return }
      blob = await res.blob()
    }
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
      ...(f.attach_id && props.readAttachment ? { readContent: () => props.readAttachment!(f.attach_id!) } : {}),
      ext: (f.ext || '').toUpperCase(),
      displayName,
      size: fmtSize(f.size_bytes),
      // 真实像素尺寸（有的话）：预览窗口直接按此定尺，不用再靠缩略图猜大小
      imgWidth: f.img_width ?? null,
      imgHeight: f.img_height ?? null,
    }, null, true)
    return
  }
  downloadFile(f)
}

async function copyMsg(msg: ChatMessage) {
  // 复制消息源 Markdown，保留标题、列表、围栏代码块等语法；渲染后的纯文本会把这些结构压平。
  const copied = await copyTextToClipboard(msg.text)
  if (!copied) {
    showAppError(t('chatUi.copyFailed'))
    return
  }
  copiedId.value = msg.id
  setTimeout(() => { if (copiedId.value === msg.id) copiedId.value = null }, 1500)
}

// 任何打开路径（FAB / 通知点开 / 展开）都触发一次
watch(open, (v) => {
  if (v) { loadBots(); loadQuota(); loadVoiceAvailability(); pickOfflineLabel() }
})

// ── 展开/收起 ────────────────────────────────────────────
// ── 侧栏 IM 接入（飞书 / QQ / 微信）：Bot 列表、侧栏扫码连接、聊天内扫码绑定的唯一
// 状态所有权在 useChatImConnect；这里只持有它要操作的两个子组件 DOM 引用。
const sidebarRef    = ref<InstanceType<typeof GuguChatSidebar> | null>(null)
const bindDialogRef = ref<InstanceType<typeof GuguChatBindDialog> | null>(null)
const {
  imOpen, imPlatformOptions, imOnline, botsOf, imHighlight,
  loadBots, toggleImPlatform, promptConnectIM,
  telegramTokenDialogOpen, telegramConnecting, telegramConnectError,
  openTelegramTokenDialog, closeTelegramTokenDialog, submitTelegramToken,
  connecting, connect, connectHint, connectErr, setConnectCanvas,
  startImConnect, cancelImConnect,
  chatBind, openChatImBind, closeChatBind,
} = useChatImConnect({
  access: props.imAccess,
  sidebarRef, bindDialogRef,
  expanded, enterExpanded: () => enterExpanded(),
  fetchSessions: () => fetchSessions(),
})
const imSessionsOf = (platform: ImPlatformKey) => imSessions.value.filter(s => s.source === platform)

// ── 顶部状态：休息中（精力耗尽）> 在线（任意 IM 启用）> 随机离线 ──
const quota = ref<QuotaInfo | null>(null)
async function loadQuota() {
  if (!props.readQuota) return
  try { quota.value = await props.readQuota() } catch {}
}
const voiceInputAvailable = ref(false)
async function loadVoiceAvailability() {
  try {
    const result = await (props.readVoiceAvailability ?? agentApi.getVoiceAvailability)()
    voiceInputAvailable.value = result?.available === true
  } catch {
    voiceInputAvailable.value = false
  }
}
function onQuotaChanged() { loadQuota(); loadVoiceAvailability() }
const energyExhausted = computed(() => {
  const q = quota.value
  if (!q) return false
  return (q.limit_6h != null && (q.used_6h ?? 0) >= q.limit_6h) ||
         (q.limit_weekly != null && (q.used_weekly ?? 0) >= q.limit_weekly)
})
// 离线时随机显示「QQ/微信/飞书 离线」之一（每次打开换一个，暗示这些渠道还没接上）
const _OFFLINE_LABEL_KEYS = ['qqOffline', 'wechatOffline', 'feishuOffline', 'telegramOffline'] as const
const offlineLabel = ref('离线')
function pickOfflineLabel() { offlineLabel.value = t(`chatUi.${_OFFLINE_LABEL_KEYS[Math.floor(Math.random() * _OFFLINE_LABEL_KEYS.length)]}`) }
const presenceKind  = computed(() => energyExhausted.value ? 'resting' : (imOnline.value ? 'online' : 'offline'))
const presenceText  = computed(() => presenceKind.value === 'resting' ? t('chatUi.resting')
                                   : presenceKind.value === 'online'  ? t('chatUi.online') : offlineLabel.value)
const presenceTitle = computed(() => presenceKind.value === 'resting' ? t('chatUi.restingHint')
                                   : presenceKind.value === 'online'  ? t('chatUi.onlineHint')
                                   : t('chatUi.offlineHint'))

</script>
