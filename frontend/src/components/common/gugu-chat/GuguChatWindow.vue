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
    @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">

    <!-- 拖入遮罩（覆盖整个窗口，大小窗通用）-->
    <Transition name="chat-drop-fade">
      <div v-if="isChatDragging" class="chat-drop-overlay">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 16V6M8 10l4-4 4 4"/><path d="M5 19h14"/>
        </svg>
        <span>松开以添加附件</span>
      </div>
    </Transition>

    <!-- 扫码绑定 IM 弹窗 / 侧边栏：由父组件通过插槽填充 -->
    <slot name="bind-dialog" />
    <slot name="sidebar" />

    <!-- 主区域（始终存在，消息列表永不销毁） -->
    <div class="chat-main" :class="{ 'is-expanded': expanded, 'is-resizing': resizing }">
      <div class="chat-header">
        <template v-if="expanded && sessionId">
          <SessionTitleEdit
            class="chat-title"
            header
            :title="currentSessionTitle"
            :on-rename="(t) => onRenameSession(sessionId!, t)"
          />
          <span v-if="currentSessionWorkspaceName" class="chat-workspace-name">· {{ currentSessionWorkspaceName }}</span>
          <span v-if="currentSessionGoalStatus" class="chat-goal-indicator" :class="`is-${currentSessionGoalStatus}`" :title="currentSessionGoalStatus === 'paused' ? '目标任务已暂停' : '目标任务进行中'">
            <i :class="currentSessionGoalStatus === 'paused' ? 'ri-pause-circle-line' : 'ri-focus-3-line'" aria-hidden="true" />
            {{ currentSessionGoalStatus === 'paused' ? '目标已暂停' : '目标进行中' }}
          </span>
        </template>
        <span v-else class="chat-title" :class="{ 'is-new-session': expanded && !sessionId }">{{ expanded ? currentSessionTitle : '咕咕' }}</span>
        <span class="popup-status" :class="'is-' + presenceKind"
              @click="presenceKind === 'offline' && onPromptConnect()"
              :title="presenceTitle">
          <em class="status-dot" />{{ presenceText }}
        </span>
        <div class="btn-group">
          <button v-if="!expanded" class="popup-icon-btn" @click="onEnterExpanded" title="展开">
            <Icon name="action.expand" :size="13" />
          </button>
          <button v-if="expanded" class="exp-icon-btn" @click="onExitExpanded" title="收起">
            <Icon name="action.collapse" :size="14" />
          </button>
          <button class="popup-close-btn" @click="onClose">
            <Icon name="action.close" :size="13" />
          </button>
        </div>
      </div>

      <GuguChatMessageList
        ref="messageListRef"
        :messages="messages" :session-id="sessionId" :is-group-session="isGroupSession"
        :copied-id="copiedId" :voice-playing-id="voicePlayingId"
        :expanded="expanded" :status-kind="statusKind" :status-typed="statusTyped"
        :session-settling="sessionSettling"
        @copy="onCopy" @toggle-voice="onToggleVoice"
        @open-file="onOpenFile" @download="onDownload" @action-click="onActionClick"
        @interaction-select="onInteractionSelect"
      />

      <!-- 输入框 -->
      <GuguChatComposer
        ref="composerRef"
        v-model="inputTextModel"
        :pending-att="pendingAtt" :att-uploading="attUploading"
        :recording="recording" :record-secs="recordSecs"
        :expanded="expanded" :streaming="streaming" :vw="vw"
        :on-remove-att="onRemoveAtt"
        :on-start-record="onStartRecord" :on-cancel-record="onCancelRecord" :on-stop-record="onStopRecord"
        :on-file-picked="onFilePicked" :on-paste="onPaste"
        :on-send="onSend" :on-stop-streaming="onStopStreaming"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
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
import type { ChatMessage, ChatFile } from './chatTypes'

