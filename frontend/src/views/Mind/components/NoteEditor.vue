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
      <!-- 「样式」抽屉：加粗/斜体/删除线/行内代码/链接，2026-07-11 加。不是弹层——Aa 按钮
           自己向右挪，工具从它左边拉出来（DOM 顺序是 items 在前、按钮在后，抽屉展开就是
           items 从 0 宽长开，把按钮"挤"到右边）；按钮本身就是收起入口，再点一下收回去，
           不需要额外的收起按钮。「样式」「插入」互斥：开一个收起另一个，且要等对方的收起
           动画播完才开（见 toggleStylesMenu/DRAWER_CLOSE_MS）。 -->
      <div class="ne-drawer" :class="{ open: stylesOpen }">
        <div class="ne-drawer-items">
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
        <button class="ne-tool" :class="{ on: stylesOpen || (isFocused && hasAnyMark) }"
                @mousedown.prevent="toggleStylesMenu" title="文字样式">
          <PhTextAa :size="13" weight="bold" />
        </button>
      </div>
      <!-- 「插入」抽屉：代码块/引用块/分割线，2026-07-11 加。有序列表挪到主工具栏跟
           无序列表放一起了，不算在这里头。都是一次性动作，点了直接生效、抽屉自己收起。
           代码块不给手动选语言——交给 highlightAuto 自动识别。 -->
      <div class="ne-drawer" :class="{ open: insertOpen }">
        <div class="ne-drawer-items">
          <button class="ne-style-item" @mousedown.prevent="insertCodeBlock" title="代码块">
            <PhCodeBlock :size="13" weight="bold" />
          </button>
          <button class="ne-style-item" @mousedown.prevent="insertBlockquote" title="引用块">
            <PhQuotes :size="13" weight="bold" />
          </button>
          <button class="ne-style-item" @mousedown.prevent="insertHorizontalRule" title="分割线">
            <PhMinus :size="13" weight="bold" />
          </button>
        </div>
        <button class="ne-tool" :class="{ on: insertOpen || (isFocused && hasAnyBlock) }"
                @mousedown.prevent="toggleInsertMenu" title="插入">
          <PhPlus :size="13" weight="bold" />
        </button>
      </div>
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
  PhCheckSquare, PhCode, PhCodeBlock, PhLink, PhListBullets, PhListNumbers,
  PhMinus, PhPlus, PhQuotes, PhTextAa, PhTextB, PhTextItalic, PhTextStrikethrough,
} from '@phosphor-icons/vue'
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

// 「样式」抽屉：加粗/斜体/删除线/行内代码/链接，2026-07-11 加。菜单里的按钮都是
// mousedown.prevent（不失焦，同待办/列表），链接输入框例外——它得真的拿到焦点才能打字，
// 所以点开输入框那一刻编辑器会失焦，靠 linkInputOpen 挡住 onBlur 里顺手关抽屉的逻辑。
const stylesOpen = ref(false)
const linkInputOpen = ref(false)
const linkUrl = ref('')
const linkInputRef = ref<HTMLInputElement | null>(null)
const hasAnyMark = computed(() => {
  const ed = editor.value
  if (!ed) return false
  return ed.isActive('bold') || ed.isActive('italic') || ed.isActive('strike')
    || ed.isActive('code') || ed.isActive('link')
})

