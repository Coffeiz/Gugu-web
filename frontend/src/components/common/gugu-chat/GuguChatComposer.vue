<template>
  <div v-if="pendingAtt.length || attUploading" class="chat-att-row">
    <div v-for="a in pendingAtt" :key="a.attach_id" class="chat-att-chip">
      <span class="chat-att-name">{{ a.name }}.{{ a.ext }}</span>
        <button class="chat-att-x" @click="onRemoveAtt(a)" :title="t('chat.remove')">×</button>
    </div>
    <span v-if="attUploading" class="chat-att-chip att-up">{{ t('common.status.processing') }}</span>
  </div>
  <div ref="inputRowEl" class="chat-input-row" :class="{ 'is-expanded': expanded }">
    <Transition name="chat-command-pop">
      <div v-if="commandMenuVisible && filteredCommands.length" class="chat-command-menu" role="listbox" :aria-label="t('chat.commandList')">
        <button
          v-for="(item, index) in filteredCommands"
          :key="item.command"
          class="chat-command-item"
          :class="{ active: index === commandIndex }"
          type="button"
          role="option"
          :aria-selected="index === commandIndex"
          @mousedown.prevent
          @click="chooseCommand(item)"
        >
          <code>{{ item.command }}</code>
          <span class="chat-command-copy"><strong>{{ t(`chat.commands.${item.command.slice(1)}.label`) }}</strong><small>{{ t(`chat.commands.${item.command.slice(1)}.description`) }}</small></span>
        </button>
      </div>
    </Transition>
    <button v-if="!recording" class="att-btn" @click="fileInput?.click()" :title="t('chat.addAttachment')" :aria-label="t('chat.addAttachment')">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7l-5.5 5.5a2.5 2.5 0 0 1-3.5-3.5L9 3.5a1.5 1.5 0 0 1 2 2L5.5 11"/></svg>
    </button>
    <button v-if="!recording" class="att-btn" @click="onStartRecord" :title="t('chat.voiceInput')" :aria-label="t('chat.voiceInput')">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 7a4.5 4.5 0 0 0 9 0M8 11.5V14M5.5 14h5"/></svg>
    </button>
    <input ref="fileInput" type="file" multiple style="display:none" @change="onFilePicked" />
    <textarea
      v-if="!recording"
      :value="modelValue"
      @input="onInput"
      ref="expInputEl"
      :placeholder="t('chat.placeholder')"
      rows="1"
      v-enter.exact.prevent="() => onSend()"
      @paste="onPaste"
      @keydown="onKeydown"
    />
    <div v-else class="rec-bar">
      <span class="rec-dot"></span>
      <span class="rec-time">{{ recordSecs }}″</span>
      <span class="rec-hint">{{ t('chat.recording') }}</span>
      <button class="rec-cancel" @click="onCancelRecord">{{ t('chat.cancel') }}</button>
    </div>
    <button class="send-btn" :class="{ 'exp-send-btn': expanded }" @click="recording ? onStopRecord() : (streaming ? onStopStreaming() : onSend())">
      <Icon name="status.success"      v-if="recording" :size="expanded ? 14 : 13" />
      <Icon name="action.next" v-else-if="!streaming" :size="expanded ? 14 : 13" />
      <Icon name="action.stop-fill" v-else  :size="expanded ? 14 : 13" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { loadChatCommands, type ChatCommandOption } from './chatCommands'
/**
 * 输入框、附件行和录音条：只负责输入交互和展示，不拥有附件/录音状态本身
 * （那是 useChatAttachments，由 GuguChat.vue 单次实例化后把结果和回调传进来）。
 *
 * expInputEl 是本组件内部的 DOM 引用——父组件仍需要在展开/收起窗口、新建会话、
 * 发送后收起多行输入框时操作它（focus/测宽度重新量高度/清空后收起高度），
 * 通过 defineExpose 暴露 focus()/fitTextarea()/resetHeight()，不重新拿一份引用。
 */
import type { ChatFile } from './chatTypes'
import { SMALL_W, SIDEBAR_W } from './chatConstants'
const { t } = useI18n()

