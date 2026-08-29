<template>
  <!-- 顶部标题模式：非编辑态和编辑态用同一个 span（保持选框不消失），编辑态用 contenteditable -->
  <span
    v-if="header"
    ref="headerRef"
    class="exp-session-title is-header"
    :class="{ 'is-editing': editing }"
    :title="title"
    :contenteditable="editing"
    spellcheck="false"
    @click="!editing && startEdit()"
    @blur="commit"
    @keydown.enter.prevent="commit"
    @keydown.esc.prevent="cancel"
  >{{ title }}</span>
  <!-- 侧边栏模式：编辑态用文件重命名样式（.rename-input-inline），按钮原地变勾选确认。
       侧栏改名只通过铅笔按钮触发（下方 @click.stop），标题区域点击不进入编辑、也不阻止冒泡，
       让点击标题能冒泡到父级 session item 的 onLoadSession 切换会话；仅编辑态阻止冒泡，
       避免点击输入框意外切换会话。 -->
  <span v-else class="exp-session-title-wrap" :class="{ 'is-editing': editing }" @click="editing && $event.stopPropagation()">
    <span v-if="editing" class="rename-sizer">
      <span class="rename-ghost">{{ draft || ' ' }}</span>
      <input
        ref="inputRef"
        v-model="draft"
        class="rename-input-inline"
        :placeholder="title"
        @blur="commit"
        @keydown.enter.prevent="commit"
        @keydown.esc.prevent="cancel"
      />
    </span>
    <span v-else class="exp-session-title" :title="title">{{ title }}</span>
    <button
      class="exp-session-rename-btn"
      :title="editing ? '确认' : '重命名'"
      @mousedown.prevent
      @click.stop="editing ? commit() : startEdit()"
    >
      <PhCheck v-if="editing" :size="11" weight="bold" />
      <PhPencilSimple v-else :size="11" weight="bold" />
    </button>
  </span>
</template>

<script setup lang="ts">
/**
 * 会话标题内联编辑，两种模式：
 * - 侧边栏（header=false，默认）：标题 + 铅笔按钮，点按钮进入编辑（与文件重命名同款交互）。
 * - 顶部标题栏（header=true）：只有标题，单击进入编辑，无按钮；编辑态用 contenteditable 保持
 *   同一个 span 元素，hover/聚焦的选框样式不中断。
 */
import { ref, nextTick } from 'vue'
import { PhCheck, PhPencilSimple } from '@phosphor-icons/vue'

const props = defineProps<{
  title: string
  onRename: (title: string) => void
  /** 顶部标题栏模式：单击标题进入编辑，不显示重命名按钮 */
  header?: boolean
}>()

const editing = ref(false)
const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const headerRef = ref<HTMLElement | null>(null)

async function startEdit() {
  draft.value = props.title
  editing.value = true
  await nextTick()
  if (props.header) {
    // contenteditable：选中全部文本
    const el = headerRef.value
    if (el) {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      el.focus()
    }
  } else {
    inputRef.value?.focus()
    inputRef.value?.select()
  }
}

function commit() {
  if (!editing.value) return
  const trimmed = props.header
    ? (headerRef.value?.innerText ?? '').trim()
    : draft.value.trim()
  editing.value = false
  // 清掉 contenteditable 可能残留的 placeholder
  if (props.header && headerRef.value) headerRef.value.innerText = props.title
  if (trimmed && trimmed !== props.title) props.onRename(trimmed)
}

function cancel() {
  editing.value = false
  if (props.header && headerRef.value) headerRef.value.innerText = props.title
}
</script>

<style scoped>
/* 外层容器：占满可用宽度，标题与按钮并排（侧边栏模式） */
.exp-session-title-wrap {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 2px;
  padding-right: 26px;
  box-sizing: border-box;
}
/* 标题：纯文本，无 hover 浮出效果（侧边栏模式，按内容收缩，wrap 用 flex: 1 撑满） */
.exp-session-title {
  flex: 1; min-width: 0;
  font-size: 12.5px; line-height: 17px; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 顶部标题栏模式：与项目编辑卡标题同款（默认像纯文本，悬停/聚焦浮出编辑框）。
   不强制 flex 增长，由父容器（GuguChatWindow）的 popup-status margin-left:auto 把右侧
   元素推到右边，标题按内容收缩；max-width: 100% 防止标题被外层压缩到选框溢出。 */
.exp-session-title.is-header {
  font-size: 14px; font-weight: 600; line-height: 1.2;
  cursor: text;
  padding: 2px 6px;
  border: 1px solid transparent; border-radius: 6px;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
  display: inline-block;
  max-width: 100%;
  flex: 0 1 auto;  /* 顶部模式：按内容收缩，不主动占满 */
}
.exp-session-title.is-header:hover,
.exp-session-title.is-header.is-editing {
  border-color: rgba(123,127,178,0.35); background: rgba(255,255,255,0.75);
/* 内阴影去 1px 纵向偏移，否则编辑态会把内容下推 1px、跟非编辑态对不齐 */
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.08);
}
.exp-session-title.is-header:focus { outline: none; }
/* 侧边栏编辑态：字号与标题一致，占满剩余宽度（覆盖 global.css 的 .rename-sizer） */
.rename-sizer {
  flex: 1; min-width: 0;
  font-size: 12.5px; line-height: 17px;
}
/* 重命名按钮：跟删除按钮一样，无背景无阴影，hover 时轻微背景 */
.exp-session-rename-btn {
  width: 22px; height: 22px; border-radius: var(--radius-xs); border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0; line-height: 1;
  position: absolute;
  top: 50%; right: 34px;
  transform: translateY(-50%);
  transition: opacity 0.15s, background 0.15s; flex-shrink: 0;
}
.exp-session-rename-btn:hover { background: rgba(123,127,178,0.12); color: var(--text-primary); }
.exp-session-rename-btn svg { display: block; }
/* 编辑态：按钮保持可见（即使光标移开会话项，勾选确认按钮也不会消失） */
.exp-session-title-wrap.is-editing .exp-session-rename-btn { opacity: 1; }
</style>
