<template>
  <div class="note-editor" :class="{ compact }">
    <EditorContent class="ne-body" :editor="editor" />

    <!-- 窄口径工具栏：待办/列表/样式，没有 / 菜单（/ 预留给咕咕）、没有正文/标题文字样式
         切换——标题现在是便签卡自己的独立标题区（按区域区分，不是段落样式），这里只管
         正文格式。放在文字下方、贴着底部的操作区，不占在打字区域上头。 -->
    <!-- on 状态额外要求 isFocused：ProseMirror 的选区在焦点挪到别处（比如便签卡的标题
         <input>）之后依然停在原地，光靠 isActive() 会让工具栏显示一个跟当前实际操作对不上
         的「待办/列表已激活」状态——加这层判断，编辑器没焦点就不亮。用手写的 isFocused ref
         （见 onFocus/onBlur），不用 editor.isFocused，避免响应式更新时机跟不上。 -->
    <div class="ne-toolbar" v-if="editor">
      <button class="ne-tool" :class="{ on: isFocused && editor.isActive('taskList') }"
              @mousedown.prevent="editor.chain().focus().toggleTaskList().run()" title="待办">
        <PhCheckSquare :size="13" weight="bold" />
      </button>
      <button class="ne-tool" :class="{ on: isFocused && editor.isActive('bulletList') }"
              @mousedown.prevent="editor.chain().focus().toggleBulletList().run()" title="列表">
        <PhListBullets :size="13" weight="bold" />
      </button>
      <!-- 有序列表跟无序列表放一起，都是"列表"，不该埋进「插入」的二级菜单里 -->
      <button class="ne-tool" :class="{ on: isFocused && editor.isActive('orderedList') }"
              @mousedown.prevent="editor.chain().focus().toggleOrderedList().run()" title="有序列表">
        <PhListNumbers :size="13" weight="bold" />
      </button>
      <div class="ne-style-wrap">
        <button ref="styleBtnRef" class="ne-tool" :class="{ on: stylesOpen || (isFocused && hasAnyMark) }"
                @mousedown.prevent="toggleStylesMenu" title="文字样式">
          <PhTextAa :size="13" weight="bold" />
        </button>
        <!-- 二级菜单：加粗/斜体/删除线/行内代码/链接，2026-07-11 加，成本低的一档先做——
             跟待办/列表分开放，不占常态工具栏的视觉重量。Teleport 到 body：便签卡自己
             overflow:hidden（裁长文字/hover 高光层），弹在卡内会被卡的边界切掉，得跳出去。
             见 mousedown.prevent 挡住失焦——链接输入框例外：它得真的拿到焦点才能打字，
             所以不挡。 -->
        <Teleport to="body">
          <div v-if="stylesOpen" class="ne-style-menu" :style="menuStyle">
            <template v-if="!linkInputOpen">
              <button class="ne-style-item" :class="{ on: editor.isActive('bold') }"
                      @mousedown.prevent="editor.chain().focus().toggleBold().run()" title="加粗">
                <PhTextB :size="13" weight="bold" />
              </button>
              <button class="ne-style-item" :class="{ on: editor.isActive('italic') }"
                      @mousedown.prevent="editor.chain().focus().toggleItalic().run()" title="斜体">
                <PhTextItalic :size="13" weight="bold" />
              </button>
              <button class="ne-style-item" :class="{ on: editor.isActive('strike') }"
                      @mousedown.prevent="editor.chain().focus().toggleStrike().run()" title="删除线">
                <PhTextStrikethrough :size="13" weight="bold" />
              </button>
              <button class="ne-style-item" :class="{ on: editor.isActive('code') }"
                      @mousedown.prevent="editor.chain().focus().toggleCode().run()" title="行内代码">
                <PhCode :size="13" weight="bold" />
              </button>
              <button class="ne-style-item" :class="{ on: editor.isActive('link') }"
                      @mousedown.prevent="onLinkClick" title="链接">
                <PhLink :size="13" weight="bold" />
              </button>
            </template>
            <div v-else class="ne-link-input" @mousedown.stop>
              <input ref="linkInputRef" v-model="linkUrl" placeholder="链接地址"
                     @keydown.enter.prevent="confirmLink" @keydown.escape.prevent="cancelLink" />
              <button class="ne-link-ok" @mousedown.prevent="confirmLink">确定</button>
            </div>
          </div>
        </Teleport>
      </div>
      <div class="ne-insert-wrap">
        <button ref="insertBtnRef" class="ne-tool" :class="{ on: insertOpen || (isFocused && hasAnyBlock) }"
                @mousedown.prevent="toggleInsertMenu" title="插入">
          <PhPlus :size="13" weight="bold" />
        </button>
        <!-- 「插入」二级菜单：代码块/引用块/分割线，2026-07-11 加（中等成本那档）。有序
             列表挪到主工具栏跟无序列表放一起了，不算在这里头。都是一次性动作，选完就
             收起菜单，不像样式那样需要连续切换。同样 Teleport 到 body（原因同「样式」
             菜单：卡片 overflow:hidden 会把它裁掉）。代码块不给手动选语言——交给
             highlightAuto 自动识别，保持跟其它两个一样"点了就直接生效"。 -->
        <Teleport to="body">
          <div v-if="insertOpen" class="ne-insert-menu" :style="insertMenuStyle">
            <button class="ne-insert-item" @mousedown.prevent="insertCodeBlock">
              <PhCodeBlock :size="14" weight="bold" /><span>代码块</span>
            </button>
            <button class="ne-insert-item" @mousedown.prevent="insertBlockquote">
              <PhQuotes :size="14" weight="bold" /><span>引用块</span>
            </button>
            <button class="ne-insert-item" @mousedown.prevent="insertHorizontalRule">
              <PhMinus :size="14" weight="bold" /><span>分割线</span>
            </button>
          </div>
        </Teleport>
      </div>
      <span class="ne-hint">输入 <code>@</code> 引用项目/文件/活动</span>
      <span class="ne-toolbar-actions"><slot name="foot-actions" /></span>
    </div>

    <!-- `@` 引用补全下拉：跟随光标定位 -->
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
import { computed, nextTick, onBeforeUnmount, reactive, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import {
  PhCheckSquare, PhCode, PhCodeBlock, PhLink, PhListBullets, PhListNumbers, PhMinus, PhPlus, PhQuotes,
  PhTextAa, PhTextB, PhTextItalic, PhTextStrikethrough,
} from '@phosphor-icons/vue'
import { docToMarkdown, markdownToDoc, mindExtensions } from '@/composables/useMindEditor'
import { useMindObjectPicker } from '@/composables/useMindObjectPicker'
import { nextZ } from '@/composables/windowz'
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

/** 光标前找 `@关键词`。防误触两条：`@` 前必须是行首或空白（挡住邮箱地址）；
 *  关键词不含空白/再一个 @（对象名带空格的场景靠前缀就能搜到，比误触发划算）。 */
function findTrigger(ed: any): { query: string; from: number; to: number } | null {
  const { from } = ed.state.selection
  const start = Math.max(0, from - 60)
  const before = ed.state.doc.textBetween(start, from, '\n', '￼')
  const m = /(^|[\s￼])@([^\s@]*)$/.exec(before)
  if (!m) return null
  const len = m[2].length + 1   // '@' + 关键词
  return { query: m[2], from: from - len, to: from }
}

function closePicker() {
  picker.open = false
  picker.query = ''
  emptyStreak = 0
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

// 连续无结果自动关面板（防误触兜底：色值、随手打的 @xx 等），继续打字不再骚扰
let emptyStreak = 0
watch([items, loading], () => {
  if (!picker.open || loading.value) return
  if (picker.query && !items.value.length) {
    if (++emptyStreak >= 2) closePicker()
  } else {
    emptyStreak = 0
  }
})

function choose(it: MindRefSuggestItem) {
  const ed = editor.value
  if (!ed) return
  ed.chain().focus()
    .deleteRange({ from: picker.from, to: picker.to })   // 连同 `@关键词` 一起删掉
    .insertContent({ type: 'mindRef', attrs: { refType: it.type, refId: it.id, label: it.label } })
    .insertContent(' ')
    .run()
  closePicker()
}

// 工具栏「on」态要靠这个判断编辑器是不是真的有焦点（见下方 ne-tool 的用法），不直接读
// editor.isFocused——那个值本身没错，但 @tiptap/vue-3 对 focus/blur 触发 Vue 重渲染这件事
// 时机不总是跟得上我们代码里手动调用 commands.focus() 的那一刻，会出现「焦点其实已经在
// 编辑器里了，工具栏却要等下一次交互（比如点一下按钮）才刷新」的情况。onFocus/onBlur 是
// TipTap 自己的回调，在这里手动写一个 ref，不依赖框架封装内部什么时候帮你触发响应式。
const isFocused = ref(false)

// 「样式」二级菜单：加粗/斜体/删除线/行内代码/链接，2026-07-11 加。菜单里的按钮都是
// mousedown.prevent（不失焦，同待办/列表），链接输入框例外——它得真的拿到焦点才能打字，
// 所以点开输入框那一刻编辑器会失焦，靠 linkInputOpen 挡住 onBlur 里顺手关菜单的逻辑。
const stylesOpen = ref(false)
const linkInputOpen = ref(false)
const linkUrl = ref('')
const linkInputRef = ref<HTMLInputElement | null>(null)
const styleBtnRef = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})
const hasAnyMark = computed(() => {
  const ed = editor.value
  if (!ed) return false
  return ed.isActive('bold') || ed.isActive('italic') || ed.isActive('strike')
    || ed.isActive('code') || ed.isActive('link')
})

