<template>
  <div class="note-editor" :class="{ compact }">
    <!-- 窄口径工具栏：只有四种块，没有 / 菜单、没有加粗斜体 -->
    <div class="ne-toolbar" v-if="editor">
      <button class="ne-tool" :class="{ on: editor.isActive('paragraph') }"
              @mousedown.prevent="editor.chain().focus().setParagraph().run()" title="正文">正文</button>
      <button class="ne-tool" :class="{ on: editor.isActive('heading', { level: 1 }) }"
              @mousedown.prevent="editor.chain().focus().toggleHeading({ level: 1 }).run()" title="标题">H1</button>
      <button class="ne-tool" :class="{ on: editor.isActive('heading', { level: 2 }) }"
              @mousedown.prevent="editor.chain().focus().toggleHeading({ level: 2 }).run()" title="小标题">H2</button>
      <button class="ne-tool" :class="{ on: editor.isActive('taskList') }"
              @mousedown.prevent="editor.chain().focus().toggleTaskList().run()" title="待办">
        <PhCheckSquare :size="13" weight="bold" />
      </button>
      <span class="ne-hint">输入 <code>[[</code> 引用项目/文件/活动</span>
    </div>

    <EditorContent class="ne-body" :editor="editor" />

    <!-- `[[` 引用补全下拉：跟随光标定位 -->
    <div v-if="picker.open" class="ne-picker" :style="{ left: picker.x + 'px', top: picker.y + 'px' }">
      <div v-if="loading" class="ne-pick-empty">搜索中…</div>
      <div v-else-if="!items.length" class="ne-pick-empty">没找到「{{ picker.query }}」</div>
      <button v-for="(it, i) in items" :key="it.type + it.id"
              class="ne-pick-item" :class="{ on: i === active }"
              @mousedown.prevent="choose(it)">
        <span class="ne-pick-type">{{ TYPE_LABEL[it.type] }}</span>
        <span class="ne-pick-label">{{ it.label }}</span>
        <span v-if="it.subtitle" class="ne-pick-sub">{{ it.subtitle }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, reactive, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { PhCheckSquare } from '@phosphor-icons/vue'
import { docToMarkdown, markdownToDoc, mindExtensions } from '@/composables/useMindEditor'
import { useMindObjectPicker } from '@/composables/useMindObjectPicker'
import type { MindRefSuggestItem } from '@/services/api'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  compact?: boolean
  autofocus?: boolean
}>(), { placeholder: '写点什么…', compact: false, autofocus: false })

const emit = defineEmits<{
  (e: 'update:modelValue', md: string): void
  (e: 'submit'): void
}>()

const TYPE_LABEL: Record<string, string> = { project: '项目', file: '文件', event: '活动' }

const { items, loading, active, search, reset, move } = useMindObjectPicker()
const picker = reactive({ open: false, query: '', from: 0, to: 0, x: 0, y: 0 })

/** 光标前找 `[[关键词`（不跨行、不含 `]`），找到就是触发态 */
function findTrigger(ed: any): { query: string; from: number; to: number } | null {
  const { from } = ed.state.selection
  const start = Math.max(0, from - 80)
  const before = ed.state.doc.textBetween(start, from, '\n', '￼')
  const m = /\[\[([^[\]\n]*)$/.exec(before)
  if (!m) return null
  return { query: m[1], from: from - m[0].length, to: from }
}

function closePicker() {
  picker.open = false
  picker.query = ''
  reset()
}

function syncPicker(ed: any) {
  const t = findTrigger(ed)
  if (!t) { if (picker.open) closePicker(); return }
  picker.open = true
  picker.query = t.query
  picker.from = t.from
  picker.to = t.to
  // 把下拉挂到光标底下（coordsAtPos 给的是视口坐标，减去容器偏移）
  const box = ed.view.dom.closest('.note-editor')?.getBoundingClientRect()
  const caret = ed.view.coordsAtPos(t.from)
  if (box) { picker.x = caret.left - box.left; picker.y = caret.bottom - box.top + 4 }
  search(t.query)
}

function choose(it: MindRefSuggestItem) {
  const ed = editor.value
  if (!ed) return
  ed.chain().focus()
    .deleteRange({ from: picker.from, to: picker.to })   // 连同 `[[关键词` 一起删掉
    .insertContent({ type: 'mindRef', attrs: { refType: it.type, refId: it.id, label: it.label } })
    .insertContent(' ')
    .run()
  closePicker()
}

const editor = useEditor({
  content: markdownToDoc(props.modelValue) as any,
  extensions: mindExtensions(props.placeholder) as any,
  autofocus: props.autofocus,
  editorProps: {
    handleKeyDown(_view, event) {
      // 下拉开着时，方向键/回车归下拉；否则交回编辑器
      if (picker.open && items.value.length) {
        if (event.key === 'ArrowDown') { move(1); return true }
        if (event.key === 'ArrowUp') { move(-1); return true }
        if (event.key === 'Enter' || event.key === 'Tab') { choose(items.value[active.value]); return true }
      }
      if (picker.open && event.key === 'Escape') { closePicker(); return true }
      // Cmd/Ctrl+Enter 保存（下拉没开时）
      if (!picker.open && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        emit('submit'); return true
      }
      return false
    },
  },
  onUpdate({ editor: ed }) {
    emit('update:modelValue', docToMarkdown(ed.getJSON() as any))
    syncPicker(ed)
  },
  onSelectionUpdate({ editor: ed }) {
    syncPicker(ed)
  },
})

// 外部换了内容（比如切到另一条便签）才重灌，避免把用户正在打的字冲掉
watch(() => props.modelValue, (md) => {
  const ed = editor.value
  if (!ed) return
  if (docToMarkdown(ed.getJSON() as any) === md) return
  ed.commands.setContent(markdownToDoc(md) as any, { emitUpdate: false })
})

defineExpose({
  focus: () => editor.value?.commands.focus('end'),
  clear: () => editor.value?.commands.setContent(markdownToDoc('') as any, { emitUpdate: false }),
})

onBeforeUnmount(() => editor.value?.destroy())
</script>

<style scoped>
.note-editor { position: relative; }

.ne-toolbar {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 2px 6px;
}
.ne-tool {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 26px; height: 24px; padding: 0 7px;
  border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--text-secondary);
  font-size: 11.5px; font-weight: 600; cursor: pointer;
  font-family: var(--font-sans);
  transition: background 0.15s, color 0.15s;
}
.ne-tool:hover { background: rgba(123,127,178,0.1); color: var(--color-primary); }
.ne-tool.on { background: rgba(123,127,178,0.16); color: var(--color-primary); }
.ne-hint { margin-left: auto; font-size: 11px; color: var(--text-secondary); opacity: 0.65; }
.ne-hint code {
  padding: 0 3px; border-radius: 3px;
  background: rgba(123,127,178,0.12); font-size: 10.5px;
}

.ne-body { font-size: 13.5px; line-height: 1.65; color: var(--text-primary); }
.note-editor.compact .ne-body { min-height: 48px; }

/* `[[` 补全下拉 */
.ne-picker {
  position: absolute; z-index: 30; min-width: 220px; max-width: 320px;
  padding: 4px; border-radius: 10px;
  background: rgba(255,255,255,0.96);
  border: 1px solid rgba(255,255,255,0.9);
  box-shadow: 0 8px 26px rgba(60,70,100,0.18);
  backdrop-filter: blur(10px);
}
.ne-pick-empty { padding: 8px 10px; font-size: 12px; color: var(--text-secondary); }
.ne-pick-item {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 6px 8px; border: none; border-radius: 7px;
  background: transparent; cursor: pointer; text-align: left;
  font-family: var(--font-sans);
}
.ne-pick-item:hover, .ne-pick-item.on { background: rgba(123,127,178,0.12); }
.ne-pick-type {
  flex-shrink: 0; font-size: 9px; font-weight: 700; line-height: 15px;
  padding: 0 4px; border-radius: 4px;
  background: rgba(123,127,178,0.16); color: var(--color-primary);
}
.ne-pick-label { font-size: 12.5px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ne-pick-sub { margin-left: auto; font-size: 10.5px; color: var(--text-secondary); opacity: 0.7; white-space: nowrap; }
</style>

<style>
/* 编辑器内部由 ProseMirror 生成，不能用 scoped */
.ne-body .ProseMirror { outline: none; min-height: 24px; }
.ne-body .ProseMirror p { margin: 0.25em 0; }
.ne-body .ProseMirror h1 { font-size: 17px; font-weight: 700; margin: 0.5em 0 0.25em; }
.ne-body .ProseMirror h2 { font-size: 15px; font-weight: 700; margin: 0.45em 0 0.2em; }
.ne-body .ProseMirror h3 { font-size: 14px; font-weight: 600; margin: 0.4em 0 0.2em; }

/* 占位符：空文档第一段显示 */
.ne-body .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left; height: 0; pointer-events: none;
  color: var(--text-secondary); opacity: 0.5;
}

/* 待办列表 */
.ne-body .ProseMirror ul[data-type="taskList"] { list-style: none; padding: 0; margin: 0.3em 0; }
.ne-body .ProseMirror ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 8px; }
.ne-body .ProseMirror ul[data-type="taskList"] li > label { margin-top: 3px; }
.ne-body .ProseMirror ul[data-type="taskList"] li > div { flex: 1; min-width: 0; }
.ne-body .ProseMirror ul[data-type="taskList"] li[data-checked="true"] > div { opacity: 0.45; text-decoration: line-through; }

/* 对象引用 chip：整体选中/删除的原子节点 */
.mind-ref {
  display: inline-flex; align-items: center;
  padding: 0 6px; margin: 0 1px; border-radius: 5px;
  background: rgba(123,127,178,0.14);
  color: #5b5f8c; font-size: 12.5px; font-weight: 500;
  white-space: nowrap; cursor: default;
}
.ne-body .ProseMirror .mind-ref.ProseMirror-selectednode {
  box-shadow: 0 0 0 2px rgba(123,127,178,0.5);
}
</style>
