<template>
  <!-- 单一聊天窗口（单一元素，小/大状态通过位置过渡）。窗口外壳、标题栏、展开/收起
       按钮、消息列表与输入框的唯一 DOM 所有权收在这里；GuguChatBindDialog 与
       GuguChatSidebar 通过插槽由父组件填充（它们的 ref 由父组件持有，供 useChatImConnect
       使用）。 -->
  <!-- top/left/right/bottom 的 0.42s 过渡只属于用户主动的大窗↔小窗切换。
       浏览器 viewport resize、流式小窗增高和其它普通几何更新不带 is-layout-resizing，
       因而直接跟随 layout；避免滚动容器/原生 scrollbar 追着旧几何缓动。 -->
  <div class="chat-window" :class="{ 'is-layout-resizing': resizing }" :style="windowStyle" ref="windowEl"
    @mousedown.capture="onRaiseChat"
    @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop"
    @pointerover="onRefPointerOver" @pointerleave="refDropHover = false">
    <!-- 用透明全窗锚点接收 Runtime 落地，避免把聊天窗口自身当作项目卡的 morph 目标。 -->
    <div ref="chatRefTargetEl" class="chat-ref-target" aria-hidden="true"></div>

    <Transition name="chat-drop-fade">
      <GuguChatDropOverlay v-if="isChatDragging && !dropFilesAsReferences" kind="attachment" />
    </Transition>
    <Transition name="chat-drop-fade">
      <GuguChatDropOverlay v-if="refDropHover || (isChatDragging && dropFilesAsReferences)" kind="reference" />
    </Transition>

    <!-- 扫码绑定 IM 弹窗 / 侧边栏：由父组件通过插槽填充 -->
    <slot name="bind-dialog" />
    <slot name="sidebar" />

    <!-- 主区域（始终存在，消息列表永不销毁） -->
    <div class="chat-main" :class="{ 'is-expanded': expanded, 'is-resizing': resizing }">
      <div class="chat-header">
        <template v-if="expanded && sessionId && !previewOnly">
          <SessionTitleEdit
            class="chat-title"
            header
            :title="currentSessionTitle"
            :on-rename="(t) => onRenameSession(sessionId!, t)"
          />
          <span v-if="currentSessionGoalStatus" class="chat-goal-indicator" :class="`is-${currentSessionGoalStatus}`" :title="currentSessionGoalStatus === 'paused' ? t('chat.goalPaused') : t('chat.goalRunning')">
            <i :class="currentSessionGoalStatus === 'paused' ? 'ri-pause-circle-line' : 'ri-focus-3-line'" aria-hidden="true" />
            {{ currentSessionGoalStatus === 'paused' ? t('chat.goalPausedShort') : t('chat.goalRunningShort') }}
          </span>
        </template>
        <span v-else class="chat-title" :class="{ 'is-new-session': expanded && !sessionId }">{{ expanded ? currentSessionTitle : t('chatUi.gugu') }}</span>
        <span v-if="currentSessionWorkspaceName" class="chat-workspace-name" :class="{ 'is-compact': !expanded }">
          · {{ currentSessionWorkspaceName }}
        </span>
        <button
          v-if="sessionId && filesystemAuthorizationEnabled"
          type="button"
          class="filesystem-auth-button"
          :class="{ authorized: filesystemAuthorized }"
          :title="filesystemAuthorized ? t('chat.filesystemAuthRevoke') : t('chat.filesystemAuthButton')"
          :aria-label="filesystemAuthorized ? t('chat.filesystemAuthRevoke') : t('chat.filesystemAuthButton')"
          @click="onFilesystemAuthorization"
        >
          <Icon :name="filesystemAuthorized ? 'admin.shieldAuthorized' : 'admin.shield'" :size="13" />
        </button>
        <GuguChatSubagentStatus v-if="!previewOnly" :key="sessionId ?? 'new'" :messages="messages" :session-id="sessionId" />
        <span v-if="!previewOnly" class="popup-status" :class="'is-' + presenceKind"
              @click="presenceKind === 'offline' && onPromptConnect()"
              :title="presenceTitle">
          <span class="status-dot" aria-hidden="true" /><span class="popup-status-label">{{ presenceText }}</span>
        </span>
        <div class="btn-group">
          <button v-if="!expanded" class="popup-icon-btn" @click="onEnterExpanded" :title="t('chat.expand')" :aria-label="t('chat.expand')">
            <Icon name="action.expand" :size="13" />
          </button>
          <button v-if="expanded" class="exp-icon-btn" @click="onExitExpanded" :title="t('chat.collapse')" :aria-label="t('chat.collapse')">
            <Icon name="action.collapse" :size="14" />
          </button>
          <button class="popup-close-btn" @click="onClose" :title="t('common.actions.close')" :aria-label="t('common.actions.close')">
            <Icon name="action.close" :size="13" />
          </button>
        </div>
      </div>

      <GuguChatMessageList
        ref="messageListRef"
        :messages="messages" :session-id="sessionId" :is-group-session="isGroupSession"
        :interaction-answer-mode="interactionAnswerMode"
        :copied-id="copiedId" :voice-playing-id="voicePlayingId" :voice-bars="voiceBars"
        :expanded="expanded" :resizing="resizing" :streaming="streaming" :status-kind="statusKind" :status-typed="statusTyped"
        :session-settling="sessionSettling"
        :history-state="historyState" :on-load-history="onLoadHistory"
        @copy="onCopy" @toggle-voice="onToggleVoice"
        @open-file="onOpenFile" @download="onDownload" @action-click="onActionClick"
        @interaction-select="onInteractionSelect" @interaction-text-submit="onInteractionTextSubmit"
        @secret-submit="onSecretSubmit" @secret-cancel="onSecretCancel" @reference-click="onReferenceClick"
      />

      <!-- 排队条：生成中发出的消息不进对话流，在这里排队展示（可单条移除）；
           排水真正发送时才作为用户气泡落入对话，后面跟本轮回复。 -->
      <div v-if="pendingQueue.length" class="chat-pending-strip" role="list" :aria-label="t('chatUi.pendingQueue')">
        <div v-for="item in pendingQueue" :key="`${item.queueId}:${item.key}`" class="chat-pending-item" role="listitem">
          <span class="chat-pending-state">
            <Icon name="status.loading" :size="11" class="chat-pending-spin" />
            <span>{{ t('chatUi.pendingQueue') }}</span>
          </span>
          <span class="chat-pending-text" :title="item.text">{{ item.text || t('chatUi.pendingQueue') }}</span>
          <button class="chat-pending-remove" :title="t('chatUi.removeQueued')" :aria-label="t('chatUi.removeQueued')" @click="emit('removeQueued', item.queueId, item.key)">
            <Icon name="action.close" :size="12" />
          </button>
        </div>
      </div>

      <slot name="conversation-status" />

      <!-- 输入框 -->
      <GuguChatComposer
        ref="composerRef"
        v-model="inputTextModel"
        :owner-z="props.ownerZ"
        :preview-only="previewOnly" :text-only="textOnly"
        :references="props.references" @update:references="emit('update:references', $event)"
        :pending-att="pendingAtt" :att-uploading="attUploading" :standalone-references="dropFilesAsReferences"
        :recording="recording" :record-secs="recordSecs" :voice-input-available="voiceInputAvailable"
        :expanded="expanded" :streaming="streaming" :vw="vw"
        :automatic-mode-enabled="automaticModeEnabled"
        :automatic-mode-available="automaticModeAvailable"
        :automatic-mode-saving="automaticModeSaving"
        :on-toggle-automatic-mode="onToggleAutomaticMode"
        :on-remove-att="onRemoveAtt"
        :on-start-record="onStartRecord" :on-cancel-record="onCancelRecord" :on-stop-record="onStopRecord"
        :on-file-picked="onFilePicked" :on-paste="onPaste"
        :on-send="onSend" :on-stop-streaming="onStopStreaming" :on-reference-click="onReferenceClick"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import GuguChatDropOverlay from './GuguChatDropOverlay.vue'
