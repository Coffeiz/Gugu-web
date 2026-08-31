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
    <ReferenceSuggestMenu
      :show="referencePicker.open"
      :anchor="inputRowEl"
      :offset-x="expanded ? 42 : 8"
      :owner-z="ownerZ"
      :query="referencePicker.query"
      :items="referenceItems"
      :loading="referenceLoading"
      :active="referenceActive"
      @choose="chooseReference"
    />
    <button v-if="!recording" class="att-btn" @click="fileInput?.click()" :title="t('chat.addAttachment')" :aria-label="t('chat.addAttachment')">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7l-5.5 5.5a2.5 2.5 0 0 1-3.5-3.5L9 3.5a1.5 1.5 0 0 1 2 2L5.5 11"/></svg>
    </button>
    <button v-if="!recording" class="att-btn" @click="onStartRecord" :title="t('chat.voiceInput')" :aria-label="t('chat.voiceInput')">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 7a4.5 4.5 0 0 0 9 0M8 11.5V14M5.5 14h5"/></svg>
    </button>
    <input ref="fileInput" type="file" multiple style="display:none" @change="onFilePicked" />
    <div v-if="!recording" class="chat-input-editor">
      <EditorContent v-if="chatEditor" :editor="chatEditor" />
    </div>
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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import Icon from '@/components/common/Icon.vue'
import ReferenceSuggestMenu from '@/components/common/ReferenceSuggestMenu.vue'
import { useReferenceSuggest } from '@/composables/useReferenceSuggest'
import { loadChatCommands, type ChatCommandOption } from './chatCommands'
import { mindExtensions, type MindDocNode } from '@/composables/useMindEditor'
/**
 * 输入框、附件行和录音条：只负责输入交互和展示，不拥有附件/录音状态本身
 * （那是 useChatAttachments，由 GuguChat.vue 单次实例化后把结果和回调传进来）。
 *
 * 编辑器根节点是本组件内部的 DOM——父组件仍通过 expose 调用 focus/测高/重置高度，
 * 不重新拿一份引用，也不让 textarea 与视觉高亮层各自维护一套光标坐标。
 */
import type { ChatFile, ChatReference } from './chatTypes'
const { t } = useI18n()