const props = defineProps<{
  // 窗口展示
  windowStyle: Record<string, string | number>
  expanded: boolean
  resizing: boolean
  streaming: boolean
  isChatDragging: boolean
  currentSessionTitle: string
  currentSessionWorkspaceName: string | null
  currentSessionGoalActive: boolean
  currentSessionGoalStatus: 'active' | 'paused' | null
  sessionId: number | null
  presenceKind: string
  presenceText: string
  presenceTitle: string
  // 消息列表
  messages: ChatMessage[]
  isGroupSession: boolean
  copiedId: number | null
  voicePlayingId: string | null
  statusKind: string
  statusTyped: string
  sessionSettling: boolean
  // 输入框
  inputText: string
  pendingAtt: ChatFile[]
  attUploading: boolean
  recording: boolean
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
  onInteractionSelect: (msg: ChatMessage, option: { id: string; label: string; token: string }) => void
  onPromptConnect: () => void
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

const emit = defineEmits<{ 'update:inputText': [value: string] }>()

// inputText 是 props（只读），用 computed 包装成可写的 v-model 桥，把输入变化
// 通过 emit('update:inputText') 回传给父组件（父组件持有真正的 inputText 状态）。
const inputTextModel = computed({
  get: () => props.inputText,
  set: (v: string) => emit('update:inputText', v),
})

const windowEl = ref<HTMLElement | null>(null)
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

/* 主区域负责背景 blur */
.chat-main {
  background: var(--panel-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  transform: translateZ(0);
  will-change: backdrop-filter;   /* 提示浏览器单独准备合成层，容器随窗口变尺寸时少一点现算的突兀感 */
}

/* 只有用户主动大/小窗切换才做几何缓动；普通 viewport resize 直接同步 layout。 */
.chat-window.is-layout-resizing {
  will-change: top, left, right, bottom;
  transition: top 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              left 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              right 0.42s cubic-bezier(0.16, 1, 0.3, 1),
              bottom 0.42s cubic-bezier(0.16, 1, 0.3, 1);
}

/* 窗口开/关动画 .chat-open-* 在 GuguChat.vue 定义（Transition 在那里，
   class 加在本根元素上，GuguChat.vue 的 scoped 样式能匹配）。 */

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
  border-bottom: 1px solid var(--gugu-chat-header-border, rgba(255,255,255,0.5));
  flex-shrink: 0;
}
.chat-main.is-expanded .chat-header { padding: 16px 20px 12px; }
.chat-title { font-size: 13px; font-weight: 700; }
.chat-title.is-new-session { display: inline-block; padding: 2px 6px; }
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
/* 让 im 状态 + 按钮组始终靠右，标题按内容收缩；不再用 flex: 1 撑大标题，避免把右侧元素挤变形 */
.popup-status { margin-left: auto; }
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

/* 大窗态祖先态覆盖：放大按钮/输入区（跨组件，用 :deep() 穿透子组件 scope） */
.chat-main.is-expanded :deep(.att-btn) { height: 32px; }
.chat-main.is-expanded :deep(.chat-input-row) { padding: 14px 20px; gap: 10px; }
.chat-main.is-expanded :deep(.rec-bar) { height: 32px; }
.chat-main.is-expanded :deep(.chat-input-row textarea) { padding: 5.5px 0; }
.chat-main:not(.is-expanded) :deep(.chat-input-row textarea) { font-size: 13px; }

/* 消息列表容器与内部结构渲染于 GuguChatMessageList.vue，需要 :deep() 穿透 */
:deep(.chat-messages) {
  flex: 1; overflow-y: auto; overflow-x: hidden; position: relative;
}
:deep(.chat-messages.is-session-settling) { visibility: hidden; }
.chat-main.is-expanded :deep(.chat-messages .msg-bubble) { max-width: 72%; font-size: 14px; }
.chat-main.is-expanded :deep(.chat-messages .msg-quoted) { max-width: 72%; font-size: 13.5px; }
:deep(.msg-virtual-spacer) { position: relative; width: 100%; }
:deep(.msg-virtual-row) { position: absolute; top: 0; left: 0; width: 100%; box-sizing: border-box; padding: 0 13px 8px; }
.chat-main.is-expanded :deep(.msg-virtual-row) { padding: 0 24px 12px; }
:deep(.msg-virtual-row.is-tool-row), .chat-main.is-expanded :deep(.msg-virtual-row.is-tool-row),
:deep(.msg-virtual-row.is-interaction-row), .chat-main.is-expanded :deep(.msg-virtual-row.is-interaction-row) { padding-bottom: var(--space-xs); }
:deep(.chat-messages > .msg) { margin: 8px 13px 12px; }
.chat-main.is-expanded :deep(.chat-messages > .msg) { margin: 12px 24px 20px; }

/* 收起按钮（窗口头部，不在侧栏里） */
.exp-icon-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s; flex-shrink: 0;
}
.exp-icon-btn:hover { background: rgba(123,127,178,0.12); color: var(--color-primary); }
.exp-icon-btn svg { display: block; }
</style>