/** 菜单 Teleport 到 body 后，位置得自己用 fixed 坐标钉在 Aa 按钮下方（同 DatePicker.vue
 *  的 dp-popup 那套：便签卡 overflow:hidden，弹层不跳出去会被卡边界切掉）。 */
function calcMenuStyle() {
  const rect = styleBtnRef.value?.getBoundingClientRect()
  if (!rect) return
  const MENU_W = 176
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_W - 8))
  const base = { position: 'fixed', left: left + 'px', zIndex: String(nextZ()) }
  const spaceBelow = window.innerHeight - rect.bottom
  menuStyle.value = spaceBelow < 60 && rect.top > spaceBelow
    ? { ...base, bottom: (window.innerHeight - rect.top + 4) + 'px' }
    : { ...base, top: (rect.bottom + 4) + 'px' }
}

function toggleStylesMenu() {
  stylesOpen.value = !stylesOpen.value
  if (stylesOpen.value) calcMenuStyle()
  else linkInputOpen.value = false
}

function onLinkClick() {
  const ed = editor.value
  if (!ed) return
  if (ed.isActive('link')) { ed.chain().focus().unsetLink().run(); return }
  linkUrl.value = ''
  linkInputOpen.value = true
  nextTick(() => linkInputRef.value?.focus())
}