const props = defineProps<{
  modelValue: string
  references: ChatReference[]
  pendingAtt: ChatFile[]
  attUploading: boolean
  recording: boolean
  recordSecs: number
  expanded: boolean
  ownerZ: number
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

const emit = defineEmits<{ 'update:modelValue': [value: string]; 'update:references': [value: ChatReference[]] }>()
const commandMenuVisible = ref(false)
const commandIndex = ref(0)
const chatCommands = ref<ChatCommandOption[]>([])
const inputRowEl = ref<HTMLElement | null>(null)
const { items: referenceItems, loading: referenceLoading, active: referenceActive, search: searchReferences, reset: resetReferences, move: moveReferences } = useReferenceSuggest()
const referencePicker = ref({ open: false, query: '', from: 0, to: 0 })
let lastReferenceQuery: string | null = null

function chatInlineNodes(text: string, references: ChatReference[]): MindDocNode[] {
  if (!text) return []
  const refs = references
    .map(reference => ({ reference, token: `@${reference.label}` }))
    .filter(entry => entry.token.length > 1)
  const nodes: MindDocNode[] = []
  let cursor = 0
  while (cursor < text.length) {
    let next = -1
    let nextRef: (typeof refs)[number] | undefined
    for (const entry of refs) {
      const index = text.indexOf(entry.token, cursor)
      if (index >= 0 && (next < 0 || index < next)) { next = index; nextRef = entry }
    }
    if (!nextRef || next < 0) {
      nodes.push({ type: 'text', text: text.slice(cursor) })
      break
    }
    if (next > cursor) nodes.push({ type: 'text', text: text.slice(cursor, next) })
    nodes.push({ type: 'mindRef', attrs: { refType: nextRef.reference.type, refId: nextRef.reference.id, label: nextRef.reference.label } })
    cursor = next + nextRef.token.length
  }
  return nodes
}

function chatTextFromDoc(doc: MindDocNode | null | undefined): string {
  return (doc?.content ?? []).map(block => (block.content ?? []).map(node => {
    if (node.type === 'hardBreak') return '\n'
    if (node.type === 'mindRef') return `@${node.attrs?.label ?? ''}`
    return node.text ?? ''
  }).join('')).join('\n')
}

function referencesFromDoc(doc: MindDocNode | null | undefined): ChatReference[] {
  const result: ChatReference[] = []
  for (const block of doc?.content ?? []) for (const node of block.content ?? []) {
    if (node.type !== 'mindRef') continue
    const attrs = node.attrs ?? {}
    const reference = { type: attrs.refType as ChatReference['type'], id: Number(attrs.refId), label: String(attrs.label ?? '') }
    if (reference.label && !result.some(item => item.type === reference.type && item.id === reference.id)) result.push(reference)
  }
  return result
}

function chatDoc(text: string, references: ChatReference[]): MindDocNode {
  return {
    type: 'doc',
    content: text.split('\n').map(line => ({ type: 'paragraph', content: chatInlineNodes(line, references) })),
  }
}

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

function syncEditorState() {
  const editor = chatEditor.value
  if (!editor) return
  const doc = editor.getJSON() as MindDocNode
  const text = chatTextFromDoc(doc)
  commandIndex.value = 0
  updateCommandMenu(text)
  emit('update:modelValue', text)
  emit('update:references', referencesFromDoc(doc))
  syncReferencePicker(editor)
}

function findReferenceTrigger(editor: any) {
  const { from } = editor.state.selection
  const before = editor.state.doc.textBetween(Math.max(0, from - 120), from, '\n', '￼')
  const match = /(^|[\s])@([^\s@]*)$/.exec(before)
  if (!match) return null
  const length = match[2].length + 1
  return { query: match[2], from: from - length, to: from }
}

function syncReferencePicker(editor: any) {
  const trigger = findReferenceTrigger(editor)
  if (!trigger) {
    referencePicker.value.open = false
    lastReferenceQuery = null
    resetReferences()
    return
  }
  referencePicker.value = {
    ...referencePicker.value,
    ...trigger,
    open: true,
  }
  if (lastReferenceQuery !== trigger.query) {
    lastReferenceQuery = trigger.query
    searchReferences(trigger.query)
  }
}

function chooseReference(item: ChatReference) {
  const editor = chatEditor.value
  if (!editor) return
  const { from, to } = referencePicker.value
  editor.chain().focus().deleteRange({ from, to })
    .insertContent({ type: 'mindRef', attrs: { refType: item.type, refId: item.id, label: item.label } })
    .insertContent(' ')
    .run()
  referencePicker.value.open = false
  lastReferenceQuery = null
  resetReferences()
}

function chooseCommand(item: ChatCommandOption) {
  commandMenuVisible.value = false
  commandIndex.value = 0
  chatEditor.value?.commands.setContent(chatDoc(item.insert, []) as any, { emitUpdate: false })
  emit('update:modelValue', item.insert)
  requestAnimationFrame(() => chatEditor.value?.commands.focus('end'))
}

function onKeydown(event: KeyboardEvent) {
  if (referencePicker.value.open && referenceItems.value.length) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveReferences(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveReferences(-1); return }
    if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); chooseReference(referenceItems.value[referenceActive.value]); return }
    if (event.key === 'Escape') { event.preventDefault(); referencePicker.value.open = false; lastReferenceQuery = null; resetReferences(); return }
  }
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
  if (!commandMenuVisible.value && !referencePicker.value.open) return
  const target = event.target
  if (target instanceof Element && target.closest('.reference-picker')) {
    return
  }
  if (target instanceof Node && inputRowEl.value?.contains(target)) return
  commandMenuVisible.value = false
  referencePicker.value.open = false
  lastReferenceQuery = null
  resetReferences()
}

