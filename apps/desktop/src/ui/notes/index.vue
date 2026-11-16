<script setup lang="ts">
import ActionButton from '@/components/common/controls/ActionButton.vue'
import type { NoteRow } from '@/desktop/bridge'
defineProps<{ notes: NoteRow[]; busy: boolean }>()
const noteContent = defineModel<string>('noteContent', { required: true })
const editingNote = defineModel<NoteRow | null>('editingNote', { required: true })
const editedNoteContent = defineModel<string>('editedNoteContent', { required: true })
const emit = defineEmits<{ create: []; update: []; remove: [note: NoteRow] }>()
</script>

<template>
  <section id="desktop-notes" class="desktop-panel glass-card desktop-calendar" aria-labelledby="desktop-notes-title">
    <h2 id="desktop-notes-title" class="section-title">便签 <span>{{ notes.length }}</span></h2>
    <form @submit.prevent="emit('create')"><span id="note-content-label" class="sr-only">便签 Markdown 正文</span><textarea v-model="noteContent" class="form-input" aria-labelledby="note-content-label" maxlength="20000" placeholder="# 便签标题&#10;&#10;记录内容" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存便签</ActionButton></form>
    <ul v-if="notes.length"><li v-for="note in notes" :key="note.id">
      <form v-if="editingNote?.id === note.id" @submit.prevent="emit('update')"><span id="note-edit-label" class="sr-only">便签 Markdown 正文</span><textarea v-model="editedNoteContent" class="form-input" aria-labelledby="note-edit-label" maxlength="20000" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingNote = null">取消</ActionButton></form>
      <template v-else><span>{{ note.contentMd }}</span><small>v{{ note.version }}</small><ActionButton fit variant="secondary" :disabled="busy" @click="editingNote = note; editedNoteContent = note.contentMd">编辑</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="emit('remove', note)">删除</ActionButton></template>
    </li></ul>
    <p v-else class="desktop-empty">这里会保存你的便签。</p>
  </section>
</template>

<style scoped>
.desktop-panel { min-width: 0; margin-top: 24px; padding: 22px 24px; --glass-card-background-hover: var(--glass-card-background); --glass-card-border-hover: var(--glass-card-border); --glass-card-shadow-hover: var(--glass-card-shadow); }
.desktop-panel > h2 { margin: 0 0 18px; }
.desktop-panel h2 span { margin-left: 8px; color: var(--text-secondary); font-size: 12px; font-weight: 500; }
.desktop-panel form { display: flex; gap: 10px; }
.desktop-panel form > .form-input { min-width: 0; width: 100%; }
.desktop-panel textarea.form-input { min-height: 100px; resize: vertical; }
.desktop-panel form > :deep(.app-action-button) { flex-shrink: 0; }
.desktop-panel ul { margin: 20px 0; padding: 0; list-style: none; }
.desktop-panel li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--content-divider); }
.desktop-panel li > span { min-width: 0; overflow-wrap: anywhere; }
.desktop-panel small, .desktop-empty { color: var(--text-secondary); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
</style>
