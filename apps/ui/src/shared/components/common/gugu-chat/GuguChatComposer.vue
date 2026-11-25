<template>
  <div v-if="pendingAtt.length || attUploading" class="chat-att-row">
    <div v-for="a in pendingAtt" :key="a.attach_id" class="chat-att-chip">
      <span class="chat-att-name">{{ a.name }}.{{ a.ext }}</span>
        <button class="chat-att-x" @click="onRemoveAtt(a)" :title="t('chat.remove')">×</button>
    </div>
    <span v-if="attUploading" class="chat-att-chip att-up">{{ t('common.status.processing') }}</span>
  </div>
  <div v-if="previewOnly" class="chat-preview-status" role="status">{{ t('chatUi.desktopPreview') }}</div>
  <div :inert="previewOnly" ref="inputRowEl" class="chat-input-row" :class="{ 'is-expanded': expanded, 'has-command-menu': commandMenuVisible && filteredCommands.length }">
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
      placement="top"
      :offset-x="expanded ? 42 : 8"
      :owner-z="ownerZ"
      :query="referencePicker.query"
      :items="referenceItems"
      :loading="referenceLoading"
      :active="referenceActive"
      @choose="chooseReference"
    />
    <input ref="fileInput" type="file" multiple style="display:none" @change="onFilePicked" />
    <div v-if="!recording" class="chat-input-editor" @click="onEditorClick">
      <EditorContent v-if="chatEditor" :editor="chatEditor" />
    </div>
    <div v-else class="rec-bar">
      <span class="rec-status" role="status">
        <span class="rec-dot" aria-hidden="true"></span>
        {{ t('chat.recording') }}
      </span>
      <span class="rec-time">{{ String(Math.floor(recordSecs / 60)).padStart(2, '0') }}:{{ String(recordSecs % 60).padStart(2, '0') }}</span>
      <button type="button" class="rec-cancel" @click="onCancelRecord">{{ t('chat.cancel') }}</button>
      <button type="button" class="send-btn" :title="t('chat.sendRecording')" :aria-label="t('chat.sendRecording')" @click="onStopRecord">
        <Icon name="status.success" :size="14" />
      </button>
    </div>
    <div v-if="!recording" class="chat-composer-tools">
      <div v-if="!textOnly" class="chat-composer-tools__group">
        <SelectPopup :options="addOptions" preferred-placement="top" :aria-label="t('chat.addAttachment')" @update:model-value="addToComposer" @click="loadComposerSkills">
          <template #trigger><Icon name="action.add" :size="16" /></template>
          <template #options="{ select }">
            <div class="chat-model-section">{{ t('chatComposer.context') }}</div>
            <button v-for="option in addOptions" :key="option.value" type="button" class="popup-menu-item chat-composer-option" @click="select(option.value)">
              <Icon :name="option.icon" :size="15" /><span>{{ option.label }}</span>
            </button>
            <div class="chat-model-section chat-composer-section-divider">{{ t('chatComposer.skills') }}</div>
            <button v-for="skill in composerSkills" :key="skill.id" type="button" class="popup-menu-item chat-composer-option" @click="select(`skill:${skill.id}`)">
              <Icon name="resource.skill" :size="15" /><span>{{ skill.name }}</span>
            </button>
            <div v-if="!composerSkills.length" class="chat-model-section" role="status">{{ t(skillLoading ? 'common.status.processing' : skillError ? 'chatComposer.skillsUnavailable' : 'chatComposer.noSkills') }}</div>
          </template>
        </SelectPopup>
        <SelectPopup v-if="automaticModeAvailable" :model-value="automaticModeEnabled ? 'auto' : 'confirm'"
          :options="approvalOptions" preferred-placement="top" :aria-label="t('chat.automaticMode')"
          :title="t(automaticModeEnabled ? 'chatComposer.auto' : 'chatComposer.confirm')" :disabled="automaticModeSaving"
          @update:model-value="value => { if ((value === 'auto') !== automaticModeEnabled) onToggleAutomaticMode() }">
          <template #trigger="{ label }">
            <Icon :name="automaticModeEnabled ? 'action.speed-fill' : 'admin.shield'" :size="15" />
            <span v-if="expanded" class="chat-composer-label chat-composer-approval-label">{{ label }}</span>
          </template>
          <template #options="{ select }">
            <button v-for="option in approvalOptions" :key="option.value" type="button" class="popup-menu-item chat-composer-option"
              :class="{ active: (option.value === 'auto') === automaticModeEnabled }" @click="select(option.value)">
              <Icon :name="option.icon" :size="15" />
              <span>{{ option.label }}</span>
            </button>
          </template>
        </SelectPopup>
      </div>
      <div class="chat-composer-tools__group chat-composer-tools__end">
        <SelectPopup v-if="supportsServerDefault ? !textOnly : byokModels.length > 0" v-model="modelChoice" :options="modelOptions" preferred-placement="top" :aria-label="t('chatComposer.model')">
          <template #trigger="{ label }">
            <span class="chat-composer-label">{{ label }}</span>
          </template>
          <template #options="{ select }">
            <button v-if="supportsServerDefault" type="button" class="popup-menu-item chat-composer-option" :class="{ active: !modelChoice }" @click="select('')">
              <span>{{ t('chatComposer.defaultModel') }}</span>
            </button>
            <div v-if="supportsServerDefault && byokModels.length" class="chat-model-section">{{ t('chatComposer.byok') }}</div>
            <button v-for="model in byokModels" :key="model.value" type="button" class="popup-menu-item chat-composer-option"
              :class="{ active: modelChoice === model.value }" @click="select(model.value)">
              <span>{{ model.label }}</span>
            </button>
          </template>
        </SelectPopup>
        <button v-if="voiceInputAvailable" class="att-btn" @click="onStartRecord" :title="t('chat.voiceInput')" :aria-label="t('chat.voiceInput')">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 7a4.5 4.5 0 0 0 9 0M8 11.5V14M5.5 14h5"/></svg>
        </button>
        <button v-if="streaming" type="button" class="send-btn" :class="{ 'exp-send-btn': expanded }"
          :title="t('chatUi.interruptRun')" :aria-label="t('chatUi.interruptRun')"
          @click="onStopStreaming()">
          <Icon name="action.stop-fill" :size="expanded ? 14 : 13" />
        </button>
        <button v-if="!streaming || hasDraft" type="button" class="send-btn" :class="{ 'exp-send-btn': expanded }"
          @click="onSend()">
          <Icon name="action.next" :size="expanded ? 14 : 13" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import SelectPopup from '@/components/common/controls/SelectPopup.vue'