const props = defineProps<{
  modelValue: string
  pendingAtt: ChatFile[]
  attUploading: boolean
  recording: boolean
  recordSecs: number
  expanded: boolean
  streaming: boolean
  vw: number
  onRemoveAtt: (a: ChatFile) => void
  onStartRecord: () => void
  onCancelRecord: () => void
  onStopRecord: () => void
  onFilePicked: (e: Event) => void
  onPaste: (e: ClipboardEvent) => void
  onSend: () => void
  onStopStreaming: () => void
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const commandMenuVisible = ref(false)
const commandIndex = ref(0)
const chatCommands = ref<ChatCommandOption[]>([])
const inputRowEl = ref<HTMLElement | null>(null)
function commandsForValue(value: string) {
  const match = value.match(/^\/([^\s]*)$/)
  if (!match) return []
  const query = match[1].toLowerCase()
  return chatCommands.value.filter(item => item.command.slice(1).startsWith(query))
}
const filteredCommands = computed(() => commandsForValue(props.modelValue))

function updateCommandMenu(value: string) {
  const matches = commandsForValue(value)
  commandMenuVisible.value = matches.length > 0
  if (commandIndex.value >= matches.length) commandIndex.value = 0
}

function onInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  commandIndex.value = 0
  updateCommandMenu(el.value)
  emit('update:modelValue', el.value)
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

function chooseCommand(item: ChatCommandOption) {
  commandMenuVisible.value = false
  commandIndex.value = 0
  emit('update:modelValue', item.insert)
  requestAnimationFrame(() => expInputEl.value?.focus())
}

function onKeydown(event: KeyboardEvent) {
  if (!commandMenuVisible.value || !filteredCommands.value.length) {
    if (event.key === 'Escape') commandMenuVisible.value = false
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    commandIndex.value = (commandIndex.value + 1) % filteredCommands.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    commandIndex.value = (commandIndex.value - 1 + filteredCommands.value.length) % filteredCommands.value.length
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    chooseCommand(filteredCommands.value[commandIndex.value])
  } else if (event.key === 'Escape') {
    event.preventDefault()
    commandMenuVisible.value = false
  }
}

function onOutsidePointerdown(event: PointerEvent) {
  if (!commandMenuVisible.value) return
  const target = event.target
  if (target instanceof Node && inputRowEl.value?.contains(target)) return
  commandMenuVisible.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onOutsidePointerdown, true)
  void loadChatCommands().then((items) => { chatCommands.value = items }).catch(() => {
    // 命令注册表不可用时不展示过期的本地列表，避免把不存在的命令提示给用户。
    chatCommands.value = []
  })
})
onUnmounted(() => document.removeEventListener('pointerdown', onOutsidePointerdown, true))

const fileInput   = ref<HTMLInputElement | null>(null)
const expInputEl  = ref<HTMLTextAreaElement | null>(null)

function textareaWidthForMode(isExpanded: boolean) {
  if (!isExpanded) {
    // 小窗：左右内边距 13px、两个 16px 附件按钮、28px 发送按钮和三段 8px 间距。
    return SMALL_W - 26 - 16 - 16 - 28 - 24
  }
  const left = Math.max(SIDEBAR_W + 12, props.vw * 0.4 - 12)
  const mainWidth = props.vw - left - 12 - 210
  // 大窗：左右内边距 20px、两个 16px 附件按钮、32px 发送按钮和三段 10px 间距。
  return Math.max(0, mainWidth - 40 - 16 - 16 - 32 - 30)
}

function fitTextarea(isExpanded = props.expanded) {
  // 切换时 chat-window 的四条边都在过渡，直接读真实 textarea 只能拿到"当前帧"的宽度。
  // 克隆到离屏节点按目标宽度量 scrollHeight，点击瞬间就能得到目标模式的正确行数。
  const el = expInputEl.value
  if (!el) return
  const width = textareaWidthForMode(isExpanded)
  if (!width) return
  const style = getComputedStyle(el)
  const sizer = document.createElement('textarea')
  sizer.value = el.value
  sizer.rows = 1
  sizer.setAttribute('aria-hidden', 'true')
  Object.assign(sizer.style, {
    position: 'fixed',
    visibility: 'hidden',
    pointerEvents: 'none',
    left: '-9999px',
    top: '0',
    width: `${width}px`,
    height: 'auto',
    minHeight: '0',
    maxHeight: 'none',
    overflow: 'hidden',
    boxSizing: style.boxSizing,
    padding: style.padding,
    border: style.border,
    font: style.font,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    whiteSpace: style.whiteSpace,
    wordBreak: style.wordBreak,
    overflowWrap: style.overflowWrap,
    tabSize: style.tabSize,
  })
  document.body.appendChild(sizer)
  const height = Math.min(sizer.scrollHeight, 120)
  sizer.remove()
  el.style.height = `${height}px`
}