function confirmLink() {
  const ed = editor.value
  const url = linkUrl.value.trim()
  linkInputOpen.value = false
  stylesOpen.value = false
  if (!ed || !url) return
  // 没选中文字（光标只是停在某处）：没有可以挂链接 mark 的文字，直接把网址本身插成可点文字
  if (ed.state.selection.empty) {
    ed.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run()
  } else {
    ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }
}

function cancelLink() {
  linkInputOpen.value = false
  editor.value?.commands.focus()
}

// 「插入」二级菜单：代码块/引用块/有序列表/分割线，2026-07-11 加（中等成本那档，块级
// 元素）。都是一次性动作，选完就收起菜单——不像样式那档可能要连续切换好几个。
const insertOpen = ref(false)
const insertBtnRef = ref<HTMLElement | null>(null)
const insertMenuStyle = ref<Record<string, string>>({})

function calcInsertMenuStyle() {
  const rect = insertBtnRef.value?.getBoundingClientRect()
  if (!rect) return
  const MENU_W = 130
  const MENU_H = 150
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_W - 8))
  const base = { position: 'fixed', left: left + 'px', zIndex: String(nextZ()) }
  const spaceBelow = window.innerHeight - rect.bottom
  insertMenuStyle.value = spaceBelow < MENU_H && rect.top > spaceBelow
    ? { ...base, bottom: (window.innerHeight - rect.top + 4) + 'px' }
    : { ...base, top: (rect.bottom + 4) + 'px' }
}

const hasAnyBlock = computed(() => {
  const ed = editor.value
  if (!ed) return false
  return ed.isActive('codeBlock') || ed.isActive('blockquote')
})