import { chatCommandCatalogKey, chatModelCatalogKey } from './chatPresentationAccess'
import { userSkillsApi, type UserSkillItem } from '@/services/api'
import Icon from '@/components/common/icons/Icon.vue'
import ReferenceSuggestMenu from '@/components/common/content/ReferenceSuggestMenu.vue'
import { useReferenceSuggest } from '@/composables/mind/useReferenceSuggest'
import { loadChatCommands, type ChatCommandOption } from './chatCommands'
import { mindExtensions, type MindDocNode } from '@/composables/mind/useMindEditor'
import { LAST_SESSION_KEY } from './chatConstants'
import { chatTextFromDoc } from './chatDocText'
import { parseChatClipboardText, pastePlainTextClipboard } from './chatPaste'
import { useRuntimeAction } from '@/interaction/runtime/vue'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useProjectStore } from '@/stores/projects'
import { animateSourceReturn, useRuntimeReferenceResolver } from './chatRuntimeReference'
/**
 * 输入框、附件行和录音条：只负责输入交互和展示，不拥有附件/录音状态本身
 * （那是 useChatAttachments，由 GuguChat.vue 单次实例化后把结果和回调传进来）。
 *
 * 编辑器根节点是本组件内部的 DOM——父组件仍通过 expose 调用 focus/测高/重置高度，
 * 不重新拿一份引用，也不让 textarea 与视觉高亮层各自维护一套光标坐标。
 */