// 「样式」「插入」互斥：只留一个展开（两个抽屉都拉开，卡片宽度装不下）。切换到另一个
// 抽屉时不能两个同时动——先让当前这个收起动画走完（DRAWER_CLOSE_MS，跟 CSS 的
// max-width 收起时长对齐），再开另一个，不然两条抽屉一伸一缩挤在一起会看着很乱。
const DRAWER_CLOSE_MS = 240
let drawerSwitchTimer: ReturnType<typeof setTimeout> | null = null
function clearDrawerSwitchTimer() {
  if (drawerSwitchTimer) { clearTimeout(drawerSwitchTimer); drawerSwitchTimer = null }
}
function toggleStylesMenu() {
  clearDrawerSwitchTimer()
  if (stylesOpen.value) { stylesOpen.value = false; linkInputOpen.value = false; return }
  if (insertOpen.value) {
    insertOpen.value = false
    drawerSwitchTimer = setTimeout(() => { stylesOpen.value = true; drawerSwitchTimer = null }, DRAWER_CLOSE_MS)
  } else {
    stylesOpen.value = true
  }
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

// 「插入」抽屉：代码块/引用块/有序列表/分割线，2026-07-11 加（中等成本那档，块级
// 元素）。都是一次性动作，选完就自己收起抽屉——不像样式那档可能要连续切换好几个。
const insertOpen = ref(false)

const hasAnyBlock = computed(() => {
  const ed = editor.value
  if (!ed) return false
  return ed.isActive('codeBlock') || ed.isActive('blockquote')
})

function toggleInsertMenu() {
  clearDrawerSwitchTimer()
  if (insertOpen.value) { insertOpen.value = false; return }
  if (stylesOpen.value) {
    stylesOpen.value = false
    linkInputOpen.value = false
    drawerSwitchTimer = setTimeout(() => { insertOpen.value = true; drawerSwitchTimer = null }, DRAWER_CLOSE_MS)
  } else {
    insertOpen.value = true
  }
}

// CaptureBar 的「输入 @ 引用…」提示挪到了外层 cb-foot 里（贴着收起按钮），但抽屉展开时
// 仍要让位——这里把状态暴露出去，给 CaptureBar 自己控制提示的显隐。
const anyDrawerOpen = computed(() => stylesOpen.value || insertOpen.value)

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
    clearDrawerSwitchTimer()   // 失焦直接双关，不留一个"马上要开另一个"的挂起计时器
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
  anyDrawerOpen,
})

onBeforeUnmount(() => {
  clearDrawerSwitchTimer()
  editor.value?.destroy()
})
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
/* 消费方（便签卡的取消/保存等）塞进来的按钮，跟格式工具栏同一行——原来这里还兜着
   "输入 @ 引用…" 提示的 margin-left:auto，提示挪到 CaptureBar 自己的 cb-foot 里了 */
.ne-toolbar-actions { margin-left: auto; flex-shrink: 0; display: flex; align-items: center; gap: 6px; }
.ne-toolbar-actions:empty { display: none; }

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

/* 「样式」「插入」抽屉：不是弹层——items 在 DOM 里排在 Aa/+ 按钮前面，收起时 0 宽不占
   位置，按钮就停在原地；展开时 items 从 0 宽长开、天然把按钮"挤"到右边，按钮自己就是
   收起入口（同一个 toggle 函数），不用额外的收起按钮。items 内部 gap 跟主工具栏的按钮
   间距（.ne-toolbar 的 4px）保持一致，看着是同一排按钮在长出来，不是两套间距。
   .ne-drawer 只有展开时才给 4px gap（items／按钮之间）——收起时 items 是 0 宽的空盒子，
   这条 gap 不加，否则按钮会带着一个看不见的 4px 空隙、平时收起态的位置就跟以前对不上。
   宽度用 max-width（不能直接转 width:auto）——220px 比实际内容（5 个 26px 图标）留了余量，
   动画时长按这个上限走，多出来的空间不影响观感。
   缓动统一用 cubic-bezier(0.65,0,0.35,1)——标准的缓入缓出（开头/结尾都慢，中段快），
   不是之前那条 1.2 振幅的回弹曲线（会有一点"冲过头再弹回来"的感觉，跟"抽屉平滑拉开"
   的直觉不太搭）；这个时长（240ms）也是 toggleStylesMenu/toggleInsertMenu 切换抽屉时
   等待收起动画播完的 DRAWER_CLOSE_MS，两边得对上。 */
.ne-drawer { display: inline-flex; align-items: center; gap: 0; transition: gap 0.24s cubic-bezier(0.65,0,0.35,1); }
.ne-drawer.open { gap: 4px; }
.ne-drawer-items {
  display: flex; align-items: center; gap: 4px; overflow: hidden; white-space: nowrap;
  max-width: 0; opacity: 0; filter: blur(4px);
  transition: max-width 0.24s cubic-bezier(0.65,0,0.35,1), opacity 0.16s ease-in-out 0s, filter 0.16s ease-in-out 0s;
}
.ne-drawer.open .ne-drawer-items {
  max-width: 220px; opacity: 1; filter: blur(0);
  transition: max-width 0.24s cubic-bezier(0.65,0,0.35,1), opacity 0.18s ease-in-out 0.07s, filter 0.18s ease-in-out 0.07s;
}
.ne-style-item {
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0; width: 26px; height: 24px;
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