import type { ChatHistoryState } from './composables/useChatHistoryPagination'
import { ref, computed, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
/**
 * 聊天窗口外壳：窗口 DOM、标题栏、展开/收起按钮、消息列表与输入框的挂载点。
 * 不拥有任何业务状态——messages / inputText / 附件 / 录音 / 流式 / 会话全部由父组件
 * 传入（props）或通过回调（onXxx）通知父组件。
 *
 * 内部持有三个 DOM/组件引用：windowEl（chat-window 本体，供 markResizing 监听
 * transitionend）、messageListRef（GuguChatMessageList 实例，暴露 el/scrollToIndex）、
 * composerRef（GuguChatComposer 实例，暴露 focus/fitTextarea/resetHeight）。通过
 * defineExpose 暴露给父组件，父组件再注入 useChatWindow / useChatConversation。
 */
import GuguChatSubagentStatus from './GuguChatSubagentStatus.vue'
import GuguChatMessageList from './GuguChatMessageList.vue'
import GuguChatComposer from './GuguChatComposer.vue'
import SessionTitleEdit from './SessionTitleEdit.vue'
import type { ChatMessage, ChatFile, ChatReference, InteractionAnswerMode } from './chatTypes'
import { CHAT_REF_ACCEPTS, CHAT_REF_SURFACE_ID } from './chatTypes'
import { runtime } from '@/interaction/runtime'
import type { QueuedMessage } from './composables/useChatStream'

const props = defineProps<{
  // 窗口展示
  previewOnly?: boolean
  textOnly?: boolean
  windowStyle: Record<string, string | number>
  ownerZ: number
  expanded: boolean
  resizing: boolean
  streaming: boolean
  automaticModeEnabled: boolean
  automaticModeAvailable: boolean
  automaticModeSaving: boolean
  onToggleAutomaticMode: () => void
  isChatDragging: boolean
  dropFilesAsReferences?: boolean
  currentSessionTitle: string
  currentSessionWorkspaceName: string | null
  currentSessionGoalActive: boolean
  currentSessionGoalStatus: 'active' | 'paused' | null
  filesystemAuthorized: boolean
  filesystemAuthorizationEnabled: boolean
  sessionId: number | null
  interactionAnswerMode: InteractionAnswerMode
  presenceKind: string
  presenceText: string
  presenceTitle: string
  // 消息列表
  messages: ChatMessage[]
  isGroupSession: boolean
  copiedId: number | null
  voicePlayingId: string | null
  voiceBars: number[]
  statusKind: string
  statusTyped: string
  historyState?: ChatHistoryState
  onLoadHistory?: () => void
  sessionSettling: boolean
  // 排队条：生成中发出的消息在输入框上方排队，排水发送时才落入对话
  pendingQueue: QueuedMessage[]
  // 输入框
  inputText: string
  references: ChatReference[]
  pendingAtt: ChatFile[]
  attUploading: boolean
  recording: boolean
  voiceInputAvailable: boolean
  recordSecs: number
  vw: number
  // 回调
  onRemoveAtt: (a: ChatFile) => void
  onStartRecord: () => void
  onCancelRecord: () => void
  onStopRecord: () => void
  onFilePicked: (e: Event) => void
  onPaste: (e: ClipboardEvent) => void
  onSend: () => void
  onStopStreaming: () => void
  onCopy: (msg: ChatMessage) => void
  onToggleVoice: (file: ChatFile) => void
  onOpenFile: (file: ChatFile) => void
  onDownload: (file: ChatFile) => void
  onActionClick: (e: MouseEvent) => void
  onInteractionSelect: (msg: ChatMessage, option: { id: string; label: string; token: string; selectedOptionIds?: string[]; customAnswer?: string }) => void
  onInteractionTextSubmit: (msg: ChatMessage, text: string) => void
  onSecretSubmit: (msg: ChatMessage, values: Record<string, string>) => void
  onSecretCancel: (msg: ChatMessage) => void
  onReferenceClick: (reference: ChatReference) => void
  onPromptConnect: () => void
  onFilesystemAuthorization: () => void
  onRenameSession: (id: number, title: string) => void
  onEnterExpanded: () => void
  onExitExpanded: () => void
  onClose: () => void
  onRaiseChat: () => void
  onDragEnter: (e: DragEvent) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}>()
const { t } = useI18n()

const emit = defineEmits<{
  'update:inputText': [value: string]
  'update:references': [value: ChatReference[]]
  removeQueued: [queueId: string, key: number]
}>()

// inputText 是 props（只读），用 computed 包装成可写的 v-model 桥，把输入变化
// 通过 emit('update:inputText') 回传给父组件（父组件持有真正的 inputText 状态）。
const inputTextModel = computed({
  get: () => props.inputText,
  set: (v: string) => emit('update:inputText', v),
})

const windowEl = ref<HTMLElement | null>(null)
const chatRefTargetEl = ref<HTMLElement | null>(null)

// ── 拖文件卡进聊天 = @ 引用（Runtime 投放目标：整个窗口都是判定区）──
// 消费动作在 GuguChatComposer（插 chip），这里只负责目标注册与悬停遮罩。
// 投放代理是 pointer-events:none，拖拽悬停时窗口能收到 pointer 事件；
// 主键按下才视为拖拽悬停，普通划过不亮遮罩。松手（window pointerup）即清除，
// 不然松开文件后指针仍在窗口里，遮罩会一直挂着。
const refDropHover = ref(false)
const chatRefSurfaceGeneration = runtime.surfaces.register({
  id: CHAT_REF_SURFACE_ID,
  type: 'chat-composer',
  layout: 'grid',
  accepts: [...CHAT_REF_ACCEPTS],
  element: null,
})
const chatRefTargetGeneration = runtime.targets.register({
  id: `${CHAT_REF_SURFACE_ID}:target`,
  surfaceId: CHAT_REF_SURFACE_ID,
  accepts: [...CHAT_REF_ACCEPTS],
  priority: 5,
  element: null,
})
watch(chatRefTargetEl, (element, previous) => {
  if (element === null && previous) return
  runtime.targets.setElement(`${CHAT_REF_SURFACE_ID}:target`, element)
}, { flush: 'post' })
onUnmounted(() => {
  runtime.targets.unregister(`${CHAT_REF_SURFACE_ID}:target`, chatRefTargetGeneration)
  runtime.surfaces.unregister(CHAT_REF_SURFACE_ID, chatRefSurfaceGeneration)
  window.removeEventListener('pointerup', onRefPointerUp)
})

function onRefPointerOver(event: PointerEvent) {
  // 必须是 Runtime 拖拽中：源卡片上会打 data-runtime-active 标记。
  // 只判主键按下会把「框选文字」误判成拖拽（同样按着左键划过窗口）。
  if (!props.previewOnly && (event.buttons & 1) && document.querySelector('[data-runtime-active]')) refDropHover.value = true
}
// capture 阶段监听：源卡片处理器可能 stopPropagation，冒泡到不了 window。
function onRefPointerUp() { refDropHover.value = false }
window.addEventListener('pointerup', onRefPointerUp, true)
window.addEventListener('pointerup', onRefPointerUp)
const messageListRef = ref<InstanceType<typeof GuguChatMessageList> | null>(null)
const composerRef = ref<InstanceType<typeof GuguChatComposer> | null>(null)

defineExpose({
  el: windowEl,
  messageListRef,
  composerRef,
})
</script>

<style scoped>
/* ── 单一聊天窗口 ── */
.chat-window {
  position: fixed;
  /* z-index 由 :style 动态(统一窗口带,点谁谁上) */
  border: 1px solid rgba(255,255,255,0.7);
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(20,25,50,0.18);
  isolation: isolate;   /* 独立层叠上下文：z-index/合成跟页面其余部分互不干扰，展开/收起动画时不牵连外部重绘 */
}
.chat-window--standalone {
  inset: var(--space-xs);
  top: var(--native-chat-top, var(--space-xs));
  left: var(--native-chat-left, var(--space-xs));
  width: var(--native-chat-width, auto);
  height: var(--native-chat-height, auto);
}
.chat-window--standalone:focus { outline: none; }
.chat-window::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: 20px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.95), inset 1px 0 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(255,255,255,0.3);
  pointer-events: none;
  z-index: 100;
}
.chat-ref-target {
  position: absolute;
  inset: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
  pointer-events: none;
}

/* 主区域使用静态主题面，不采样页面背后的内容；聊天窗口覆盖项目页时避免大面积重绘。 */
.chat-main {
  background: var(--gugu-chat-main-bg);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* 只有用户主动大/小窗切换才做几何缓动；普通 viewport resize 直接同步 layout。 */
.chat-window.is-layout-resizing:not(.chat-window--standalone) {
  will-change: top, left, right, bottom;
  transition: top 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              left 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              right 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              bottom 0.42s cubic-bezier(0.16, 1, 0.3, 1);
}

/* Web 和桌面端共用从右下角展开和收起的过渡。 */
.chat-window.chat-open-enter-active {
  transition: opacity 0.22s ease, transform 0.36s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: right bottom;
}
.chat-window.chat-open-leave-active {
  transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(0.7, 0, 0.84, 0);
  transform-origin: right bottom;
}
.chat-window.chat-open-enter-from, .chat-window.chat-open-leave-to { opacity: 0; transform: scale(0.78); }

/* ── 拖入附件遮罩 ── */
.chat-drop-fade-enter-active, .chat-drop-fade-leave-active { transition: opacity 0.15s ease; }
.chat-drop-fade-enter-from, .chat-drop-fade-leave-to { opacity: 0; }

/* ── 单一布局 ── */
.chat-window { display: flex; }
.chat-main { --chat-assistant-bubble-max-width: 100%; flex: 1; min-width: 0; display: flex; flex-direction: column; }

.chat-header {
  min-height: var(--gugu-chat-header-height);
  box-sizing: border-box;
  display: flex; align-items: center; gap: 9px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--gugu-chat-header-border, rgba(255,255,255,0.5));
  flex-shrink: 0;
}
.chat-window :deep(.chat-header:has(.subagent-popovers)) {
  position: relative;
  z-index: calc(var(--scrollbar-overlay-z-index) + 1);
}
.chat-main.is-expanded .chat-header { padding: 0 8px 0 20px; }
.chat-title { display:inline-flex; align-items:center; font-size: 13px; font-weight: 700; }
.chat-title.is-new-session { display: inline-flex; padding: 2px 6px; }
.chat-main.is-expanded .chat-title { font-size: 14px; font-weight: 600; }
.chat-workspace-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--theme-content-tertiary);
  font-size: 12px;
  font-weight: 500;
}
/* workspace 与授权入口保持语义相邻；右侧空余空间由在线状态吸收。 */
.chat-workspace-name.is-compact { flex: 0 1 auto; }
.chat-goal-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  max-width: 130px;
  padding: 3px 7px;
  border: 1px solid var(--action-primary);
  border-radius: var(--radius-pill, 999px);
  background: var(--action-soft);
  color: var(--action-primary);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
}
.chat-goal-indicator i { font-size: 13px; }
.chat-goal-indicator.is-paused {
  border-color: var(--border-subtle);
  background: var(--surface-soft);
  color: var(--content-secondary);
}
.filesystem-auth-button {
  width: 26px; height: 26px; flex: 0 0 auto; padding: 0;
  /* 授权入口紧跟 workspace；收起态由 workspace 的伸展规则自然落在右侧。 */
  margin-left: -6px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: 7px; background: transparent;
  color: var(--content-tertiary); cursor: pointer;
  transition: background .15s ease, color .15s ease;
}