import { CHAT_REF_SURFACE_ID, findClickedChatReference, type ChatFile, type ChatReference } from './chatTypes'

const { t } = useI18n()

const props = defineProps<{
  previewOnly?: boolean
  textOnly?: boolean
  modelValue: string
  references: ChatReference[]
  standaloneReferences?: boolean
  pendingAtt: ChatFile[]
  attUploading: boolean
  recording: boolean
  voiceInputAvailable: boolean
  recordSecs: number
  expanded: boolean
  ownerZ: number
  streaming: boolean
  automaticModeEnabled: boolean
  automaticModeAvailable: boolean
  automaticModeSaving: boolean
  onToggleAutomaticMode: () => void
  vw: number
  onRemoveAtt: (a: ChatFile) => void
  onStartRecord: () => void
  onCancelRecord: () => void
  onStopRecord: () => void
  onFilePicked: (e: Event) => void
  onPaste: (e: ClipboardEvent) => void
  onReferenceClick: (reference: ChatReference) => void
  onSend: () => void
  onStopStreaming: () => void
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string]; 'update:references': [value: ChatReference[]] }>()
const hasDraft = computed(() => Boolean(props.modelValue.trim() || props.pendingAtt.length || (props.standaloneReferences && props.references.length)))
const commandMenuVisible = ref(false)
const commandIndex = ref(0)
const readChatCommands = inject(chatCommandCatalogKey, loadChatCommands)
const chatCommands = ref<ChatCommandOption[]>([])
const inputRowEl = ref<HTMLElement | null>(null)

// ── 拖文件卡进聊天 = @ 引用（Runtime 投放目标挂在 GuguChatWindow 的窗口根上）──
// 这里只消费 Runtime 的 move action：解析 objectIds 还原文件/文件夹引用，插入
// mindRef chip——references 数组是文档派生物，自动带上且天然去重。
const resolveRuntimeReferences = useRuntimeReferenceResolver()
const filesCache = useFilesCacheStore()
const projectStore = useProjectStore()

function insertReferenceChip(reference: ChatReference) {
  const editor = chatEditor.value
  if (!editor) return
  // 文档里已有同 type+id 的 chip 时不重复插入（referencesFromDoc 本身也会去重）
  if (referencesFromDoc(editor.getJSON() as MindDocNode)
    .some(item => item.type === reference.type && item.id === reference.id)) return
  let label: string
  if (reference.type === 'folder') {
    label = reference.label || `Folder ${reference.id}`
  } else if (reference.type === 'project') {
    label = projectStore.projects.find(project => project.id === Number(reference.id))?.name ?? (reference.label || `Project ${reference.id}`)
  } else if (reference.type === 'event' || reference.type === 'canvas_note') {
    label = reference.label || `${reference.type === 'event' ? 'Activity' : 'Canvas note'} ${reference.id}`
  } else {
    label = (typeof reference.id === 'string' ? filesCache.getFile(reference.id)?.displayName : null)
      || reference.label || `File ${reference.id}`
  }
  editor.chain().focus('end')
    .insertContent({ type: 'mindRef', attrs: { refType: reference.type, refId: reference.id, label } })
    .insertContent(' ')
    .run()
}

async function handleRuntimeReferenceDrop(objectIds: readonly string[]) {
  const references = await resolveRuntimeReferences(objectIds)
  if (!references.length) return
  if (references.some(reference => reference.type === 'project') && !projectStore.projectsLoaded) {
    await projectStore.fetchProjects()
  }
  for (const reference of references) insertReferenceChip(reference)
  // 落地动画结束后源卡片是瞬间显形的；给它补一段「从松手位置缩放淡入回归」的
  // 入场动画，等 Runtime 结束对该对象的视觉接管后播放。
  for (const objectId of objectIds) animateSourceReturn(objectId)
}