const chatEditor = useEditor({
  extensions: mindExtensions(t('chat.placeholder')),
  content: chatDoc(props.modelValue, props.references),
  editorProps: {
    attributes: { class: 'chat-prosemirror' },
    handleKeyDown: (_view, event) => {
      onKeydown(event)
      if (event.defaultPrevented) return true
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        props.onSend()
        return true
      }
      return false
    },
    handlePaste: (_view, event) => {
      props.onPaste(event)
      return false
    },
  },
  onUpdate: syncEditorState,
})

watch(() => [props.modelValue, props.references] as const, ([text, references]) => {
  const editor = chatEditor.value
  if (!editor || chatTextFromDoc(editor.getJSON() as MindDocNode) === text) return
  editor.commands.setContent(chatDoc(text, references) as any, { emitUpdate: false })
})

function onInputSelection() {
  if (chatEditor.value?.isFocused) syncReferencePicker(chatEditor.value)
}

  onMounted(() => {
    document.addEventListener('pointerdown', onOutsidePointerdown, true)
  document.addEventListener('selectionchange', onInputSelection)
  void loadChatCommands().then((items) => { chatCommands.value = items }).catch(() => {
    // 命令注册表不可用时不展示过期的本地列表，避免把不存在的命令提示给用户。
    chatCommands.value = []
  })
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onOutsidePointerdown, true)
  document.removeEventListener('selectionchange', onInputSelection)
})

const fileInput = ref<HTMLInputElement | null>(null)

function fitTextarea(_isExpanded = props.expanded) {
  // 聊天输入与笔记一样是真正的 inline 编辑器，直接量 ProseMirror 根节点即可；
  // 引用节点参与排版，不再需要一个视觉高亮层和隐藏 textarea 互相对齐。
  const el = chatEditor.value?.view.dom as HTMLElement | undefined
  if (!el) return
  void _isExpanded
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`
}

defineExpose({
  focus: () => chatEditor.value?.commands.focus(),
  fitTextarea,
  resetHeight: () => { if (chatEditor.value) chatEditor.value.view.dom.style.height = 'auto' },
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
.chat-input-row textarea {
  flex: 1; border: none; background: none;
  font-size: 14px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
  resize: none; line-height: 1.5; max-height: 120px; overflow-y: auto;
  display: block; padding: 4px 0; vertical-align: middle;
}
.chat-input-editor { position: relative; flex: 1; min-width: 0; }
.chat-input-editor :deep(.ProseMirror) {
  min-height: 24px; max-height: 120px; overflow-y: auto; outline: none;
  padding: 4px 0; color: var(--text-primary); font: 14px/1.5 var(--font-sans);
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
}
.chat-input-editor :deep(.ProseMirror p) { margin: 0; }
.chat-input-editor :deep(.ProseMirror .mind-ref) {
  display: inline-flex; align-items: center; gap: 4px; vertical-align: baseline;
  margin: 0 2px; padding: 1px 5px; border: 1px solid var(--action-outline);
  border-radius: 5px; color: var(--content-primary); background: var(--action-soft);
  line-height: 1.35; white-space: nowrap;
  /* 原子节点仍由 ProseMirror 整体选中/删除；这里不能用 user-select:all，
     否则光标紧贴引用末尾时，鼠标拖拽会被浏览器锁成“选中胶囊/移动光标”，
     无法继续建立前后文本选区。 */
  user-select: text;
}
.chat-input-editor :deep(.ProseMirror .mind-ref-icon) { flex: 0 0 auto; }
.chat-input-editor :deep(.ProseMirror .mind-ref-label) { overflow: hidden; text-overflow: ellipsis; }

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