.filesystem-auth-button.authorized { color: var(--color-success); }
.filesystem-auth-button .app-icon { transform: translateY(1px); }
/* 让 im 状态 + 按钮组始终靠右，标题按内容收缩；不再用 flex: 1 撑大标题，避免把右侧元素挤变形 */
.popup-status { margin-left: auto; flex-shrink: 0; white-space: nowrap; }
.popup-status { font-size: 11px; color: var(--color-success); display: flex; align-items: center; gap: 4px; line-height: 1; }
.status-dot { display: block; flex: 0 0 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--color-success); transition: background .15s, box-shadow .15s; }
.popup-status-label { display: inline-flex; align-items: center; line-height: 1; }
/* 离线：克制的暗示——灰点、弱化文字、可点；只在 hover 才微微亮起（点用暖色 + 细光环），平时不抢眼 */
.popup-status.is-offline { color: var(--text-secondary); cursor: pointer; opacity: .85; transition: color .15s, opacity .15s; }
.popup-status.is-offline .status-dot { background: var(--text-secondary); }
.popup-status.is-offline:hover { opacity: 1; color: var(--text-primary); }
.popup-status.is-offline:hover .status-dot { background: var(--color-warning); box-shadow: 0 0 0 3px rgba(176, 120, 88, 0.22); }
/* 休息中（精力耗尽）：暖色、点轻微呼吸，不可点 */
.popup-status.is-resting { color: var(--color-warning); cursor: default; }
.popup-status.is-resting .status-dot { background: var(--color-warning); animation: restPulse 1.8s ease-in-out infinite; }
@keyframes restPulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.btn-group { display: flex; align-items: center; gap: 2px; margin-inline-start: auto; }
.popup-status + .btn-group { margin-inline-start: 0; }

.popup-icon-btn {
  width: 26px; height: 26px; border-radius: 7px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}