function toggleInsertMenu() {
  insertOpen.value = !insertOpen.value
  if (insertOpen.value) calcInsertMenuStyle()
}

// 代码块不给手动选语言，统一交给 highlightAuto 自动识别（见 useMindEditor.ts）——
// 跟下面两个插入动作一样，点了就直接生效，不弹二次确认。
function insertCodeBlock() { editor.value?.chain().focus().toggleCodeBlock().run(); insertOpen.value = false }
function insertBlockquote() { editor.value?.chain().focus().toggleBlockquote().run(); insertOpen.value = false }
function insertHorizontalRule() { editor.value?.chain().focus().setHorizontalRule().run(); insertOpen.value = false }

const editor = useEditor({
  content: markdownToDoc(props.modelValue) as any,
  extensions: mindExtensions(props.placeholder) as any,
  // TipTap 的 autofocus:true 默认落在文档开头；便签/捕捉条打开编辑器都是接着写，光标要落在
  // 文字最后面，跟 defineExpose 里那个 focus('end') 保持一致
  autofocus: props.autofocus ? 'end' : false,
  // 无 Markdown 输入规则（2026-07-10 定）：行首 #/- 不触发格式转换，格式只走工具栏——
  // 所见即所得里"看到的是排版、却要敲语法改排版"是自相矛盾的
  enableInputRules: false,
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
  onFocus() { isFocused.value = true },
  onBlur() {
    isFocused.value = false
    if (!linkInputOpen.value) stylesOpen.value = false
    insertOpen.value = false
  },
})

// 外部换了内容（比如切到另一条便签）才重灌，避免把用户正在打的字冲掉
watch(() => props.modelValue, (md) => {
  const ed = editor.value
  if (!ed) return
  if (docToMarkdown(ed.getJSON() as any) === md) return
  ed.commands.setContent(markdownToDoc(md) as any, { emitUpdate: false })
})

/** 点只读预览里第 unitIdx 行（段落/标题/待办项/列表项/有序列表项/代码块，跟
 *  mdToPreviewHtml 的 data-line-unit 同一套计数）进编辑态时，把光标定到那一行内容后面，
 *  不是每次都退回文档末尾。
 *  taskItem/listItem/orderedListItem/codeBlock 算一个单元就不再往里钻——它们内部还嵌着
 *  一层 paragraph（或纯文本），会被重复计数。blockquote 反过来不在这个集合里，故意让它
 *  继续往里钻：一段引用可以有好几行（好几个 paragraph 子节点），每行都要能单独点中，
 *  跟 mdToPreviewHtml 给引用块每段各分一个 data-line-unit 是对应的。 */
function focusAtLineUnit(unitIdx: number) {
  const ed = editor.value
  if (!ed) return
  const LEAF_TYPES = new Set(['paragraph', 'heading', 'taskItem', 'listItem', 'orderedListItem', 'codeBlock'])
  let count = 0
  let target: number | null = null
  ed.state.doc.descendants((node: any, pos: number) => {
    if (target !== null) return false
    if (!LEAF_TYPES.has(node.type.name)) return true
    if (count === unitIdx) { target = pos + node.nodeSize - 1; return false }
    count++
    return false
  })
  ed.commands.focus(target ?? 'end')
}

defineExpose({
  focus: () => editor.value?.commands.focus('end'),
  focusAtLineUnit,
  clear: () => editor.value?.commands.setContent(markdownToDoc('') as any, { emitUpdate: false }),
})

onBeforeUnmount(() => editor.value?.destroy())
</script>

<style scoped>
.note-editor { position: relative; }