useRuntimeAction(async action => {
  if (action.type !== 'move' && action.type !== 'move-group') return
  if (action.toSurfaceId !== CHAT_REF_SURFACE_ID) return
  await handleRuntimeReferenceDrop(action.type === 'move-group' ? action.objectIds : [action.objectId])
})

const { items: referenceItems, loading: referenceLoading, active: referenceActive, search: searchReferences, reset: resetReferences, move: moveReferences } = useReferenceSuggest(180, true, item => (item.type !== 'folder' && item.type !== 'file') || /^(path|drop)-/u.test(String(item.id)))
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

function referencesFromDoc(doc: MindDocNode | null | undefined): ChatReference[] {
  const result: ChatReference[] = []
  for (const block of doc?.content ?? []) for (const node of block.content ?? []) {
    if (node.type !== 'mindRef') continue
    const attrs = node.attrs ?? {}
    // mcp 引用的 refId 是 UUID 字符串，Number() 会变 NaN——非纯数字 id 原样保留
    const rawId = attrs.refId
    const id = typeof rawId === 'string' && !/^\d+$/.test(rawId) ? rawId : Number(rawId)
    const reference = { type: attrs.refType as ChatReference['type'], id, label: String(attrs.label ?? '') }
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
  void nextTick(() => fitTextarea())
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
  if (props.textOnly) return
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

function onEditorClick(event: MouseEvent) {
  const reference = findClickedChatReference(event.target, props.references)
  if (reference) props.onReferenceClick(reference)
}

const chatEditor = useEditor({
  extensions: mindExtensions(t('chat.placeholder')),
  content: chatDoc(props.modelValue, props.references),
  // 聊天输入框不做 md 渲染：**加粗**/`代码`/# 标题等保持字面文本发出去，
  // 由消息气泡端 renderChatMd 统一渲染（产品要求：只气泡渲染，输入框不转）。
  // @ 引用走自定义联想选择器（syncReferencePicker），不依赖 tiptap 输入规则；
  // NoteEditor 同配置已验证。粘贴规则一并关掉，外部 md 文本粘贴也保持字面。
  enableInputRules: false,
  enablePasteRules: false,
  editorProps: {
    attributes: { class: 'chat-prosemirror' },
    clipboardTextParser: parseChatClipboardText,
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
      if (event.defaultPrevented) return true
      return pastePlainTextClipboard(event, _view)
    },
  },
  onUpdate: syncEditorState,
})

watch(() => [props.modelValue, props.references] as const, ([text, references]) => {
  const editor = chatEditor.value
  if (!editor) return
  const doc = editor.getJSON() as MindDocNode
  if (chatTextFromDoc(doc) === text && JSON.stringify(referencesFromDoc(doc)) === JSON.stringify(references)) return
  editor.commands.setContent(chatDoc(text, references) as any, { emitUpdate: false })
  void nextTick(() => fitTextarea())
})

function onInputSelection() {
  if (chatEditor.value?.isFocused) syncReferencePicker(chatEditor.value)
}

  onMounted(() => {
    if (props.previewOnly || props.textOnly) return
    document.addEventListener('pointerdown', onOutsidePointerdown, true)
  document.addEventListener('selectionchange', onInputSelection)
  void readChatCommands().then((items) => {
    chatCommands.value = items
    if (chatEditor.value?.isFocused) updateCommandMenu(props.modelValue)
  }).catch(() => {
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

const addOptions = computed(() => [
  { value: 'upload', label: t('chat.addAttachment'), icon: 'action.upload' as const },
  { value: 'reference', label: t('chatComposer.reference'), icon: 'action.at' as const },
])
const composerSkills = ref<Array<Pick<UserSkillItem, 'id' | 'name'>>>([])
const skillLoading = ref(false)
const skillError = ref(false)
async function loadComposerSkills() {
  if (skillLoading.value) return
  skillLoading.value = true
  skillError.value = false
  try {
    const { skills } = await userSkillsApi.list()
    composerSkills.value = skills.filter(skill => skill.enabled).map(({ id, name }) => ({ id, name }))
  } catch {
    composerSkills.value = []
    skillError.value = true
  } finally {
    skillLoading.value = false
  }
}
function addToComposer(value: string) {
  if (value === 'upload') fileInput.value?.click()
  else if (value === 'reference') chatEditor.value?.chain().focus('end').insertContent('@').run()
  else if (value.startsWith('skill:')) {
    const skill = composerSkills.value.find(item => item.id === value.slice(6))
    if (skill) insertReferenceChip({ type: 'skill', id: skill.id, label: skill.name })
  }
}

const approvalOptions = computed(() => [
  { value: 'confirm', label: t('chatComposer.confirm'), icon: 'admin.shield' as const },
  { value: 'auto', label: t('chatComposer.auto'), icon: 'action.speed-fill' as const },
])
const modelSelections = ref(new Map<string, string>())
const byokModels = ref<Array<{ value: string; label: string }>>([])
const catalogDefaultId = ref('')
const serverModelSelection = 'server'
const modelCatalog = inject(chatModelCatalogKey)
const supportsServerDefault = modelCatalog?.supportsServerDefault === true
const modelOptions = computed(() => supportsServerDefault
  ? [{ value: '', label: t('chatComposer.defaultModel') }, ...byokModels.value]
  : byokModels.value)
const modelKey = computed(() => {
  const key = modelCatalog?.selectionKey
  return typeof key === 'function' ? key() : key ?? null
})

function readModel(key: string) {
  const current = modelSelections.value.get(key)
  if (current !== undefined) return current
  try {
    const saved = localStorage.getItem(key)
    if (saved !== null) return saved
    const lastSession = localStorage.getItem(LAST_SESSION_KEY)
    const previous = lastSession ? localStorage.getItem(`${key}:${lastSession}`) ?? '' : ''
    if (previous) localStorage.setItem(key, previous)
    return previous
  } catch { return '' }
}

const savedModelChoice = computed(() => modelKey.value ? readModel(modelKey.value) : '')
const explicitModelChoice = computed(() =>
  byokModels.value.some(model => model.value === savedModelChoice.value) ? savedModelChoice.value : '')
const useServerModel = computed(() => supportsServerDefault && savedModelChoice.value === serverModelSelection)

const modelChoice = computed({
  get: () => useServerModel.value ? '' : explicitModelChoice.value || catalogDefaultId.value,
  set: value => {
    const key = modelKey.value
    if (!key) return
    if (!supportsServerDefault && value === catalogDefaultId.value) value = ''
    if (supportsServerDefault && value === '') value = serverModelSelection
    modelSelections.value.set(key, value)
    try { localStorage.setItem(key, value) }
    catch { /* 存储不可用时仍可在当前页面选择。 */ }
  },
})
function selectedCredentialId() {
  if (!supportsServerDefault) return undefined
  if (useServerModel.value) return null
  return modelChoice.value ? Number(modelChoice.value) : undefined
}
let modelLoadRevision = 0
async function refreshModels() {
  const key = modelKey.value
  if (!modelCatalog || !key || props.previewOnly || (props.textOnly && supportsServerDefault)) return
  const revision = ++modelLoadRevision
  try {
    const result = await modelCatalog.list()
    if (revision !== modelLoadRevision || key !== modelKey.value) return
    catalogDefaultId.value = result.defaultId ?? ''
    byokModels.value = result.items.map(item => ({ value: item.id, label: item.model }))
  } catch { /* 继续使用当前模型选项。 */ }
}
watch(modelKey, () => {
  modelLoadRevision++
  catalogDefaultId.value = ''
  byokModels.value = []
  void refreshModels()
})
onMounted(() => {
  void refreshModels()
  window.addEventListener('gugu-chat-models-changed', refreshModels)
})
onUnmounted(() => {
  modelLoadRevision++
  window.removeEventListener('gugu-chat-models-changed', refreshModels)
})

defineExpose({
  selectedCredentialId,
  selectedModelId: () => explicitModelChoice.value || undefined,
  focus: () => chatEditor.value?.commands.focus(),
  focusEnd: () => chatEditor.value?.commands.focus('end'),
  handleRuntimeReferenceDrop,
  insertReferenceChip,
  fitTextarea,
  resetHeight: () => { if (chatEditor.value) chatEditor.value.view.dom.style.height = 'auto' },
})
</script>

<style scoped>
.chat-preview-status { padding: var(--space-xs) var(--space-md); color: var(--content-secondary); font-size: 12px; }
.chat-input-row[inert] { opacity: .6; }
.chat-att-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px 6px; }
.chat-att-chip { display: flex; align-items: center; gap: 5px; max-width: 180px;
  padding: 3px 8px; border-radius: 8px; font-size: 11px; color: var(--color-primary);
  background: color-mix(in srgb, var(--action-primary) 10%, transparent); border: 1px solid color-mix(in srgb, var(--action-primary) 20%, transparent); }
.chat-att-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-att-x { background: none; border: none; cursor: pointer; color: var(--color-primary);
  font-size: 13px; line-height: 1; padding: 0; opacity: 0.6; }
.chat-att-x:hover { opacity: 1; }
.chat-att-chip.att-up { color: var(--text-secondary); background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.08); }
.att-btn { flex-shrink: 0; background: none; border: none; cursor: pointer; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center; height: 28px; padding: 0;
  opacity: 0.7; transition: opacity 0.15s, color 0.15s, background-color 0.15s; }   /* 与发送按钮(28)等高，底对齐时中心也对齐 */
.att-btn:hover:not(:disabled) { opacity: 1; color: var(--control-fg-strong); background: var(--action-soft); }
.automatic-mode-btn.active { color: var(--color-primary); opacity: 1; }
.automatic-mode-btn:disabled { cursor: default; opacity: 0.45; }
.chat-composer-tools, .chat-composer-tools__group { display: flex; align-items: center; min-width: 0; gap: 4px; }
.chat-composer-tools { justify-content: space-between; }
@container (max-width: 320px) {
  .chat-composer-tools :deep(.chat-composer-approval-label) { display: none; }
}
.chat-composer-tools__end { margin-inline-start: auto; }
.chat-composer-tools__end > button { flex-shrink: 0; }
.chat-composer-tools .att-btn { width: 24px; border-radius: var(--radius-xs); }
.chat-model-section { padding: 6px 10px; color: var(--content-tertiary); font-size: 11px; }
.chat-composer-section-divider { margin-top: 4px; border-top: 1px solid var(--panel-divider); }
.chat-composer-option { display: flex; align-items: center; gap: 8px; }
.chat-composer-option > span { white-space: normal; overflow-wrap: anywhere; }
.chat-composer-tools :deep(.select-popup) { min-width: 0; max-width: 100%; }
.chat-composer-tools :deep(.select-popup-trigger) {
  justify-content: flex-start; min-width: 0; height: auto; min-height: 28px;
  padding: 4px 6px; gap: 5px; border-color: transparent; background: transparent;
  font-size: 11px;
}
.chat-composer-tools :deep(.select-popup-trigger:hover:not(:disabled)),
.chat-composer-tools :deep(.select-popup-trigger.open) {
  border-color: transparent; color: var(--control-fg-strong); background: var(--action-soft);
}
.chat-composer-tools :deep(.select-popup-trigger > svg) { flex-shrink: 0; }
.chat-composer-tools :deep(.select-popup-trigger > .chat-composer-label) {
  white-space: normal; overflow-wrap: anywhere; overflow: visible; text-overflow: clip;
}
.chat-input-row {
  container-type: inline-size;
  min-height: var(--gugu-chat-composer-height);
  box-sizing: border-box;
  display: flex; flex-direction: column; align-items: stretch; gap: 6px;
  position: relative;
  padding: 10px 13px;
  border-top: 1px solid rgba(255,255,255,0.65);
  background: rgba(255,255,255,0.55);
  /* 命令菜单是本行的绝对定位子层；父级若再建立 backdrop 根，菜单会采样到
     输入栏的已合成结果，而不是下面的消息内容。chat-main 已负责窗口底层材质。 */
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
  flex-shrink: 0;
}
.chat-input-row.has-command-menu { z-index: calc(var(--scrollbar-overlay-z-index, 6) + 1); }
.chat-command-menu {
  position: absolute;
  inset-inline-start: 13px;
  bottom: calc(100% + 4px);
  z-index: 5;
  width: min(290px, calc(100% - 16px));
  max-height: min(280px, calc(100vh - 120px));
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-xs);
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
/* 录音条：录音时替换输入框 */
.rec-bar {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
  padding: var(--space-xs);
  border: 1px solid var(--popup-surface-border);
  border-radius: var(--popup-surface-radius);
}
.rec-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  min-width: 0;
  padding: var(--space-xs) var(--space-sm);
  border-radius: 999px;
  background: var(--status-danger-bg);
  color: var(--status-danger);
  font-size: var(--font-size-xs);
}
.rec-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
  animation: rec-pulse 1.6s ease-in-out infinite;
}
@keyframes rec-pulse { 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) { .rec-dot { animation: none; } }
.rec-time {
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
  color: var(--content-primary);
}
.rec-cancel {
  margin-inline-start: auto;
  flex: none;
  min-height: 28px;
  padding-inline: var(--space-sm);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--content-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}
.rec-cancel:hover { background: var(--surface-glass-hover); color: var(--content-primary); }
.chat-input-row textarea {
  flex: 1; border: none; background: none;
  font-size: 14px; color: var(--text-primary);
  outline: none; font-family: var(--font-sans);
  resize: none; line-height: 1.5; max-height: 120px; overflow-y: auto;
  display: block; padding: 4px 0; vertical-align: middle;
}
.chat-input-editor { position: relative; flex: 1; min-width: 0; }
.chat-input-editor :deep(.ProseMirror) {
  min-height: 40px; max-height: 120px; overflow-x: hidden; overflow-y: auto; outline: none;
  padding: 4px 0; color: var(--text-primary); font: 14px/1.5 var(--font-sans);
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
}
.chat-input-editor :deep(.ProseMirror p) { margin: 0; }
.chat-input-editor :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  color: var(--theme-content-tertiary);
  pointer-events: none;
}
.chat-input-editor :deep(.ProseMirror .mind-ref) {
  display: inline-flex; align-items: center; gap: 4px; vertical-align: middle;
  margin: 0 2px; padding: 0 5px; border: 1px solid var(--action-outline);
  border-radius: 5px; color: var(--content-primary); background: var(--action-soft);
  /* 编辑器行高 14px×1.5=21px。chip 用 middle 对齐且与行框等高时，上下各溢出
     1px 会把行盒撑到 23px（autogrow 量到 scrollHeight 变大 → 输入行变高）。
     20px + 上下 -2px 负 margin 把行盒贡献收回行框内：行高恒定且视觉居中。 */
  height: 20px; line-height: 18px; font-size: 12px; white-space: nowrap;
  /* 标题过长时在胶囊内省略，并给两侧 margin 和末尾光标留出空间。 */
  max-inline-size: calc(100% - 4px - 1ch);
  /* 上 -3 / 下 -1：净值仍 -2（行盒不变），但把 chip 内容相对 middle 中线上抬 1px，
     与图标/发送按钮的垂直中心对齐（它们都在行中心 +1px 处，见 border-top 偏移）。 */
  margin: -3px 2px -1px 2px;
  /* 原子节点仍由 ProseMirror 整体选中/删除；这里不能用 user-select:all，
     否则光标紧贴引用末尾时，鼠标拖拽会被浏览器锁成“选中胶囊/移动光标”，
     无法继续建立前后文本选区。 */
  user-select: text; cursor: pointer;
}
.chat-input-editor :deep(.ProseMirror .mind-ref-icon) { flex: 0 0 auto; width: 11px; height: 11px; }
.chat-input-editor :deep(.ProseMirror .mind-ref-label) { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.exp-send-btn { width: 28px; height: 28px; border-radius: 8px; }

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
