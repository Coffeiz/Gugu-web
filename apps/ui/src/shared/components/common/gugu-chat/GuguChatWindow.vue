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

    <!-- 拖入遮罩（覆盖整个窗口，大小窗通用）-->
    <Transition name="chat-drop-fade">
      <div v-if="isChatDragging && !dropFilesAsReferences" class="chat-drop-overlay">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 16V6M8 10l4-4 4 4"/><path d="M5 19h14"/>
        </svg>
        <span>{{ t('chat.dropAttachment') }}</span>
      </div>
    </Transition>

    <!-- 拖文件卡进来 = @ 引用的悬停遮罩（Runtime 投放，视觉与附件遮罩同语言）-->
    <Transition name="chat-drop-fade">
      <div v-if="refDropHover || (isChatDragging && dropFilesAsReferences)" class="chat-drop-overlay chat-ref-overlay">
        <svg width="30" height="30" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
          <path d="M216,68H133.39l-26-29.29a20,20,0,0,0-15-6.71H40A20,20,0,0,0,20,52V200.62A19.41,19.41,0,0,0,39.38,220H216.89A19.13,19.13,0,0,0,236,200.89V88A20,20,0,0,0,216,68ZM44,56H90.61l10.67,12H44ZM212,196H44V92H212Z" />
        </svg>
        <span>{{ t('chat.dropReference') }}</span>
      </div>
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
        <span v-if="!previewOnly" class="popup-status" :class="'is-' + presenceKind"
              @click="presenceKind === 'offline' && onPromptConnect()"
              :title="presenceTitle">
          <span class="status-dot" aria-hidden="true" /><span class="popup-status-label">{{ presenceText }}</span>
        </span>
        <div class="btn-group">
          <button v-if="canInterruptDetachedRun" type="button" class="popup-icon-btn"
            :disabled="interruptPending" :title="t('chatUi.interruptRun')" :aria-label="t('chatUi.interruptRun')"
            @click="onInterruptDetachedRun">
            <Icon name="action.stop-fill" :size="14" />
          </button>
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
  canInterruptDetachedRun?: boolean
  interruptPending?: boolean
  onInterruptDetachedRun?: () => void
  onCopy: (msg: ChatMessage) => void
  onToggleVoice: (file: ChatFile) => void
  onOpenFile: (file: ChatFile) => void
  onDownload: (file: ChatFile) => void
  onActionClick: (e: MouseEvent) => void
  onInteractionSelect: (msg: ChatMessage, option: { id: string; label: string; token: string }) => void
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
.chat-window.is-layout-resizing {
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
.chat-drop-overlay {
  position: absolute; inset: 0; z-index: 120;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  pointer-events: none;   /* 让拖拽事件穿透到 .chat-window，drop/dragleave 才能正常触发 */
  background: color-mix(in srgb, var(--action-primary) 16%, transparent);
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  border: 2px dashed color-mix(in srgb, var(--action-primary) 60%, transparent); border-radius: var(--card-radius);
  color: var(--color-primary); font-size: 14px; font-weight: 600;
}
.chat-drop-fade-enter-active, .chat-drop-fade-leave-active { transition: opacity 0.15s ease; }
.chat-drop-fade-enter-from, .chat-drop-fade-leave-to { opacity: 0; }

/* ── 单一布局 ── */
.chat-window { display: flex; }
.chat-main { --chat-assistant-bubble-max-width: 88%; flex: 1; min-width: 0; display: flex; flex-direction: column; }

.chat-header {
  min-height: var(--gugu-chat-header-height);
  box-sizing: border-box;
  display: flex; align-items: center; gap: 9px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--gugu-chat-header-border, rgba(255,255,255,0.5));
  flex-shrink: 0;
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
  color: var(--content-tertiary);
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
.popup-status { margin-left: auto; }
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
:deep(.chat-messages.is-session-settling) { visibility: hidden; }
.chat-main.is-expanded { --chat-assistant-bubble-max-width: 90%; }
.chat-main.is-expanded :deep(.chat-messages .msg.ai .msg-bubble) { font-size: 14px; }
.chat-main.is-expanded :deep(.chat-messages .msg-quoted) { max-width: 72%; font-size: 13.5px; }
:deep(.msg-virtual-spacer) { position: relative; width: 100%; }
:deep(.msg-virtual-row) { position: absolute; top: 0; left: 0; width: 100%; box-sizing: border-box; padding: 0 13px var(--space-xs); }
.chat-main.is-expanded :deep(.msg-virtual-row) { padding: 0 24px var(--space-sm); }
:deep(.msg-virtual-row.is-tool-row), .chat-main.is-expanded :deep(.msg-virtual-row.is-tool-row),
:deep(.msg-virtual-row.is-interaction-row), .chat-main.is-expanded :deep(.msg-virtual-row.is-interaction-row) { padding-bottom: var(--space-xs); }
:deep(.chat-messages > .msg) { margin: 8px 13px 12px; }
.chat-main.is-expanded :deep(.chat-messages > .msg) { margin: 12px 24px 20px; }

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
    transform var(--motion-hover-control) var(--motion-ease-standard),
    opacity var(--motion-hover-control) var(--motion-ease-standard);
  user-select: none;
}
:deep(.msg-bubble.md-body a[href^="gugu://"]:not(.chat-object-card) strong) {
  color: inherit;
}
/* 咕咕回复的 `---` 分隔线：实色次级文字色，全主题可辨，与预览窗 .tv-md hr 同口径 */
:deep(.msg-bubble.md-body hr) {
  border: none;
  border-top: 1px solid color-mix(in srgb, var(--content-primary) 20%, transparent);
  margin: 1.25em 0;
}
:deep(.msg-bubble.md-body a.chat-object-card) {
  display: inline-flex; align-items: center; vertical-align: middle; gap: 9px;
  min-width: 210px; max-width: min(340px, 100%); margin: 5px 6px 5px 0; padding: 9px 11px;
  color: var(--content-primary); background: var(--surface-card-solid);
  border: 1px solid var(--border-default); border-radius: var(--card-radius);
  box-shadow: var(--card-shadow); text-decoration: none; cursor: pointer;
  transition: var(--card-motion), box-shadow var(--motion-hover-card) var(--motion-ease-standard);
}
:deep(.msg-bubble.md-body a.chat-object-card:hover) {
  color: var(--content-primary); opacity: 1;
  background-color: var(--card-surface-bg-hover); border-color: var(--card-surface-border-hover);
  box-shadow: var(--card-shadow-hover); transform: translateY(-1px);
}
:deep(.msg-bubble.md-body a.chat-object-card:active) { transform: translateY(1px); opacity: 0.93; }
:deep(.chat-object-card-icon) { display: grid; place-items: center; flex: 0 0 27px; width: 27px; height: 27px; border-radius: var(--radius-xs); background: var(--surface-soft-hover); color: var(--action-primary); }
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
:deep(.msg-bubble.md-body .md-view),
:deep(.msg-bubble.md-body .md-view p),
:deep(.msg-bubble.md-body .md-view li) {
  line-height: 1.65;
}
:deep(.msg-bubble.md-body .md-view li + li) {
  margin-top: 5px;
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
:deep(.msg.ai .msg-bubble) {
  max-width: var(--chat-assistant-bubble-max-width, 88%);
  background: var(--gugu-chat-assistant-bg); border: 1px solid var(--gugu-chat-assistant-border);
  border-bottom-left-radius: 4px; box-shadow: inset 0 1px 0 var(--gugu-chat-file-highlight);
}
:deep(.msg.member .msg-bubble) {
  background: var(--gugu-chat-member-bg); border: 1px solid var(--gugu-chat-member-border);
  border-bottom-left-radius: 4px;
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
  width: min(360px, 88%); box-sizing: border-box; margin: 6px 0 0; padding: 14px;
  border: 1px solid var(--border-default); border-radius: var(--card-radius);
  background: var(--surface-card-solid); color: var(--content-primary);
  box-shadow: inset 0 1px 0 var(--highlight-soft), var(--elevation-card);
}
:deep(.msg-link-buttons .interaction-body) {
  margin-top: 0; color: var(--content-secondary); font-size: var(--font-size-sm);
  line-height: var(--line-height-body); white-space: pre-wrap;
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
     避免两条规则的 transition 互相整体覆盖、丢掉其中一份。
     box-shadow 必须在列：hover 换阴影（highlight/shadow 双 token），漏列=瞬跳。 */
  transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease,
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
:deep(.msg-file-name) { display: block; font-size: 15px; font-weight: 500; line-height: var(--line-height-ui); color: var(--gugu-chat-file-name); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:deep(.msg-file-meta) { font-size: 12px; line-height: var(--line-height-ui); color: var(--gugu-chat-file-meta); }
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
