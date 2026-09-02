<template>
  <div class="note-editor" ref="rootRef" :class="{ compact }">
    <div class="ne-body"><EditorContent v-if="editor" :editor="editor" /></div>

    <!-- 窄口径工具栏：待办/列表/样式，没有 / 菜单（/ 预留给咕咕）、没有正文/标题文字样式
         切换——标题现在是便签卡自己的独立标题区（按区域区分，不是段落样式），这里只管
         正文格式。放在文字下方、贴着底部的操作区，不占在打字区域上头。 -->
    <!-- on 状态额外要求 isFocused：ProseMirror 的选区在焦点挪到别处（比如便签卡的标题
         <input>）之后依然停在原地，光靠 isActive() 会让工具栏显示一个跟当前实际操作对不上
         的「待办/列表已激活」状态——加这层判断，编辑器没焦点就不亮。用手写的 isFocused ref
         （见 onFocus/onBlur），不用 editor.isFocused，避免响应式更新时机跟不上。 -->
    <!-- floatToolbar（画布便签用）：工具栏脱出卡片、Teleport 到 body 悬在卡片下方——画布
         便签默认宽度只有 244px，6 个工具图标（待办/列表/有序列表/@/样式/插入）横排最窄
         也要 180px+，再挤上"完成"按钮和窄卡自身的内边距，工具栏必然比卡片本身宽，硬塞
         在卡片内只会溢出。比起把便签整体加宽（会让画布上的密度/比例变掉）或让工具栏在
         卡片内换行（编辑态卡片高度又要跟着抖一截），脱出去悬浮不占卡片宽度更彻底、也不
         用管卡片多窄。Teleport 的 :disabled 由 floatToolbar 控制——非画布场景（笔记页
         时间流/CaptureBar）维持原来"就地渲染"的行为，不引入任何变化。位置靠 rAF 常驻
         循环逐帧读卡片的真实屏幕位置换算（见 updateFloatToolbarPos），不依赖画布相机
         状态——不管画布怎么平移/缩放，工具栏跟着卡片走这件事只取决于卡片此刻真实在
         屏幕哪，跟"谁移动了它"无关，不用另外去接相机变化的事件。 -->
    <Teleport to="body" :disabled="!floatToolbar">
      <div class="ne-toolbar" ref="toolbarRef" v-if="editor"
           :class="{ 'ne-toolbar-floating': floatToolbar, pending: floatToolbar && !editReady }">
        <button class="ne-tool" :class="{ on: isFocused && editor.isActive('taskList') }"
                @mousedown.prevent="editor.chain().focus().toggleTaskList().run()" :title="t('mindEditorUi.task')">
          <PhCheckSquare :size="13" weight="bold" />
        </button>
        <button class="ne-tool" :class="{ on: isFocused && editor.isActive('bulletList') }"
                @mousedown.prevent="editor.chain().focus().toggleBulletList().run()" :title="t('mindEditorUi.bulletList')">
          <PhListBullets :size="13" weight="bold" />
        </button>
        <!-- 有序列表跟无序列表放一起，都是"列表"，不该埋进「插入」的二级菜单里 -->
        <button class="ne-tool" :class="{ on: isFocused && editor.isActive('orderedList') }"
                @mousedown.prevent="editor.chain().focus().toggleOrderedList().run()" :title="t('mindEditorUi.orderedList')">
          <PhListNumbers :size="13" weight="bold" />
        </button>
        <button class="ne-tool" @mousedown.prevent="openReferencePicker" :title="t('mindEditorUi.reference')">
          <PhAt :size="13" weight="bold" />
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
                      @mousedown.prevent="editor.chain().focus().toggleBold().run()" :title="t('mindEditorUi.bold')">
                <PhTextB :size="13" weight="bold" />
              </button>
              <button class="ne-style-item" :class="{ on: editor.isActive('italic') }"
                      @mousedown.prevent="editor.chain().focus().toggleItalic().run()" :title="t('mindEditorUi.italic')">
                <PhTextItalic :size="13" weight="bold" />
              </button>
              <button class="ne-style-item" :class="{ on: editor.isActive('strike') }"
                      @mousedown.prevent="editor.chain().focus().toggleStrike().run()" :title="t('mindEditorUi.strike')">
                <PhTextStrikethrough :size="13" weight="bold" />
              </button>
              <button class="ne-style-item" :class="{ on: editor.isActive('code') }"
                      @mousedown.prevent="editor.chain().focus().toggleCode().run()" :title="t('mindEditorUi.inlineCode')">
                <PhCode :size="13" weight="bold" />
              </button>
              <button class="ne-style-item" :class="{ on: editor.isActive('link') }"
                      @mousedown.prevent="onLinkClick" :title="t('mindEditorUi.link')">
                <PhLink :size="13" weight="bold" />
              </button>
            </template>
            <div v-else class="ne-link-input" @mousedown.stop>
              <input ref="linkInputRef" v-model="linkUrl" :placeholder="t('mindEditorUi.linkAddress')"
                     @keydown.enter.prevent="confirmLink" @keydown.escape.prevent="cancelLink" />
              <button class="ne-link-ok" @mousedown.prevent="confirmLink">{{ t('mindEditorUi.confirm') }}</button>
            </div>
          </div>
          <button class="ne-tool" :class="{ on: stylesOpen || (isFocused && hasAnyMark) }"
                  @mousedown.prevent="toggleStylesMenu" :title="t('mindEditorUi.textStyle')">
            <PhTextAa :size="13" weight="bold" />
          </button>
        </div>
        <!-- 「插入」抽屉：代码块/引用块/分割线，2026-07-11 加。有序列表挪到主工具栏跟
             无序列表放一起了，不算在这里头。都是一次性动作，点了直接生效、抽屉自己收起。
             代码块不给手动选语言——交给 highlightAuto 自动识别。 -->
        <div class="ne-drawer" :class="{ open: insertOpen }">
          <div class="ne-drawer-items">
            <button class="ne-style-item" @mousedown.prevent="insertCodeBlock" :title="t('mindEditorUi.codeBlock')">
              <PhCodeBlock :size="13" weight="bold" />
            </button>
            <button class="ne-style-item" @mousedown.prevent="insertBlockquote" :title="t('mindEditorUi.blockquote')">
              <PhQuotes :size="13" weight="bold" />
            </button>
            <button class="ne-style-item" @mousedown.prevent="insertHorizontalRule" :title="t('mindEditorUi.divider')">
              <PhMinus :size="13" weight="bold" />
            </button>
          </div>
          <button class="ne-tool" :class="{ on: insertOpen || (isFocused && hasAnyBlock) }"
                  @mousedown.prevent="toggleInsertMenu" :title="t('mindEditorUi.insert')">
            <PhPlus :size="13" weight="bold" />
          </button>
        </div>
        <span class="ne-toolbar-actions"><slot name="foot-actions" /></span>
      </div>
    </Teleport>

    <ReferenceSuggestMenu
      :show="picker.open"
      :position="{ left: picker.anchorLeft, top: picker.anchorTop, bottom: picker.anchorBottom }"
      :query="picker.query"
      :items="items"
      :loading="loading"
      :active="active"
      @choose="choose"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import {
  PhAt, PhCheckSquare, PhCode, PhCodeBlock, PhLink, PhListBullets, PhListNumbers,
  PhMinus, PhPlus, PhQuotes, PhTextAa, PhTextB, PhTextItalic, PhTextStrikethrough,
} from '@phosphor-icons/vue'
import { docToMarkdown, markdownToDoc, mindExtensions } from '@/composables/useMindEditor'
import { useMindObjectPicker } from '@/composables/useMindObjectPicker'
import { useMindRefActions } from '@/composables/useMindRefActions'
import ReferenceSuggestMenu from '@/components/common/content/ReferenceSuggestMenu.vue'
import type { MindRefSuggestItem } from '@/services/api'

