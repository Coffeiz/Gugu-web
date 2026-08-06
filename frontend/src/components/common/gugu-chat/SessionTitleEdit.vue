<template>
  <!-- 顶部标题模式：编辑态用项目编辑卡标题样式（.header-name-input：默认像纯文本，悬停/聚焦浮出编辑框） -->
  <input
    v-if="header && editing"
    ref="inputRef"
    v-model="draft"
    class="header-name-input"
    :placeholder="title"
    @blur="commit"
    @keydown.enter.prevent="commit"
    @keydown.esc.prevent="cancel"
  />
  <!-- 侧边栏模式：编辑态用文件重命名样式（.rename-input-inline） -->
  <span v-else-if="editing" class="rename-sizer" @click.stop>
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
  <!-- 非编辑态 -->
  <span v-else class="exp-session-title-wrap" @click.stop>
    <span
      class="exp-session-title"
      :class="{ 'is-header': header }"
      :title="title"
      @click="header ? startEdit() : undefined"
    >{{ title }}</span>
    <button
      v-if="!header"
      class="exp-session-rename-btn"
      title="重命名"
      @mousedown.prevent
      @click.stop="startEdit"
    >
      <PhPencilSimple :size="11" weight="bold" />
    </button>
  </span>
</template>

<script setup lang="ts">
/**
 * 会话标题内联编辑，两种模式：
 * - 侧边栏（header=false，默认）：标题 + 铅笔按钮，点按钮进入编辑（与文件重命名同款交互）。
 * - 顶部标题栏（header=true）：只有标题，单击进入编辑，无按钮；编辑态用项目编辑卡标题样式。
 */
import { ref, nextTick } from 'vue'
import { PhPencilSimple } from '@phosphor-icons/vue'

const props = defineProps<{
  title: string
  onRename: (title: string) => void
  /** 顶部标题栏模式：单击标题进入编辑，不显示重命名按钮 */
  header?: boolean
}>()

const editing = ref(false)
const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

async function startEdit() {
  draft.value = props.title
  editing.value = true
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
}

function commit() {
  if (!editing.value) return
  editing.value = false
  const trimmed = draft.value.trim()
  if (trimmed && trimmed !== props.title) props.onRename(trimmed)
}

function cancel() {
  editing.value = false
}
</script>

<style scoped>
/* 外层容器：占满可用宽度，标题与按钮并排 */
.exp-session-title-wrap {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 2px;
}
/* 标题：纯文本，无 hover 浮出效果 */
.exp-session-title {
  flex: 1; min-width: 0;
  font-size: 12.5px; line-height: 17px; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 顶部标题栏模式：与项目编辑卡标题同款（默认像纯文本，悬停/聚焦浮出编辑框） */
.exp-session-title.is-header {
  font-size: 14px; font-weight: 600; line-height: 1.2;
  cursor: text;
  padding: 4px 8px; margin: 0 -8px 0 0;
  border: 1px solid transparent; border-radius: 8px;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.exp-session-title.is-header:hover {
  border-color: rgba(123,127,178,0.35); background: rgba(255,255,255,0.75);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.08);
}
/* 顶部标题编辑态：与项目编辑卡标题同款（默认像纯文本，聚焦浮出编辑框）。
   scoped 样式会覆盖全局 .header-name-input，这里补全完整样式（透明边框/背景 + 聚焦浮出） */
.header-name-input {
  flex: 1; min-width: 0; box-sizing: border-box;
  font-size: 14px; font-weight: 600; line-height: 1.2;
  color: var(--text-primary); font-family: var(--font-sans); outline: none;
  padding: 4px 8px; margin: 0 -8px 0 0;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; caret-color: var(--color-primary);
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.header-name-input::placeholder { color: var(--text-secondary); opacity: 0.45; font-weight: 600; }
.header-name-input:focus {
  border-color: rgba(123,127,178,0.35); background: rgba(255,255,255,0.75);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 0 0 3px rgba(123,127,178,0.08);
}
/* 侧边栏编辑态：字号与标题一致，占满剩余宽度（覆盖 global.css 的 .rename-sizer） */
.rename-sizer {
  flex: 1; min-width: 0;
  font-size: 12.5px; line-height: 17px;
}
/* 重命名按钮：与文件卡按钮同款（.file-card-btn），默认隐藏，整个会话项 hover 时浮现 */
.exp-session-rename-btn {
  position: relative;
  width: 20px; height: 20px; border-radius: 5px; border: none;
  background: rgba(255,255,255,0.78); color: var(--text-secondary);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; opacity: 0; transition: opacity 0.15s, background 0.15s, color 0.15s;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08); flex-shrink: 0;
}
.exp-session-rename-btn::after { content: ''; position: absolute; inset: -2px; }
.exp-session-rename-btn:hover { background: white; color: var(--text-primary); }
.exp-session-rename-btn svg { display: block; }
</style>