.popup-icon-btn svg { display: block; }
.popup-close-btn {
  width: 26px; height: 26px; border-radius: 7px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.popup-close-btn svg { display: block; }
:is(.filesystem-auth-button, .popup-icon-btn, .popup-close-btn, .exp-icon-btn):hover:not(:disabled) {
  background: var(--action-soft);
  color: var(--control-fg-strong);
}

/* 消息列表容器与内部结构渲染于 GuguChatMessageList.vue，需要 :deep() 穿透 */
:deep(.chat-messages) {
  flex: 1; overflow-y: auto; overflow-x: hidden; position: relative;
}
.chat-main.is-expanded { --chat-assistant-bubble-max-width: 90%; }
.chat-main.is-expanded :deep(.chat-messages .msg:is(.ai, .member) .msg-bubble) { font-size: 14px; }
.chat-main.is-expanded :deep(.chat-messages .msg-quoted) { max-width: 72%; font-size: 13.5px; }
:deep(.msg-virtual-spacer) { position: relative; width: 100%; }
:deep(.msg-virtual-row) { position: absolute; top: 0; left: 0; width: 100%; box-sizing: border-box; padding: 0 13px var(--space-xs); }
.chat-main.is-expanded :deep(.msg-virtual-row) { padding: 0 24px var(--space-sm); }
:deep(.msg-virtual-row.is-tool-row), .chat-main.is-expanded :deep(.msg-virtual-row.is-tool-row),
:deep(.msg-virtual-row.is-interaction-row), .chat-main.is-expanded :deep(.msg-virtual-row.is-interaction-row) { padding-bottom: var(--space-xs); }
:deep(.chat-generation-status) { padding: 0 13px var(--space-xs); }
.chat-main.is-expanded :deep(.chat-generation-status) { padding-inline: 24px; }

/* ── 排队条：生成中发出的消息在输入框上方排队（不进对话流），排水发送时落入对话 ── */
.chat-pending-strip {
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  padding: 8px 13px;
  border-top: 1px solid color-mix(in srgb, var(--content-tertiary) 12%, transparent);
}
.chat-main.is-expanded .chat-pending-strip { padding-inline: 24px; }
.chat-pending-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) 24px;
  align-items: center;
  gap: 8px;
  width: fit-content;
  max-width: min(88%, 640px);
  min-height: 40px;
  box-sizing: border-box;
  padding: 5px 7px 5px 9px;
  border: 1px solid color-mix(in srgb, var(--gugu-chat-user-bg) 28%, var(--gugu-chat-header-border));
  border-radius: 14px 14px 4px 14px;
  background: color-mix(in srgb, var(--gugu-chat-user-bg) 12%, var(--gugu-chat-main-bg));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--content-primary) 5%, transparent);
  font-size: 12px;
  line-height: 1.45;
  color: var(--content-primary);
}
.chat-pending-state {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--gugu-chat-user-bg) 12%, transparent);
  color: var(--action-primary);
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
}
.chat-pending-spin { display: block; animation: chat-pending-rotate 1.2s linear infinite; flex-shrink: 0; }
@keyframes chat-pending-rotate { to { transform: rotate(360deg); } }
.chat-pending-text {
  min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chat-pending-remove {
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%; padding: 0;
  background: transparent; color: var(--content-tertiary);
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.chat-pending-remove svg { display: block; }
.chat-pending-remove:hover { background: color-mix(in srgb, var(--content-primary) 9%, transparent); color: var(--content-primary); }

/* 收起按钮（窗口头部，不在侧栏里） */
.exp-icon-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s; flex-shrink: 0;
}
.exp-icon-btn svg { display: block; }

/* 咕咕回复里的动作按钮：md 里的 gugu:// 链接渲染成按钮（onChatActionClick 拦截点击）——
   跟全局 .press-fx 一套手感（悬停不上浮，只在按下时下沉），这些 <a> 是 markdown 渲染出来的、
   没法在模板里挂 class，数值直接写这里（hover/active 与全局 .press-fx 保持一致） */
/* .msg-bubble.md-body 本体现在渲染于 GuguChatMessageRow.vue（子组件），这里必须整条选择器都用 :deep() 才能穿透组件边界匹配到，光把内层 a 包 :deep()
   不够——外层 class 名同样带着父组件的 scope 校验。 */
:deep(.msg-bubble.md-body a[href^="gugu://"]:not(.chat-object-card, .chat-smart-row, .chat-smart-button, .chat-file-card-download)) {
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
    transform var(--motion-hover-control) var(--motion-ease-standard),
    opacity var(--motion-hover-control) var(--motion-ease-standard);
  user-select: none;
}
:deep(.chat-object-link-icon) { inline-size: 1em; block-size: 1em; flex: none; fill: currentColor; }
:deep(.msg-bubble.md-body a[href^="gugu://"]:not(.chat-object-card, .chat-smart-row, .chat-smart-button, .chat-file-card-download) strong) {
  color: inherit;
}
/* 咕咕回复的 `---` 分隔线：实色次级文字色，全主题可辨，与预览窗 .tv-md hr 同口径 */
:deep(.msg-bubble.md-body hr) {
  border: none;
  border-top: 1px solid color-mix(in srgb, var(--content-primary) 20%, transparent);
  margin: 1.25em 0;
}
:deep(.chat-object-cards) {
  display: grid; align-items: stretch; gap: var(--space-sm);
  inline-size: 100%; max-inline-size: 420px; min-width: 0; margin-block: var(--space-sm);
}
:deep(.chat-folder-card-count) {
  color: var(--content-secondary); font-size: var(--font-size-xs);
}
:deep(.chat-folder-card-previews) {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-xs); min-width: 0;
}
:deep(.chat-folder-card-previews:empty) { display: none; }
:deep(.chat-folder-card-tile), :deep(.chat-folder-card-more) {
  position: relative;
  display: grid;
  place-items: center;
  min-width: 0;
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid var(--action-outline);
  border-radius: var(--radius-sm);
  background: var(--surface-card-solid);
  color: var(--content-secondary);
}
:deep(.chat-folder-card-more) {
  background: var(--surface-soft);
  color: var(--content-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  font-variant-numeric: tabular-nums;
}
:deep(.chat-file-card-actions) {
  position: relative; break-inside: avoid; min-width: 0;
  --chat-file-info-row-height: 52px;
  anchor-scope: --chat-file-info;
}
:deep(.chat-object-cards.is-multiple > .chat-file-card-actions) { margin-block-end: var(--space-sm); }
:deep(.chat-file-card-actions > .chat-object-card[href] .chat-object-file-identity) {
  margin-inline-end: 36px;
}
:deep(.chat-file-card-actions > .chat-object-card:is([href], button) .chat-object-card-details) {
  margin-inline-end: calc(var(--chat-file-info-row-height) + var(--space-xs));
}
:deep(.msg-bubble.md-body a.chat-file-card-download),
:deep(.chat-attachment-card > button.chat-file-card-download) {
  position: absolute; inset-inline-end: 14px; inset-block-end: 14px;
  display: grid; place-items: center; inline-size: 30px; block-size: 30px;
  margin: 0; padding: 0; border: 0; text-decoration: none;
  border-radius: var(--radius-xs); color: var(--content-secondary);
  background: var(--surface-soft);
}
:deep(.chat-file-card-actions:has(.chat-object-card-details) > .chat-file-card-download) {
  inline-size: var(--chat-file-info-row-height); block-size: var(--chat-file-info-row-height);
  inset-block-end: 16px;
}
:deep(.chat-file-card-actions:has(.chat-object-card-details):has(.chat-object-image-preview.is-loaded) > .chat-file-card-download) {
  inset-block-end: 11px;
}
:deep(.chat-file-card-actions .chat-object-card-details > .chat-object-card-fact) {
  box-sizing: border-box; min-block-size: var(--chat-file-info-row-height);
}
:deep(.chat-file-card-actions .chat-object-card-details > .chat-object-card-fact:first-child) {
  anchor-name: --chat-file-info;
}
@supports (anchor-scope: --chat-file-info) {
  :deep(.chat-file-card-actions:has(.chat-object-card-details) > .chat-file-card-download) {
    position-anchor: --chat-file-info;
    inset-block-start: anchor(start);
    inset-block-end: anchor(end);
    inline-size: anchor-size(--chat-file-info block, var(--chat-file-info-row-height));
    block-size: auto;
  }
}
:deep(.msg-bubble.md-body a.chat-file-card-download:hover),
:deep(.chat-attachment-card > button.chat-file-card-download:hover) {
  color: var(--action-primary); background: var(--action-soft);
}
:deep(.msg-bubble.md-body a.chat-file-card-download svg),
:deep(.chat-attachment-card > button.chat-file-card-download svg) {
  inline-size: 16px; block-size: 16px; display: block;
}
:deep(.chat-file-card-actions:not(:has(.chat-object-card:is([href], button))) > .chat-file-card-download) { display: none; }
:deep(.chat-folder-card-tile img) {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0;
}
:deep(.chat-folder-card-tile img.is-loaded) { opacity: 1; }
:deep(.chat-object-cards.is-multiple) {
  display: block; max-inline-size: none;
  column-width: 280px; column-gap: var(--space-sm);
}
:deep(.chat-object-cards.is-multiple > .chat-object-card) {
  break-inside: avoid; margin-block-end: var(--space-sm);
}
:deep(.msg-bubble.md-body a.chat-object-card),
:deep(.chat-attachment-card > button.chat-object-card) {
  position: relative; isolation: isolate;
  display: flex; flex-direction: column; justify-content: flex-start; gap: var(--space-sm);
  box-sizing: border-box; inline-size: 100%; min-width: 0; padding: 15px 16px;
  color: var(--content-primary);
  background-color: var(--surface-card-solid);
  border: 1px solid var(--action-outline); border-radius: var(--card-radius);
  text-decoration: none; cursor: pointer;
  transition: background-color var(--motion-hover-control), border-color var(--motion-hover-control);
}
:deep(.msg-bubble.md-body a.chat-object-card[href]:hover),
:deep(.chat-file-card-actions:hover > .chat-object-card:is([href], button)) {
  color: var(--content-primary); opacity: 1;
  background-color: var(--card-surface-bg-hover); border-color: var(--action-primary);
}
:deep(.msg-bubble.md-body a.chat-object-card:focus-visible),
:deep(.chat-attachment-card > button.chat-object-card:focus-visible) { outline: 2px solid var(--border-focus); outline-offset: -2px; }
:deep(.msg-bubble.md-body a.chat-object-card:active),
:deep(.chat-attachment-card > button.chat-object-card:active) { opacity: 0.9; }
:deep(.msg-bubble.md-body a.chat-object-card.is-snapshot) { cursor: default; }
:deep(.msg-bubble.md-body a.chat-object-card:not([href])) { cursor: default; }
:deep(.chat-object-card-snapshot) {
  color: var(--content-secondary); font-size: var(--font-size-xs);
}
:deep(.chat-object-card-heading) { display: flex; align-items: center; gap: var(--space-xs); min-width: 0; }
:deep(.chat-object-card-kind), :deep(.chat-object-card-description) {
  color: var(--content-secondary); font-size: var(--font-size-sm); overflow-wrap: anywhere;
}
:deep(.chat-object-card-title) {
  color: var(--content-primary); font-size: var(--font-size-xl); font-weight: 600;
  line-height: 1.35; overflow-wrap: anywhere;
}
:deep(.chat-object-card-description) { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
:deep(.chat-object-card[data-object-type="note"] .chat-object-card-description) {
  -webkit-line-clamp: 3; line-height: 1.55;
  padding-inline-start: 10px; border-inline-start: 2px solid var(--content-divider);
}
:deep(.chat-object-card:is([data-object-type="skill"], [data-object-type="scheduled-task"]) .chat-object-card-description) {
  -webkit-line-clamp: 3; line-height: 1.55;
  padding-block-start: 8px; border-block-start: 1px solid var(--content-divider);
}
:deep(.chat-schedule-status) {
  margin-inline-start: auto; padding: 2px 7px;
  border-radius: var(--radius-pill); background: var(--surface-soft);
  color: var(--content-secondary); font-size: var(--font-size-xs);
}
:deep(.chat-schedule-status.is-active) {
  color: var(--status-success); background: color-mix(in srgb, var(--status-success) 14%, transparent);
}
:deep(.chat-canvas-card-context) {
  display: flex; align-items: center; gap: var(--space-xs); min-width: 0;
  padding-block-start: 8px; border-block-start: 1px solid var(--content-divider);
  color: var(--content-secondary); font-size: var(--font-size-xs);
}
:deep(.chat-canvas-card-context > span:last-child) {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
:deep(.chat-note-card-date) {
  min-width: 0; margin-inline-start: auto; color: var(--content-secondary);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-size: var(--font-size-xs); font-variant-numeric: tabular-nums;
}
:deep(a.chat-object-card :is(.chat-object-card-icon, .chat-object-card-arrow)) { display: none; }
:deep(a.chat-object-card .chat-canvas-card-context > .chat-object-card-icon) {
  display: flex; flex: none; color: var(--action-primary);
}
:deep(.chat-canvas-card-context svg) {
  display: block; inline-size: 14px; block-size: 14px; fill: currentColor;
}
:deep(a.chat-object-card .chat-object-card-kind) {
  padding: 2px 8px; border-radius: var(--radius-xs); background: var(--action-soft);
  color: var(--content-primary); font-weight: 600; white-space: nowrap;
}
:deep(.chat-object-file-identity) { display: flex; align-items: center; gap: 10px; min-width: 0; }
:deep(.chat-object-file-icon) {
  display: grid; place-items: center; flex: 0 0 38px; block-size: 38px;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--chat-file-icon-color) 16%, transparent); color: var(--chat-file-icon-color);
}
:deep(.chat-object-file-identity .chat-object-card-title) { min-width: 0; }
:deep(.chat-object-card-loading) {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center; gap: var(--space-xs);
  border-radius: inherit; pointer-events: none;
  background: color-mix(in srgb, var(--surface-card-solid) 88%, transparent);
  color: var(--content-primary); font-size: var(--font-size-sm); font-weight: 500;
  visibility: hidden;
  animation: chat-object-card-loading 160ms ease 180ms forwards;
}
:deep(.chat-object-card-loading.is-streaming) {
  visibility: visible; animation: none;
}
:deep(.chat-object-card-loading::before) {
  content: ''; inline-size: 12px; block-size: 12px; flex: none;
  box-sizing: border-box; border-radius: 50%;
  border: 2px solid var(--action-outline); border-inline-end-color: var(--content-primary);
  animation: chat-object-card-spin 800ms linear infinite;
}
:deep(.chat-object-image-preview:is(.is-loaded, .is-failed) ~ .chat-object-card-loading.is-image-only) {
  display: none;
}
@keyframes chat-object-card-loading {
  from { opacity: 0; }
  to { visibility: visible; opacity: 1; }
}
@keyframes chat-object-card-spin {
  to { transform: rotate(1turn); }
}
@media (prefers-reduced-motion: reduce) {
  :deep(.chat-object-card-loading) { animation-timing-function: step-end; animation-duration: 1ms; }
  :deep(.chat-object-card-loading::before) { animation: none; }
}
:deep(.chat-object-card > img.chat-object-image-preview:not(.is-loaded)) {
  position: absolute; inline-size: 1px; block-size: 1px; opacity: 0; pointer-events: none;
}
:deep(.msg-bubble.md-body a.chat-object-card[data-object-type="file"]:has(> .chat-object-image-preview.is-loaded)) {
  padding: 0; gap: 0; overflow: hidden;
}
:deep(.md-view .chat-object-card > img.chat-object-image-preview.is-loaded) {
  inline-size: 100%; block-size: auto; max-block-size: min(280px, 36dvh);
  margin: 0; object-fit: contain; border-radius: 0; background: var(--surface-soft);
  border-block-end: 1px solid var(--content-divider);
}
:deep(.md-view .chat-object-cards.is-multiple .chat-object-image-preview.is-loaded) {
  aspect-ratio: 4 / 3;
}
:deep(.md-view .chat-object-cards .chat-object-image-preview.is-loaded.is-portrait) {
  aspect-ratio: auto; max-block-size: min(460px, 65dvh);
}
:deep(.chat-object-card:has(> .chat-object-image-preview.is-loaded) .chat-object-file-icon) { display: none; }
:deep(.chat-object-image-preview.is-loaded + .chat-object-file-identity) {
  padding: 10px 14px;
}
:deep(.chat-object-image-preview.is-loaded ~ .chat-object-card-details) {
  padding: 0 14px 10px;
}
:deep(.chat-object-card:has(> .chat-object-image-preview.is-loaded) .chat-object-file-identity .chat-object-card-title) {
  font-size: var(--font-size-md);
}
:deep(.chat-project-status) {
  margin-inline-start: auto; padding: 1px 7px; border-radius: var(--radius-pill);
  background: var(--surface-soft); color: var(--content-secondary);
  font-size: var(--font-size-xs); white-space: nowrap;
}

:deep(.chat-object-card-details) {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 124px), 1fr));
  gap: var(--space-xs); min-width: 0;
}
:deep(.chat-object-card-fact) {
  display: grid; gap: 2px; min-width: 0; padding: 6px 9px;
  border-radius: var(--radius-xs); background: var(--surface-soft); overflow-wrap: anywhere;
}
:deep(.chat-object-card-fact-label) { color: var(--content-secondary); font-size: var(--font-size-xs); }
:deep(.chat-object-card-fact-value) { color: var(--content-primary); font-size: var(--font-size-sm); font-weight: 500; }
:deep(.chat-object-card-fact.is-urgent .chat-object-card-fact-value) { color: var(--status-warning); }
:deep(.chat-object-card-fact.is-overdue .chat-object-card-fact-value) { color: var(--status-danger); }
:deep(.chat-project-progress) {
  display: grid; gap: var(--space-xs); margin-top: auto; padding-top: var(--space-xs);
}
:deep(.chat-project-progress-heading) { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-xs); }
:deep(.chat-project-meter) {
  appearance: none; display: block; inline-size: 100%; min-inline-size: 0; block-size: 6px; overflow: hidden;
  border: 0; border-radius: var(--radius-pill); background: var(--surface-soft-hover); color: var(--action-primary);
}
:deep(.chat-project-meter::-webkit-progress-bar) { background: var(--surface-soft-hover); }
:deep(.chat-project-meter::-webkit-progress-value) { border-radius: var(--radius-pill); background: var(--chat-project-fill, var(--action-primary)); }
:deep(.chat-project-meter::-moz-progress-bar) { border-radius: var(--radius-pill); background: var(--chat-project-fill, var(--action-primary)); }
:deep(.chat-project-percent) { color: var(--content-primary); font-size: var(--font-size-lg); font-weight: 600; font-variant-numeric: tabular-nums; }
:deep(.chat-project-status.is-pending) { color: var(--status-warning); background: var(--status-warning-bg); }
:deep(.chat-project-status.is-active) { color: var(--status-info); background: var(--status-info-bg); }
:deep(.chat-project-status.is-done) { color: var(--status-success); background: var(--status-success-bg); }
:deep(.msg-bubble.md-body a[href^="gugu://open-object/"]:not(.chat-object-card, .chat-smart-row, .chat-smart-button, .chat-file-card-download)),
:deep(.msg-bubble.md-body a[href^="gugu://focus-canvas/"]:not(.chat-object-card, .chat-smart-row, .chat-smart-button, .chat-file-card-download)),
:deep(.msg-bubble.md-body a[href^="gugu://open-skill/"]:not(.chat-object-card, .chat-smart-row, .chat-smart-button, .chat-file-card-download)) {
  margin-block: 0; padding: 0 0.55em; font-size: 0.9em; line-height: 1.5; vertical-align: baseline;
}
:deep(.msg-bubble.md-body a[href^="gugu://"]:not(.chat-object-card, .chat-smart-row, .chat-smart-button, .chat-file-card-download):hover) {
  background: var(--gugu-chat-send-bg); border-color: var(--action-primary-hover);
  box-shadow: none; opacity: 1;
}
:deep(.msg-bubble.md-body a[href^="gugu://"]:not(.chat-object-card, .chat-smart-row, .chat-smart-button, .chat-file-card-download):active) { transform: translateY(1px); opacity: 0.93; }

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
:deep(.msg-bubble.md-body .md-view),
:deep(.msg-bubble.md-body .md-view p),
:deep(.msg-bubble.md-body .md-view li) {
  line-height: 1.65;
}
:deep(.msg-bubble.md-body .md-view li + li),
:deep(.msg-bubble.md-body .md-view li > p + p) {
  margin-block-start: var(--space-sm);
}
:deep(.msg-bubble.md-body .md-view :is(h1, h2, h3, h4, h5, h6)) {
  margin-bottom: 7px;
}
:deep(.msg-bubble.md-body .md-table-scroll) { width: 100%; box-sizing: border-box; }
:deep(.msg-bubble.md-body .md-table-scroll th),
:deep(.msg-bubble.md-body .md-table-scroll td) {
  padding-block: 6px;
  white-space: nowrap; word-break: normal; overflow-wrap: normal;
}
:deep(.msg:is(.ai, .member) .msg-bubble) {
  box-sizing: border-box; inline-size: fit-content;
  max-inline-size: var(--chat-assistant-bubble-max-width); min-inline-size: 0;
}
:deep(.msg:is(.ai, .member) .msg-bubble:has(:is(table, pre, img, .chat-object-cards, .chat-smart-view, .chat-smart-stream, .md-mermaid))) {
  inline-size: var(--chat-assistant-bubble-max-width);
}
:deep(.msg:is(.ai, .member) .msg-bubble),
:deep(.md-view .chat-smart-view) {
  background: var(--gugu-chat-assistant-bg); border: 1px solid var(--gugu-chat-assistant-border);
  box-shadow: inset 0 1px 0 var(--gugu-chat-assistant-highlight);
}
:deep(.msg:is(.ai, .member) .msg-bubble) { border-bottom-left-radius: 4px; }
:deep(.chat-assistant-content) {
  display: flex; flex-direction: column; align-items: flex-start;
  width: 100%; min-width: 0;
}
:deep(.chat-assistant-block + .chat-assistant-block) { margin-block-start: 8px; }
/* 智能界面按自己的可用宽度排列字段，紧凑窗不依赖页面断点。 */
:deep(.md-view .chat-smart-view) {
  --progress-track-height: 6px;
  --progress-thumb-size: 14px;
  container-type: inline-size;
  margin-block: 8px;
  padding: 14px;
  border-radius: var(--card-radius);
  color: var(--content-primary);
}
:deep(.chat-smart-heading),
:deep(.chat-smart-metrics) { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
:deep(.chat-smart-heading) { justify-content: space-between; }
:deep(.chat-smart-heading > strong) { font-size: var(--font-size-lg); }
:deep(.chat-smart-heading > span),
:deep(.chat-smart-summary),
:deep(.chat-smart-view-notice) { font-size: var(--font-size-sm); color: var(--content-secondary); overflow-wrap: anywhere; }
:deep(.chat-smart-summary) { margin-top: 4px; }
:deep(.chat-smart-metrics) {
  margin-top: 10px; padding: 6px 9px; border-radius: var(--radius-xs); background: var(--action-soft);
  font-size: var(--font-size-sm);
}
:deep(.chat-smart-metrics > span) { color: var(--status-danger); }
:deep(.md-view ul.chat-smart-rows) { list-style: none; margin: 8px 0 0; padding: 0; }
:deep(.chat-smart-rows > li) { margin: 0; border-bottom: 1px solid var(--content-divider); }
:deep(.chat-smart-rows > li:last-child) { border-bottom: 0; }
:deep(.md-view a.chat-smart-row) {
  display: grid; gap: 3px 12px; padding: 7px 8px; border-radius: var(--radius-xs);
  color: var(--content-primary); text-decoration: none; overflow-wrap: anywhere;
  transition: background-color var(--motion-hover-control);
}
:deep(.md-view a.chat-smart-row:hover) { background: var(--surface-soft); }
:deep(.md-view a.chat-smart-row:focus-visible) { outline: 2px solid var(--border-focus); outline-offset: -2px; }
:deep(.chat-smart-fields) { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
:deep(.chat-smart-detail),
:deep(.chat-smart-when),
:deep(.chat-smart-progress) { color: var(--content-secondary); font-size: var(--font-size-xs); }
:deep(.chat-smart-when) { font-variant-numeric: tabular-nums; white-space: nowrap; }
:deep(.chat-smart-progress) { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
:deep(.chat-smart-progress progress) { inline-size: 42px; }
:deep(.chat-smart-status) {
  padding-inline: 6px; border-radius: var(--radius-pill); background: var(--surface-soft);
  color: var(--content-secondary); font-size: var(--font-size-xs);
}
:deep(.chat-smart-status.is-overdue) { color: var(--status-danger); }
:deep(.chat-smart-status.is-today) { color: var(--status-warning); }
:deep(.chat-smart-status.is-completed) { color: var(--status-success); }
:deep(.chat-smart-view > .chat-smart-view-notice) { padding-block: 10px 2px; }
:deep(.chat-smart-layout) { display: grid; gap: 10px; min-width: 0; }
:deep(.chat-smart-layout:has(> .chat-smart-button):not(:has(> :not(.chat-smart-button)))) {
  --smart-button-basis: min(100%, max(140px, (100% - 24px) / 4));
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
:deep(.chat-smart-section) { display: grid; align-content: start; gap: 7px; padding-block-start: 8px; border-top: 1px solid var(--content-divider); }
:deep(.chat-smart-section > .chat-smart-layout) { gap: 6px; }
:deep(.chat-smart-section > .chat-smart-layout > .chat-smart-timeline) { border-block-start: 0; padding-block-start: 0; }
:deep(.md-view .chat-smart-section > h4) { margin: 0; font-size: var(--font-size-sm); }
:deep(.md-view .chat-smart-layout-view .chat-smart-row) {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px;
  padding: 7px 8px; overflow-wrap: anywhere;
}
:deep(.chat-smart-list-detail) { color: var(--content-secondary); font-size: var(--font-size-xs); }
:deep(.chat-smart-rows > li > .chat-smart-row > .chat-smart-list-detail) {
  font-size: var(--font-size-sm);
  line-height: 1.55;
}
:deep(.chat-smart-label),
:deep(.chat-smart-text),
:deep(.chat-smart-section h4) { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
:deep(.chat-smart-icon) { flex: 0 0 15px; display: inline-flex; align-self: center; color: var(--action-primary); }
:deep(.chat-smart-text > .chat-smart-icon),
:deep(.chat-smart-section h4 > .chat-smart-icon) {
  align-self: flex-start; align-items: center; block-size: 1lh;
}
:deep(.chat-smart-layout > *) { min-width: 0; }
:deep(.chat-smart-text) { white-space: pre-wrap; overflow-wrap: anywhere; }
:deep(.chat-smart-text.is-title) { font-size: var(--font-size-lg); font-weight: 700; }
:deep(.chat-smart-text.is-hint) { color: var(--content-secondary); font-size: var(--font-size-sm); }
:deep(.chat-smart-metric),
:deep(.chat-smart-progress-block),
:deep(.chat-smart-slider) {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 6px 10px; padding: 8px 10px;
  border-radius: var(--radius-xs); background: var(--surface-soft);
  font-size: var(--font-size-sm); overflow-wrap: anywhere;
}
:deep(.chat-smart-metric > strong) { font-size: var(--font-size-lg); }
:deep(.chat-smart-layout-view [data-smart-color="accent"]) { --smart-view-color: var(--action-primary); }
:deep(.chat-smart-layout-view [data-smart-color="info"]) { --smart-view-color: var(--status-info); }
:deep(.chat-smart-layout-view [data-smart-color="success"]) { --smart-view-color: var(--status-success); }
:deep(.chat-smart-layout-view [data-smart-color="warning"]) { --smart-view-color: var(--status-warning); }
:deep(.chat-smart-layout-view [data-smart-color="danger"]) { --smart-view-color: var(--status-danger); }
:deep(.chat-smart-text[data-smart-color]),
:deep(.chat-smart-text[data-smart-color] > .chat-smart-icon),
:deep(.chat-smart-metric[data-smart-color] > strong) {
  color: var(--smart-view-color);
}
:deep(.chat-smart-layout-view [data-smart-color] > :is(progress, .progress-range)) {
  --progress-fill-bg: var(--smart-view-color);
  --progress-track-bg: color-mix(in srgb, var(--progress-fill-bg) 18%, transparent);
}
html[data-theme='light'] .chat-window :deep(.chat-smart-layout-view :is(progress, .progress-range)) {
  --progress-fill-bg: color-mix(in srgb, var(--smart-view-color, var(--action-primary)) 70%, var(--content-on-accent));
  --progress-track-bg: color-mix(in srgb, var(--progress-fill-bg) 20%, transparent);
}
:deep(.chat-smart-progress-block progress),
:deep(.chat-smart-slider input) {
  grid-column: 1 / -1; inline-size: 100%; min-width: 0;
  margin: 0;
}
:deep(.md-view .chat-smart-button) {
  justify-self: stretch; flex: 1 0 var(--smart-button-basis, auto);
  display: flex; align-items: center; gap: 6px; text-align: start;
  padding: 6px 10px; border: 1px solid var(--action-outline);
  box-sizing: border-box; max-inline-size: 100%; font: inherit; font-size: var(--font-size-sm);
  border-radius: var(--radius-xs); color: var(--content-primary); background-color: var(--action-soft);
  text-decoration: none; overflow-wrap: anywhere; cursor: pointer;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard);
}
:deep(.md-view .chat-smart-button:hover) { background-color: var(--surface-soft-hover); }
:deep(.md-view .chat-smart-button:focus-visible) { outline: 2px solid var(--border-focus); }
:deep(.md-view .chat-smart-button[data-smart-button-variant="icon"]) {
  justify-self: start; flex: 0 0 34px; justify-content: center;
  inline-size: 34px; block-size: 34px; padding: 0;
}
:deep(.md-view .chat-smart-button[data-smart-button-variant="tile"]) {
  min-block-size: 70px; flex-direction: column; align-items: flex-start; justify-content: center;
}
:deep(.md-view .chat-smart-button .chat-smart-icon) { align-self: auto; }
:deep(.md-view .chat-smart-button[data-smart-button-variant="tile"] .chat-smart-icon) { flex: none; }
:deep(.chat-smart-layout-view [hidden]) { display: none; }
:deep(.chat-smart-split) { min-width: 0; container: chat-smart-split / inline-size; }
:deep(.chat-smart-split-track) { display: grid; gap: 10px; }
:deep(.chat-smart-split-track > div) { min-width: 0; }
@container chat-smart-split (min-width: 450px) {
  :deep(.chat-smart-split-track:not(:has(> div[hidden]))) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  :deep(.chat-smart-split-track[data-smart-ratio="60:40"]:not(:has(> div[hidden]))) { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
  :deep(.chat-smart-split-track[data-smart-ratio="40:60"]:not(:has(> div[hidden]))) { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
}
@container chat-smart-split (min-width: 220px) {
  :deep(.chat-smart-split-track[data-smart-width="rail"][data-smart-fixed="primary"]:not(:has(> div[hidden]))) { grid-template-columns: 48px minmax(0, 1fr); }
  :deep(.chat-smart-split-track[data-smart-width="rail"][data-smart-fixed="secondary"]:not(:has(> div[hidden]))) { grid-template-columns: minmax(0, 1fr) 48px; }
}
@container chat-smart-split (min-width: 420px) {
  :deep(.chat-smart-split-track[data-smart-width="compact"][data-smart-fixed="primary"]:not(:has(> div[hidden]))) { grid-template-columns: 160px minmax(0, 1fr); }
  :deep(.chat-smart-split-track[data-smart-width="compact"][data-smart-fixed="secondary"]:not(:has(> div[hidden]))) { grid-template-columns: minmax(0, 1fr) 160px; }
}
:deep(.chat-smart-panel) {
  display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0;
  overflow: hidden; border: 1px solid var(--content-divider); border-radius: var(--radius-sm);
  background: var(--surface-soft);
}
:deep(.chat-smart-panel[data-smart-height="compact"]) { block-size: 300px; }
:deep(.chat-smart-panel[data-smart-height="regular"]) { block-size: 400px; }
:deep(.chat-smart-panel[data-smart-height="tall"]) { block-size: 500px; }
:deep(.chat-smart-panel > :is(header, footer, .chat-smart-panel-body)) { min-width: 0; padding: 10px; }
:deep(.chat-smart-panel > header) { border-block-end: 1px solid var(--content-divider); }
:deep(.chat-smart-panel > header > h4) {
  display: flex; align-items: center; gap: 6px; margin: 0;
  font-size: var(--font-size-sm); overflow-wrap: anywhere;
}
:deep(.chat-smart-panel > header > h4 + .chat-smart-layout) { margin-block-start: 8px; }
:deep(.chat-smart-panel > .chat-smart-panel-body) { grid-row: 2; }
:deep(.chat-smart-panel > footer) { grid-row: 3; border-block-start: 1px solid var(--content-divider); }
:deep(.chat-smart-panel[data-smart-height]:not([data-smart-height="auto"]) > .chat-smart-panel-body) {
  overflow: auto; overscroll-behavior-y: contain;
}
:deep(.chat-smart-panel-body:focus-visible) { outline: 2px solid var(--border-focus); outline-offset: -2px; }
:deep(.chat-smart-toolbar) { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
:deep(.chat-smart-toolbar[data-smart-orientation="vertical"]) { flex-direction: column; align-items: flex-start; }
:deep(.chat-smart-toolbar > .chat-smart-button:not([data-smart-button-variant="icon"])) { flex: 0 1 auto; }
:deep(.chat-smart-timeline ol),
:deep(.chat-smart-ranking ol) { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
:deep(.chat-smart-timeline ol) { --timeline-gap: 12px; gap: var(--timeline-gap); }
:deep(.md-view .chat-smart-timeline li) {
  position: relative; display: grid; gap: 3px; margin: 0; padding: 0 0 4px 23px;
  overflow-wrap: anywhere;
}
:deep(.chat-smart-timeline li:not(:last-child)::after) {
  content: ''; position: absolute;
  inset-block: 9px calc(-9px - var(--timeline-gap)); inset-inline-start: 8px;
  inline-size: 2px; background: var(--content-divider);
}
:deep(.chat-smart-timeline li[data-smart-time-state="done"]:not(:last-child)::after) {
  background: color-mix(in srgb, var(--status-success) 55%, var(--content-divider));
}
:deep(.chat-smart-timeline li::before) {
  content: ''; position: absolute; z-index: 1; inset-block-start: 5px; inset-inline-start: 5px;
  inline-size: 8px; block-size: 8px; border-radius: 50%; background: var(--content-tertiary);
}
:deep(.chat-smart-timeline li[data-smart-time-state="done"]::before) { background: var(--status-success); }
:deep(.chat-smart-timeline li[data-smart-time-state="current"]::before) {
  background: var(--action-primary);
  box-shadow: 0 0 0 3px var(--action-soft);
}
:deep(.chat-smart-ranking li) {
  display: grid; gap: 5px; padding: 8px 10px; border-radius: var(--radius-xs); background: var(--surface-soft);
}
:deep(.chat-smart-ranking-label),
:deep(.chat-smart-wizard-heading) { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
:deep(.chat-smart-ranking progress),
:deep(.chat-smart-wizard > progress) { inline-size: 100%; }
:deep(.chat-smart-wizard-panel) { display: grid; min-width: 0; gap: 8px; }
:deep(.chat-smart-wizard-heading > .chat-smart-list-detail) { white-space: nowrap; }
:deep(.chat-smart-wizard-actions) { display: flex; justify-content: space-between; gap: 8px; }
:deep(.chat-smart-wizard-actions:empty) { display: none; }
:deep(.chat-smart-wizard-actions button[data-smart-step="next"]) { margin-inline-start: auto; }
:deep(.chat-smart-wizard > [role="alert"]) { color: var(--status-danger); font-size: var(--font-size-sm); }
:deep(.chat-smart-local-button) {
  width: fit-content; padding: 5px 10px; border: 1px solid var(--action-outline); border-radius: var(--radius-xs);
  background: var(--action-soft); color: var(--content-primary); font: inherit; font-size: var(--font-size-sm);
  cursor: pointer; transition: background-color var(--motion-hover-control);
}
:deep(.chat-smart-local-button:hover) { background-color: var(--surface-soft-hover); }
:deep(.chat-smart-local-button:focus-visible) { outline: 2px solid var(--border-focus); }
:deep(.chat-smart-chart) {
  min-width: 0; margin: 0; padding: 12px;
  border: 1px solid var(--content-divider);
  border-radius: var(--radius-sm); background: var(--surface-soft);
  font-size: var(--font-size-sm);
}
:deep(.chat-smart-section > .chat-smart-layout > .chat-smart-chart) { margin-block-start: -2px; }
:deep(.chat-smart-chart figcaption) { color: var(--content-primary); font-weight: 600; }
:deep(.chat-smart-chart-canvas) { position: relative; block-size: 198px; margin-block: 10px 8px; }
:deep(.chat-smart-chart-canvas canvas) { color: var(--smart-view-color, var(--action-primary)); }
:deep(.chat-smart-pie-legend:not([hidden])) {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px;
  list-style: none; margin: 0; padding: 10px 0;
  border-block-start: 1px solid var(--content-divider);
}
:deep(.chat-smart-pie-legend li) {
  display: grid; grid-template-columns: 8px minmax(0, 1fr); gap: 2px 6px;
  align-items: center; border-radius: var(--radius-xs); padding: 3px;
  color: var(--content-secondary); overflow-wrap: anywhere;
}
:deep(.chat-smart-pie-legend li:hover) { background: var(--surface-soft-hover); }
:deep(.chat-smart-pie-legend li > span:first-child) {
  width: 8px; height: 8px; border-radius: 50%; grid-row: span 2;
}
:deep(.chat-smart-pie-legend strong) {
  grid-column: 2; color: var(--content-primary); font-size: var(--font-size-md);
  font-variant-numeric: tabular-nums;
}
:deep(.chat-smart-chart details) { border-block-start: 1px solid var(--content-divider); padding-block-start: 7px; }
:deep(.chat-smart-chart summary) {
  display: flex; align-items: center; gap: var(--space-1); list-style: none;
  width: fit-content; max-width: 100%; padding: 3px 6px; border-radius: var(--radius-xs);
  cursor: pointer; color: var(--content-secondary); font-size: var(--font-size-xs);
  transition: background-color var(--motion-hover-control), color var(--motion-hover-control);
}
:deep(.chat-smart-chart summary::-webkit-details-marker) { display: none; }
:deep(.chat-smart-chart summary > [data-smart-chart-chevron]) { display: inline-flex; flex-shrink: 0; }
:deep(.chat-smart-chart summary:hover) { background: var(--sidebar-item-hover); color: var(--content-primary); }
:deep(.chat-smart-chart summary:focus-visible) { outline: 2px solid var(--border-focus); }
:deep(.chat-smart-chart details ul) { list-style: none; padding: 0; margin-block: 4px 0; }
:deep(.chat-smart-chart details li) {
  display: flex; justify-content: space-between; gap: 8px;
  padding-block: 3px; border-bottom: 1px solid var(--content-divider); overflow-wrap: anywhere;
}
:deep(.chat-smart-input),
:deep(.chat-smart-checklist) {
  display: grid; gap: 6px; min-inline-size: 0; margin: 0; padding: 8px 10px;
  border: 0; border-radius: var(--radius-xs); background: var(--surface-soft);
  font-size: var(--font-size-sm);
}
:deep(.chat-smart-input input) {
  padding-inline: 8px;
}
:deep(.chat-smart-checklist-item) {
  display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; cursor: pointer;
}
:deep(.chat-smart-checklist-item input) { flex: none; margin-block-start: 3px; accent-color: var(--action-primary); }
:deep(.chat-smart-checklist-item > span) { min-width: 0; overflow-wrap: anywhere; }
:deep(.chat-smart-checklist-item .chat-smart-list-detail) { display: block; }
:deep(.chat-smart-metric > strong) { min-width: 0; overflow-wrap: anywhere; }
:deep(.chat-smart-switch) { display: grid; gap: 10px; min-width: 0; }
:deep(.chat-smart-switch > [data-smart-panel] > .chat-smart-layout:not(:has(> :not(.chat-smart-text.is-body))) > .chat-smart-text.is-body) {
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  background: var(--surface-soft);
  font-size: var(--font-size-sm);
  line-height: 1.55;
}
:deep(.chat-smart-switch-options) {
  display: flex; flex-wrap: wrap; gap: 4px; padding: 4px;
  border-radius: var(--radius-sm); background: var(--segmented-track-bg);
}
:deep(.chat-smart-switch-options > button) {
  flex: 1 1 auto; min-width: 0; max-width: 100%; padding: 5px 10px; border: 0; border-radius: var(--radius-xs);
  background: transparent; color: var(--content-secondary); font: inherit;
  font-size: var(--font-size-sm); overflow-wrap: anywhere; cursor: pointer;
  transition: background-color var(--motion-hover-control), color var(--motion-hover-control);
}
:deep(.chat-smart-switch-options > button[aria-pressed="false"]:hover) {
  background-color: var(--sidebar-item-hover); color: var(--content-primary);
}
:deep(.chat-smart-switch-options > button[aria-pressed="true"]) {
  background: var(--segmented-pill-bg); color: var(--content-primary); font-weight: 600;
}
:deep(.chat-smart-switch-options > button:focus-visible) { outline: 2px solid var(--border-focus); }
:deep(.chat-smart-layout[data-columns]:not([data-columns="1"]) > .chat-smart-metric) {
  grid-template-columns: minmax(0, 1fr); align-content: start; gap: 3px;
}
@container (min-width: 250px) {
  :deep(.chat-smart-layout:is([data-columns="2"], [data-columns="3"])) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (min-width: 320px) {
  :deep(.chat-smart-layout[data-columns="3"]) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
:deep(.chat-smart-layout[data-columns="4"]) {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, max(140px, (100% - 30px) / 4)), 1fr));
}
:deep(.chat-smart-layout[data-columns="2"]:has(> .chat-smart-section)) {
  --smart-section-column-floor: calc((100% - 10px) / 2);
}
:deep(.chat-smart-layout[data-columns="3"]:has(> .chat-smart-section)) {
  --smart-section-column-floor: calc((100% - 20px) / 3);
}
:deep(.chat-smart-layout[data-columns="4"]:has(> .chat-smart-section)) {
  --smart-section-column-floor: calc((100% - 30px) / 4);
}
:deep(.chat-smart-layout:is([data-columns="2"], [data-columns="3"], [data-columns="4"]):has(> .chat-smart-section)) {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, max(240px, var(--smart-section-column-floor))), 1fr));
  align-items: start;
}
@container (min-width: 420px) {
  :deep(.md-view a.chat-smart-row) { grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr); align-items: center; }
  :deep(.chat-smart-fields) { justify-content: flex-end; }
}

:deep(.chat-assistant-block .md-view > .chat-smart-view) {
  margin-block: 0; padding: 0; border: 0; background: none; box-shadow: none;
}
:deep(.chat-smart-stream) {
  container: chat-smart-stream / inline-size;
  box-sizing: border-box;
}
:deep(.chat-smart-stream-grid) { display: grid; gap: 10px; }
:deep(.chat-smart-stream-region) {
  min-width: 0; min-block-size: 144px; padding: 10px;
  border: 1px solid var(--content-divider); border-radius: var(--radius-xs);
  background: var(--surface-soft);
}
:deep(.chat-smart-stream-region[data-region="footer"]) { min-block-size: 48px; grid-column: 1 / -1; }
:deep(.chat-smart-stream-region:is([data-status="invalid"], [data-status="unavailable"])) { min-block-size: 0; }
:deep(.chat-smart-stream-region[data-status="invalid"] .chat-smart-view-notice) { color: var(--status-warning); }
:deep(.chat-smart-stream-region[data-region="footer"][data-status="ready"]) {
  min-block-size: 0; padding: 10px 0 0; border: 0; border-block-start: 1px solid var(--content-divider);
  border-radius: 0; background: transparent;
}
:deep(.chat-smart-stream-region[data-region="footer"] .chat-smart-toolbar > .chat-smart-button:not([data-smart-button-variant="icon"])) {
  flex: 1 0 min(100%, 120px); justify-content: center;
}
:deep(.chat-smart-stream-region .md-view > .chat-smart-view) {
  padding: 0; border: 0; background: none; box-shadow: none;
}
:deep(.chat-smart-stream-region [role="status"]) {
  display: flex; align-items: center; min-block-size: 26px;
  font-size: var(--font-size-sm); color: var(--content-secondary);
}
@container chat-smart-stream (min-width: 440px) {
  :deep(.chat-smart-stream-grid) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  :deep(.chat-smart-stream-grid[data-smart-ratio="60:40"]) { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
  :deep(.chat-smart-stream-grid[data-smart-ratio="40:60"]) { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
}
:deep(.chat-smart-view-generating > [role="status"]) {
  display: flex; align-items: center; gap: 8px;
  min-block-size: 28px; color: var(--content-secondary); font-size: var(--font-size-sm);
}
:deep(.chat-smart-view-generating > [role="status"]::before) {
  content: ''; flex: 0 0 12px; block-size: 12px; box-sizing: border-box;
  border: 2px solid var(--content-divider); border-block-start-color: var(--action-primary);
  border-radius: 50%; animation: chat-smart-view-loading 900ms linear infinite;
}
@keyframes chat-smart-view-loading { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) {
  :deep(.chat-smart-view-generating > [role="status"]::before) { animation: none; }
}
:deep(.msg.user .msg-bubble) {
  background: var(--gugu-chat-user-bg); color: var(--gugu-chat-user-fg);
  border-bottom-right-radius: 4px; box-shadow: var(--gugu-chat-user-shadow);
}
/* 用户气泡 MD 排版（.user-md）：md-view 默认把标题/加粗/引用映射到深色文字
   token，紫底上对比不足，重映射到气泡前景。行内代码叠半透明前景，代码块用
   近实心亮面板——hljs token 色是按浅底调的，透在紫底上会看不清。 */
:deep(.msg-bubble.user-md h1), :deep(.msg-bubble.user-md h2), :deep(.msg-bubble.user-md h3),
:deep(.msg-bubble.user-md h4), :deep(.msg-bubble.user-md h5), :deep(.msg-bubble.user-md h6),
:deep(.msg-bubble.user-md strong), :deep(.msg-bubble.user-md blockquote) { color: inherit; }
:deep(.msg-bubble.user-md a) { color: inherit; }
:deep(.msg-bubble.user-md code) {
  background: color-mix(in srgb, var(--gugu-chat-user-fg) 16%, transparent);
  color: inherit;
}
:deep(.msg-bubble.user-md pre) {
  background: color-mix(in srgb, var(--gugu-chat-user-fg) 92%, transparent);
}
/* 亮色下面板色必须提到整个代码块容器：只给 pre 的话，md-code-header 悬在
   强调底气泡上，10% 紫叠在 100% 紫上头部条完全隐形（用户实测反馈）。
   暗色由下方 :global 规则换成 assistant 表面契约。 */
:deep(.msg-bubble.user-md .md-code-block) {
  background: color-mix(in srgb, var(--gugu-chat-user-fg) 92%, transparent);
}
/* 行内 code 的半透明底只能给行内用：这条若误伤 pre code，暗色下每行代码
   都会拖一条「被选中」的浅色底条。 */
:deep(.msg-bubble.user-md pre code) { background: none; color: var(--text-primary); }
/* 暗色下用户气泡代码块借用咕咕（assistant）气泡的面板契约：block 底=assistant
   表面、边框=assistant 描边，header 交给 MarkdownView 的暗色白 5% 叠层，观感
   与 AI 气泡里的代码块一致。近黑硬面板被否（用户反馈太暗、与气泡割裂）。
   注意整个选择器必须 :global——html[data-theme] 前缀会让 scoped 属性落到
   html 上导致规则永不匹配。 */
:global(html[data-theme='dark'] div.msg-bubble.user-md pre) {
  background: transparent;
}
:global(html[data-theme='dark'] div.msg-bubble.user-md .md-code-block) {
  background: var(--gugu-chat-assistant-bg);
  border-color: var(--gugu-chat-assistant-border);
}
:deep(.msg-speaker) {
  font-size: 11px; color: var(--text-secondary); margin: 0 2px 3px;
  font-weight: 600;
}
:deep(.msg-speaker-subagent) {
  display: flex; align-items: center; gap: var(--space-1);
  margin-block-end: var(--space-1);
  font-size: var(--font-size-sm);
}
:deep(button.msg-speaker-subagent) {
  border: 0; background: transparent; padding: 0; cursor: pointer;
  border-radius: var(--radius-xs);
}
:deep(button.msg-speaker-subagent:hover) { color: var(--content-primary); }
:deep(button.msg-speaker-subagent:focus-visible) { outline: 2px solid var(--border-focus); }
:deep(.msg-speaker-bird) {
  flex: none; inline-size: 16px; block-size: 16px;
  background: currentColor;
  mask: url('/brand/bird-solid.svg') center / contain no-repeat;
}
:deep(.msg-speaker-subagent-duration) {
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
/* 引用/回复预览条：浅色小字，跟正文气泡区分开——只是提示"引用了什么"，不是正文。
   截到 8 行，超出部分靠 hover 的原生 title 提示看全文，避免长引用只剩一小段看不出内容。 */
:deep(.msg-quoted) {
  max-width: 88%; margin-bottom: 4px; padding: 6px 10px;
  font-size: 12.5px; line-height: 1.5; color: var(--text-secondary);
  background: var(--action-soft); border-left: 2.5px solid var(--action-outline);
  border-radius: 4px; white-space: pre-wrap; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical; overflow: hidden;
}
:deep(.msg-quoted-thumb) {
  display: block; width: 112px; height: 112px; margin-top: 5px; object-fit: cover;
  border-radius: 8px; cursor: pointer; border: 1px solid color-mix(in srgb, var(--action-primary) 18%, transparent);
}
/* 非图片引用文件 chip：surface 走 token（主题契约禁止本文件硬编码 background），
   描边与缩略图同族蓝灰。inline-block 自身做省略，长文件名截断不撑破引用条。 */
:deep(.msg-quoted-file) {
  display: inline-block; margin-top: 5px; margin-right: 6px; padding: 3px 8px;
  max-width: 100%; box-sizing: border-box;
  font-size: 12px; line-height: 1.5; color: var(--text-secondary);
  background: var(--gugu-chat-quoted-chip-bg); border: 1px solid color-mix(in srgb, var(--action-primary) 18%, transparent);
  border-radius: 6px; cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
:deep(.msg-quoted-file:hover) { background: var(--gugu-chat-quoted-chip-bg-hover); }
:deep(.msg-face-image-wrap) {
  max-width: 150px; margin-top: 5px; cursor: pointer; line-height: 0;
}
:deep(.msg-face-image) {
  display: block; width: 128px; height: 128px; max-width: 100%; object-fit: contain;
  border-radius: 12px;
}
/* 咕咕发来的文件卡片 */
:deep(.msg-files) { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; max-width: 88%; min-width: 0; }

/* send_link_buttons 复用 ask_user 的气泡与按钮契约：链接仍是普通导航，不产生交互回调。 */
:deep(.msg-link-buttons) {
  inline-size: var(--chat-assistant-bubble-max-width); max-inline-size: 100%; min-inline-size: 0;
  box-sizing: border-box; margin: 6px 0 0; padding: 14px;
  border: 1px solid var(--border-default); border-radius: var(--card-radius);
  background: var(--surface-card-solid); color: var(--content-primary);
  box-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card);
}
:deep(.msg-link-buttons:first-child) { margin-top: 0; }
:deep(.msg-link-buttons .interaction-body) {
  margin-top: 0; color: var(--content-secondary); font-size: var(--font-size-sm);
  line-height: var(--line-height-body); white-space: pre-wrap; overflow-wrap: anywhere;
}
:deep(.msg-link-buttons .interaction-actions) {
  display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; max-width: 100%;
  margin-top: 13px; padding-top: 11px; border-top: 1px solid var(--content-divider);
}
:deep(.msg-link-buttons .interaction-option) {
  flex: 0 1 auto; min-width: 0; max-width: 100%; height: auto; min-height: 34px;
  white-space: normal; word-break: normal; overflow-wrap: anywhere;
  line-height: var(--line-height-body);
}
:deep(.msg-link-buttons .interaction-option .app-action-button-content) {
  display: block; min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere;
}
/* 聊天附件沿用对象卡片样式，预先留出图片区域。 */
:deep(.msg-files:has(.chat-attachment-card)) { inline-size: min(320px, 88%); }
:deep(.chat-attachment-card) { inline-size: 100%; }
:deep(.chat-attachment-card > button.chat-object-card) {
  text-align: start; font: inherit;
}
:deep(.chat-attachment-card > button.chat-file-card-download) {
  box-sizing: border-box; cursor: pointer;
}
:deep(.chat-attachment-preview) {
  position: relative; display: grid; place-items: center; inline-size: 100%;
  aspect-ratio: 4 / 3; overflow: hidden; border-radius: var(--radius-sm);
  color: var(--content-tertiary); background: var(--surface-soft);
}
:deep(.chat-attachment-preview img.is-loaded[src]) {
  position: absolute; inset: 0; inline-size: 100%; block-size: 100%;
  object-fit: contain; background: var(--surface-soft);
}
:deep(.chat-attachment-preview img:not(.is-loaded)) { position: absolute; inset: 0; width: 100%; height: 100%; visibility: hidden; }
/* 语音条保留独立的迷你播放布局。 */
:deep(.msg-voice) {
  display: inline-flex; align-items: center; gap: 9px; padding: 8px 13px; cursor: pointer;
  max-width: 100%; box-sizing: border-box; user-select: none;
  background: var(--gugu-chat-voice-bg); border: 1px solid var(--gugu-chat-voice-border);
  border-radius: 14px; border-bottom-left-radius: 5px;
  box-shadow: inset 0 1px 0 var(--gugu-chat-voice-highlight), var(--elevation-card);
  transition: background 0.15s, border-color 0.15s;
}
:deep(.msg-voice:hover) { background: var(--surface-glass-hover); box-shadow: inset 0 1px 0 var(--highlight-strong), var(--elevation-card-hover); }
:deep(.msg-voice .mv-btn) {
  flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; color: var(--gugu-chat-user-fg);
  background: var(--gugu-chat-voice-button-bg); box-shadow: var(--elevation-card);
}
:deep(.msg-voice .mv-wave) { display: flex; align-items: center; gap: 2px; height: 18px; }
:deep(.msg-voice .mv-wave i) { width: 2.5px; border-radius: 2px; background: var(--gugu-chat-voice-wave); transition: height 320ms ease-out, background 0.2s; }
:deep(.msg-voice.playing .mv-wave i) { transition: height 70ms linear, background 0.2s; }
:deep(.msg-voice .mv-dur) { font-size: 12.5px; color: var(--gugu-chat-voice-duration); font-variant-numeric: tabular-nums; flex-shrink: 0; }
/* 用户(右侧)发的附件卡：气泡尾巴翻到右下、左下回正常圆角、容器右对齐 */
:deep(.msg.user .msg-files) { align-items: flex-end; }
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

/* ── Markdown ── */
/* md 排版由通用组件 MarkdownView 提供；这里只保留聊天气泡的内边距（渲染于
   GuguChatMessageRow.vue，同样需要 :deep()） */
:deep(.md-body) { padding: 10px 13px; }

/* .mini-player 与 .mp-开头的样式已随 GuguChatMiniPlayer.vue 迁移 */
</style>