const { openMindRef } = useMindRefActions()
const { t } = useI18n()

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  compact?: boolean
  autofocus?: boolean
  // 工具栏脱出卡片、悬浮在下方——只有画布便签（卡片窄、工具栏横排装不下）传 true，
  // 笔记页时间流/CaptureBar 都够宽，维持原来"就地渲染"的默认行为。
  floatToolbar?: boolean
  // 呼应 NoteCard.vue 的 nc-edit-pending：光标还没真正落定前，浮动工具栏也要跟着卡片
  // 一起藏起来，见下面 .ne-toolbar-floating.pending 的说明。非浮动模式下这个 prop
  // 不起作用（原有的 :deep(.ne-toolbar) 淡入规则仍然生效）。
  editReady?: boolean
}>(), { placeholder: '写点什么…', compact: false, autofocus: false, floatToolbar: false, editReady: true })

const emit = defineEmits<{
  (e: 'update:modelValue', md: string): void
  (e: 'submit'): void
}>()

const rootRef = ref<HTMLElement | null>(null)
const toolbarRef = ref<HTMLElement | null>(null)

// 浮动工具栏定位：贴着卡片（不是编辑器自己的文字区域，两者高度不一样，画布便签的卡片
// 还有自己的内边距）下方居中悬浮。逐帧用 getBoundingClientRect 重新量卡片此刻的真实
// 屏幕位置——画布相机怎么平移/缩放、便签列表怎么滚动都不用单独处理，工具栏只关心
// "卡片现在到底在屏幕哪"这一件事，跟"是谁移动了它"无关，比反过来订阅相机状态更简单
// 也更不容易漏情况。直接写 DOM style（不经 Vue 响应式），这段循环每帧都跑，绕开每帧
// 一次组件重渲染的开销。
const FLOAT_GAP = 8
let floatRaf = 0
function updateFloatToolbarPos() {
  floatRaf = requestAnimationFrame(updateFloatToolbarPos)
  const root = rootRef.value
  const bar = toolbarRef.value
  if (!root || !bar) return
  // 锚定整张卡片（不是 .note-editor 自己）——.note-editor 只包住文字区域，卡片自己
  // 还有一圈内边距，锚在编辑器上会让工具栏贴得太近，跟卡片本身的视觉呼吸感对不上。
  const anchor = (root.closest('.note-card') as HTMLElement | null) ?? root
  const rect = anchor.getBoundingClientRect()
  const barW = bar.offsetWidth
  const barH = bar.offsetHeight
  // 卡片贴着视口底部时，往下挂会把工具栏推出屏幕——翻到卡片上方去，跟下拉菜单/
  // tooltip 常见的"翻转"处理是同一个道理。
  const flipped = window.innerHeight - rect.bottom < barH + FLOAT_GAP + 4
  const centerX = rect.left + rect.width / 2
  const left = Math.max(barW / 2 + 6, Math.min(window.innerWidth - barW / 2 - 6, centerX))
  const top = flipped ? rect.top - FLOAT_GAP - barH : rect.bottom + FLOAT_GAP
  bar.style.left = `${left}px`
  bar.style.top = `${top}px`
  bar.classList.toggle('flipped', flipped)
}
onMounted(() => { if (props.floatToolbar) updateFloatToolbarPos() })
onBeforeUnmount(() => { if (floatRaf) cancelAnimationFrame(floatRaf) })