.ne-toolbar {
  display: flex; align-items: center; gap: 4px;
  padding: 6px 2px 4px;   /* 挪到正文下方了：上边距隔开文字，下边距接到后面的操作行 */
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
/* 消费方（便签卡的取消/保存等）塞进来的按钮，跟格式工具栏同一行；hint 隐藏时
   （便签卡窄列会隐藏）这里自己兜住 margin-left:auto，不依赖 hint 还在场才能靠右 */
.ne-toolbar-actions { margin-left: auto; flex-shrink: 0; display: flex; align-items: center; gap: 6px; }
.ne-toolbar-actions:empty { display: none; }
.ne-hint code {
  padding: 0 3px; border-radius: 3px;
  background: rgba(123,127,178,0.12); font-size: 10.5px;
}

.ne-style-wrap, .ne-insert-wrap { position: relative; }

/* 跟 NoteCard.vue 里只读态用的 .md-preview 同一套字号/行高/间距，编辑和显示才是同一件事 */
.ne-body { font-size: 13px; line-height: 1.6; color: var(--text-primary); }
.note-editor.compact .ne-body { min-height: 48px; }

/* `@` 补全下拉 */
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

/* 「样式」二级菜单：Teleport 到 body 后不再是宿主的 DOM 后代，scoped 样式够不到，
   跟 DatePicker.vue 的 .dp-popup 同一套处理——位置（position/top/left/z-index）由
   NoteEditor.vue 里 calcMenuStyle() 算好、内联 style 钉死，这里只管外观。 */
.ne-style-menu {
  display: flex; align-items: center; gap: 2px; padding: 4px;
  border-radius: 9px;
  background: rgba(255,255,255,0.96);
  border: 1px solid rgba(255,255,255,0.9);
  box-shadow: 0 8px 26px rgba(60,70,100,0.18);
  backdrop-filter: blur(10px);
}
.ne-style-item {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 24px;
  border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--text-secondary); cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.ne-style-item:hover { background: rgba(123,127,178,0.1); color: var(--color-primary); }
.ne-style-item.on { background: rgba(123,127,178,0.16); color: var(--color-primary); }
.ne-link-input { display: flex; align-items: center; gap: 4px; }
.ne-link-input input {
  width: 160px; height: 24px; padding: 0 8px; box-sizing: border-box;
  border: 1px solid rgba(123,127,178,0.25); border-radius: 6px;
  background: rgba(255,255,255,0.7); outline: none;
  font-size: 12px; font-family: var(--font-sans); color: var(--text-primary);
}
.ne-link-ok {
  flex-shrink: 0; height: 24px; padding: 0 9px;
  border: none; border-radius: 6px; cursor: pointer;
  background: rgba(123,127,178,0.16); color: var(--color-primary);
  font-size: 11.5px; font-weight: 600; font-family: var(--font-sans);
}
.ne-link-ok:hover { background: rgba(123,127,178,0.26); }

/* 「插入」二级菜单：同「样式」菜单，Teleport 到 body 后位置靠内联 style 钉死，
   这里只管外观；竖排文字菜单（不是横排图标条），跟样式菜单视觉上区分开 */
.ne-insert-menu {
  display: flex; flex-direction: column; gap: 1px; padding: 4px; min-width: 116px;
  border-radius: 9px;
  background: rgba(255,255,255,0.96);
  border: 1px solid rgba(255,255,255,0.9);
  box-shadow: 0 8px 26px rgba(60,70,100,0.18);
  backdrop-filter: blur(10px);
}
.ne-insert-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border: none; border-radius: 6px;
  background: transparent; color: var(--text-primary); cursor: pointer;
  font-size: 12.5px; font-family: var(--font-sans); text-align: left;
  transition: background 0.15s;
}
.ne-insert-item:hover { background: rgba(123,127,178,0.1); }
.ne-insert-item svg { flex-shrink: 0; color: var(--text-secondary); }
</style>

<!-- 编辑器内部由 ProseMirror 生成，不能用 scoped。段落/标题/待办/列表/引用 chip 的排版
     规则跟 NoteCard.vue 的 .md-preview 共用同一份文件，两边数值必须一致，
     见 mind-content.css 顶部注释；这里只留编辑态自己独有的东西。 -->
<style src="./mind-content.css"></style>
<style>
.ne-body .ProseMirror { outline: none; min-height: 24px; }

/* 占位符：空文档第一段显示 */
.ne-body .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left; height: 0; pointer-events: none;
  color: var(--text-secondary); opacity: 0.5;
}

/* 引用 chip 被选中时的高亮环，只有编辑态会出现 */
.ne-body .ProseMirror .mind-ref.ProseMirror-selectednode {
  box-shadow: 0 0 0 2px rgba(123,127,178,0.5);
}
</style>