defineExpose({
  focus: () => expInputEl.value?.focus(),
  fitTextarea,
  resetHeight: () => { if (expInputEl.value) expInputEl.value.style.height = 'auto' },
})
</script>

<style scoped>
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
.att-btn:hover { opacity: 1; color: var(--color-primary); }
.chat-input-row {
  display: flex; align-items: flex-end; gap: 8px;   /* 输入框多行增高时，附件/发送按钮贴底对齐 */
  position: relative;
  padding: 10px 13px;
  border-top: 1px solid rgba(255,255,255,0.65);
  background: rgba(255,255,255,0.55);
  /* 命令菜单是本行的绝对定位子层；父级若再建立 backdrop 根，菜单会采样到
     输入栏的已合成结果，而不是下面的消息内容。chat-main 已负责窗口底层材质。 */
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  flex-shrink: 0;
}
.chat-command-menu {
  position: absolute;
  left: 8px;
  bottom: calc(100% + 8px);
  z-index: 5;
  width: min(290px, calc(100% - 16px));
  max-height: min(280px, calc(100vh - 120px));
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--popup-surface-bg);
  box-shadow: var(--elevation-popup);
  backdrop-filter: var(--popup-surface-blur);
  -webkit-backdrop-filter: var(--popup-surface-blur);
}
.chat-command-pop-enter-active,
.chat-command-pop-leave-active {
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard),
              transform var(--motion-hover-control) var(--motion-ease-standard);
  transform-origin: left bottom;
}
.chat-command-pop-enter-from,
.chat-command-pop-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(.97);
}
/* 命令菜单有圆角，原生滑块轨道必须避开上下边缘，避免伸出弹窗轮廓。 */
.chat-command-menu::-webkit-scrollbar {
  width: calc(var(--scrollbar-size-default) + 2px);
}
.chat-command-menu::-webkit-scrollbar-track {
  margin-block: var(--scrollbar-safe-inset);
}
.chat-command-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--content-primary);
  text-align: left;
  cursor: pointer;
}
.chat-command-item:hover, .chat-command-item.active { background: var(--sidebar-item-hover); }
.chat-command-item code { flex: 0 0 70px; color: var(--selection-fg); font: 11px var(--font-family-mono); }
.chat-command-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.chat-command-copy strong { font-size: 12px; font-weight: 650; }
.chat-command-copy small { overflow: hidden; color: var(--content-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.chat-input-row.is-expanded .chat-command-menu { left: 42px; width: min(320px, calc(100% - 54px)); }
/* 录音条：录音时替换输入框 */
.rec-bar { flex: 1; display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--text-primary); height: 28px; min-width: 0; }   /* 与按钮(28)等高 → flex-end 底对齐时内容也居中对齐，不再偏低 */
.rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #e15c5c; flex-shrink: 0; animation: rec-pulse 1s ease-in-out infinite; }
@keyframes rec-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.rec-time { font-variant-numeric: tabular-nums; font-weight: 600; color: #e15c5c; }
.rec-hint { color: var(--text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-cancel { margin-left: auto; flex-shrink: 0; border: none; background: rgba(123,127,178,0.12); color: var(--text-secondary); font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer; }
.rec-cancel:hover { background: rgba(123,127,178,0.2); }
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

.exp-send-btn { width: 32px; height: 32px; border-radius: 9px; }

/* ── 通用发送按钮 ── */
/* 背景色不进这里、留给全局 token 接管：tokens/product.css 提供基础色，
   theme-adoption.css 在暗色主题下用专门的 --gugu-chat-send-bg 覆盖，
   避免 brand-gradient 在暗色下过于刺眼。scoped 硬编码背景会导致
   跟全局 token 抢覆盖权——删掉，本组件只管尺寸/形状/交互。 */
.send-btn {
  width: 28px; height: 28px; border-radius: 8px; border: none;
  color: white;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: transform 0.15s; flex-shrink: 0;
}
.send-btn svg { display: block; }
.send-btn:hover:not(:disabled) { background: var(--action-primary-bg-hover); transform: none; }
.send-btn:disabled { opacity: 0.55; cursor: default; }
</style>