const { items, loading, active, search, reset, move } = useMindObjectPicker()
const picker = reactive({ open: false, query: '', from: 0, to: 0, anchorLeft: 0, anchorTop: 0, anchorBottom: 0 })
let lastPickerQuery: string | null = null

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
  lastPickerQuery = null
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
  const box = ed.view.dom.closest('.note-editor')?.getBoundingClientRect()
  const caret = ed.view.coordsAtPos(t.from)
  if (box) {
    picker.anchorLeft = caret.left
    picker.anchorTop = caret.top
    picker.anchorBottom = caret.bottom
  }
  if (lastPickerQuery !== t.query) {
    lastPickerQuery = t.query
    search(t.query)
  }
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

/** 工具栏入口与键入 @ 共用同一补全器；光标紧贴文字时先补空格，避免触发器把它当邮箱/单词。 */
function openReferencePicker() {
  const ed = editor.value
  if (!ed) return
  const { from } = ed.state.selection
  const before = from > 1 ? ed.state.doc.textBetween(from - 1, from, '\n', '￼') : ''
  ed.chain().focus().insertContent(before && !/\s/.test(before) ? ' @' : '@').run()
  nextTick(() => { if (editor.value) syncPicker(editor.value) })
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
// 抽屉时不能两个同时动——先让当前这个收起动画走完（DRAWER_CLOSE_MS）再开另一个，不然
// 两条抽屉一伸一缩挤在一起会看着很乱。收起动画不是单纯的宽度过渡了：图标要从右到左依次
// 抹掉（见 CSS .ne-style-item 的 --stagger-delay），最右边图标先淡出、最左边最后淡出，
// 总时长 = 最大 stagger（4 个间隔 × 30ms）+ 单个图标自己的淡出时长 150ms = 270ms，
// 这个常量必须跟 CSS 里的这两个数字保持一致。
const DRAWER_CLOSE_MS = 270
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
    // 点中对象引用 chip：跳对应对象（项目 Modal / 文件预览下载 / 活动编辑 Modal），
    // 不落光标进普通编辑（原子节点本来也不可编辑内部）
    handleClickOn(_view, _pos, node) {
      if (node.type.name !== 'mindRef') return false
      openMindRef(node.attrs.refType, node.attrs.refId)
      return true
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
  // 从只读态点进编辑态这一刻，卡片高度动画（NoteCard.vue）还没跑完，编辑器这时候量到的
  // coordsAtPos 可能是旧布局下的坐标（比如卡片还锁着收起前的高度）——如果光标落点后面
  // 恰好跟着字面 `@xxx`（没真正选过、不是引用节点）会顺带触发下拉，位置就可能算错，
  // 飘到页面左上角。等浏览器画完这一帧布局稳定了，再照当前光标位置强制重新算一次。
  requestAnimationFrame(() => { if (editor.value) syncPicker(editor.value) })
}

defineExpose({
  focus: () => editor.value?.commands.focus('end'),
  focusAtLineUnit,
  clear: () => editor.value?.commands.setContent(markdownToDoc('') as any, { emitUpdate: false }),
  // NoteCard.vue 的退出编辑收起动画要克隆一份工具栏做淡出快照（spawnToolbarGhost）——
  // floatToolbar 开着时真实工具栏 Teleport 到了 body，不再是卡片的 DOM 后代，
  // `cardEl.querySelector('.ne-toolbar')` 找不到它，得从这里直接把引用递出去。
  getToolbarEl: () => toolbarRef.value,
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
/* 浮动态（画布便签）：脱出卡片本身悬在下方（或翻到上方，见 .flipped），不再是卡片纸面
   的一部分，得自己长一副独立的浮层皮——跟公共引用补全菜单同一套玻璃质感语言，
   两者本来就经常同时出现在屏幕上（点了 @ 工具栏按钮，下拉紧跟着弹出来），视觉上得是
   "同一家子"的东西。left/top 由 updateFloatToolbarPos 逐帧直接写 DOM style（不经这份
   scoped CSS 的任何声明），这里只兜 position:fixed 的定位模式和横向居中用的 transform——
   变换基准点 left 已经在脚本里做过视口边界夹逼，这条 translateX(-50%) 对夹逼后的 left
   值同样适用，不需要因为 .flipped 另外换一条 transform（垂直方向的翻转已经在算 top 的
   时候处理完了，不需要 transform 参与）。用两个类选择器（.ne-toolbar.ne-toolbar-floating）
   而不是单独一个新类名，靠特异度稳赢上面 .ne-toolbar 的 padding，不用操心样式表里两条
   规则谁写在后面。 */
.ne-toolbar.ne-toolbar-floating {
  position: fixed; z-index: 2000; transform: translateX(-50%);
  padding: 5px 6px; border-radius: 10px;
  background: rgba(255,255,255,0.96);
  border: 1px solid rgba(255,255,255,0.9);
  box-shadow: 0 8px 26px rgba(60,70,100,0.18);
  backdrop-filter: blur(10px);
  transition: opacity 0.14s ease-in-out, filter 0.14s ease-in-out;
}
/* 呼应 NoteCard.vue 的 .note-card.nc-edit-pending：光标还没真正落定前先藏起来，避免
   "待办/列表已激活"这类过渡态被看见一瞬。非浮动模式这份状态由父级 :deep(.ne-toolbar)
   接管（工具栏还是卡片的 DOM 后代）；浮动模式下工具栏已经 Teleport 出卡片子树，
   :deep() 的后代选择器够不着它，只能自己接一份等效的。 */
.ne-toolbar-floating.pending { opacity: 0; filter: blur(6px); pointer-events: none; }
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
   的直觉不太搭）。
   图标本身的淡入淡出挪到每个 .ne-style-item 自己身上（不再是 .ne-drawer-items 整体一起
   淡），配合 --stagger-delay 做逐个先后：展开时从左到右依次冒出来（nth-child 数第几个，
   跟视觉顺序一致），收起时从右到左依次抹掉（nth-last-child 数倒数第几个，最右边的先淡
   出）。--stagger-delay 只挂在 opacity/filter 这两个 transition 分量上，不影响 hover 的
   background/color——那两个得保持即时反馈，不能被这层延迟拖慢。
   宽度动画时长（.ne-drawer-items 默认态，收起时用这条）要盖住"最慢那个图标"的淡出总时长
   （4 个间隔 × 30ms + 图标自身 150ms = 270ms）——容器缩太快会在图标还没淡完的时候把它
   硬裁掉，看起来是硬切而不是淡出。这个 270ms 也是 script 里 DRAWER_CLOSE_MS 的来源，
   两边必须对上。 */
.ne-drawer { display: inline-flex; align-items: center; gap: 0; transition: gap 0.27s cubic-bezier(0.65,0,0.35,1); }
.ne-drawer.open { gap: 4px; }
.ne-drawer-items {
  display: flex; align-items: center; gap: 4px; overflow: hidden; white-space: nowrap;
  max-width: 0;
  transition: max-width 0.27s cubic-bezier(0.65,0,0.35,1);
}
.ne-drawer.open .ne-drawer-items { max-width: 220px; }
.ne-style-item {
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0; width: 26px; height: 24px;
  border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--text-secondary); cursor: pointer;
  --stagger-delay: 0s;
  opacity: 0; filter: blur(3px);
  transition: opacity 0.15s ease-in-out var(--stagger-delay),
              filter 0.15s ease-in-out var(--stagger-delay),
              background 0.15s, color 0.15s;
}
.ne-drawer.open .ne-style-item { opacity: 1; filter: blur(0); }
.ne-style-item:hover { background: rgba(123,127,178,0.1); color: var(--color-primary); }
.ne-style-item.on { background: rgba(123,127,178,0.16); color: var(--color-primary); }
/* 展开：从左到右依次出现（nth-child 数正数第几个）*/
.ne-drawer.open .ne-style-item:nth-child(1) { --stagger-delay: 0s; }
.ne-drawer.open .ne-style-item:nth-child(2) { --stagger-delay: 0.03s; }
.ne-drawer.open .ne-style-item:nth-child(3) { --stagger-delay: 0.06s; }
.ne-drawer.open .ne-style-item:nth-child(4) { --stagger-delay: 0.09s; }
.ne-drawer.open .ne-style-item:nth-child(5) { --stagger-delay: 0.12s; }
/* 收起：从右到左依次消失（nth-last-child 数倒数第几个，最右边=倒数第 1 先淡出）*/
.ne-style-item:nth-last-child(1) { --stagger-delay: 0s; }
.ne-style-item:nth-last-child(2) { --stagger-delay: 0.03s; }
.ne-style-item:nth-last-child(3) { --stagger-delay: 0.06s; }
.ne-style-item:nth-last-child(4) { --stagger-delay: 0.09s; }
.ne-style-item:nth-last-child(5) { --stagger-delay: 0.12s; }
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

/* TipTap 生成的分割线没有 .np-hr 类，必须由编辑器自身明确覆盖主题默认的白色边框。 */
.note-editor .ne-body .ProseMirror hr {
  border: 0;
  height: 1px;
  background: var(--note-divider);
}

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
