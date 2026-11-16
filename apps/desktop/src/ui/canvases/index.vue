<script setup lang="ts">
import ActionButton from '@/components/common/controls/ActionButton.vue'
import type { useDesktopCanvases } from '@/desktop/composables/useDesktopCanvases'

const props = defineProps<{
  panel: ReturnType<typeof useDesktopCanvases>
  busy: boolean
  canUndo: boolean
  canRedo: boolean
}>()
defineEmits<{ undo: []; redo: [] }>()
const {
  canvases, title, editingCanvas, editedTitle, startEdit, create, update, remove,
  selectedCanvasId, items, noteContent, editingItem, editedNoteContent, select,
  createNote, updateNote, moveItem, removeItem,
} = props.panel
</script>

<template>
  <section id="desktop-canvases" class="desktop-panel glass-card" aria-labelledby="desktop-canvases-title">
    <h2 id="desktop-canvases-title" class="section-title">画布 <span>{{ canvases.length }}</span></h2>
    <form @submit.prevent="create"><span id="canvas-title-label" class="sr-only">画布标题</span><input v-model="title" class="form-input" aria-labelledby="canvas-title-label" maxlength="300" placeholder="创建画布" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">新建画布</ActionButton></form>
    <ul v-if="canvases.length"><li v-for="canvas in canvases" :key="canvas.id">
      <form v-if="editingCanvas?.id === canvas.id" @submit.prevent="update"><input v-model="editedTitle" class="form-input" aria-label="画布标题" maxlength="300" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingCanvas = null">取消</ActionButton></form>
      <template v-else><span>{{ canvas.title }}</span><ActionButton fit variant="secondary" :disabled="busy" @click="select(canvas)">{{ selectedCanvasId === canvas.id ? '已打开' : '打开画布' }}</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="startEdit(canvas)">重命名</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="remove(canvas)">删除</ActionButton></template>
    </li></ul>
    <p v-else class="desktop-empty">创建第一个画布。</p>
    <div v-if="selectedCanvasId !== null" class="desktop-canvas-content glass-card" aria-label="画布内容">
      <h3 class="section-title">{{ canvases.find(canvas => canvas.id === selectedCanvasId)?.title }} · 画布便签</h3>
      <form @submit.prevent="createNote"><span id="canvas-note-content-label" class="sr-only">画布便签 Markdown 正文</span><textarea v-model="noteContent" class="form-input" aria-labelledby="canvas-note-content-label" maxlength="20000" placeholder="# 便签标题&#10;&#10;记录内容" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">添加到画布</ActionButton></form>
      <ul v-if="items.length"><li v-for="item in items" :key="item.id">
        <form v-if="item.node.kind === 'canvas_note' && editingItem?.id === item.id" @submit.prevent="updateNote"><span :id="`canvas-note-edit-${item.id}`" class="sr-only">画布便签 Markdown 正文</span><textarea v-model="editedNoteContent" class="form-input" :aria-labelledby="`canvas-note-edit-${item.id}`" maxlength="20000" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingItem = null">取消</ActionButton></form>
        <template v-else><pre>{{ item.node.kind === 'canvas_note' ? item.node.contentMd : item.node.title }}</pre><small>{{ item.node.kind === 'canvas_note' ? `便签 v${item.node.version} · 位置 ${item.x}, ${item.y}` : '关联内容（只读）' }}</small><template v-if="item.node.kind === 'canvas_note'"><ActionButton fit variant="secondary" :disabled="busy" :aria-label="`将便签向左移动，当前 ${item.x}, ${item.y}`" @click="moveItem(item, 'left')">←</ActionButton><ActionButton fit variant="secondary" :disabled="busy" :aria-label="`将便签向右移动，当前 ${item.x}, ${item.y}`" @click="moveItem(item, 'right')">→</ActionButton><ActionButton fit variant="secondary" :disabled="busy" :aria-label="`将便签向上移动，当前 ${item.x}, ${item.y}`" @click="moveItem(item, 'up')">↑</ActionButton><ActionButton fit variant="secondary" :disabled="busy" :aria-label="`将便签向下移动，当前 ${item.x}, ${item.y}`" @click="moveItem(item, 'down')">↓</ActionButton></template><ActionButton v-if="item.node.kind === 'canvas_note'" fit variant="secondary" :disabled="busy" @click="editingItem = item; editedNoteContent = item.node.contentMd">编辑便签</ActionButton><ActionButton v-if="item.node.kind === 'canvas_note'" fit variant="secondary" :disabled="busy" @click="removeItem(item)">从画布移除</ActionButton></template>
      </li></ul>
      <p v-else class="desktop-empty">画布中还没有内容。</p>
    </div>
    <ActionButton v-if="canUndo" fit variant="secondary" :disabled="busy" @click="$emit('undo')">撤销最近便签或画布操作</ActionButton><ActionButton v-if="canRedo" fit variant="secondary" :disabled="busy" @click="$emit('redo')">重做最近便签或画布操作</ActionButton>
  </section>
</template>

<style scoped>
.desktop-panel { min-width: 0; padding: 22px 24px; --glass-card-background-hover: var(--glass-card-background); --glass-card-border-hover: var(--glass-card-border); --glass-card-shadow-hover: var(--glass-card-shadow); }
.desktop-panel > h2 { margin: 0 0 18px; }
.desktop-panel h2 span { margin-left: 8px; color: var(--text-secondary); font-size: 12px; font-weight: 500; }
.desktop-panel form { display: flex; gap: 10px; }
.desktop-panel form > .form-input { min-width: 0; width: 100%; }
.desktop-panel textarea.form-input { min-height: 100px; resize: vertical; }
.desktop-panel form > :deep(.app-action-button) { flex-shrink: 0; }
.desktop-panel ul { margin: 20px 0 0; padding: 0; list-style: none; }
.desktop-panel li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--content-divider); }
.desktop-panel li > span { min-width: 0; overflow-wrap: anywhere; }
.desktop-panel small, .desktop-empty { color: var(--text-secondary); }
.desktop-canvas-content { margin-top: 24px; padding: 20px; --glass-card-background-hover: var(--glass-card-background); --glass-card-border-hover: var(--glass-card-border); --glass-card-shadow-hover: var(--glass-card-shadow); }
.desktop-canvas-content h3 { margin: 0 0 16px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
</style>
