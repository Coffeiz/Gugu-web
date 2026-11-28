<template>
  <NoteEditor v-model="text" expand-drawers class="mail-message-editor" :placeholder="$t('pageUi.composeBody')" />
</template>

<script setup lang="ts">
import NoteEditor from '@/views/Mind/components/NoteEditor.vue'

const text = defineModel<string>({ required: true })
</script>

<style scoped>
.mail-message-editor {
  display: flex; flex: 1 0 0; flex-direction: column; min-height: 150px; min-width: 0; max-width: 100%; overflow: hidden;
  border: 1px solid var(--input-border); border-radius: var(--radius-xs); background: var(--input-bg);
}
.mail-message-editor :deep(.ne-body) { flex: 1 1 0; min-height: 0; min-width: 0; overflow: auto; }
.mail-message-editor :deep(.ne-body > div) { display: flex; flex-direction: column; min-height: 100%; }
.mail-message-editor :deep(.ProseMirror) { flex: 1; min-width: 0; overflow-wrap: anywhere; padding: var(--space-md); }
.mail-message-editor :deep(.ne-toolbar:not(.ne-toolbar-floating)) {
  --ne-tool-size: 34px;
  --ne-toolbar-gap: var(--space-xs);
  --ne-drawer-max-width: 186px;
  flex: none; min-width: 0; max-width: 100%; padding: var(--space-sm);
  border-top: 1px solid var(--content-divider);
}
.mail-message-editor :deep(.ne-toolbar-main) {
  flex-basis: 0;
  overflow-x: auto;
  scroll-padding-inline: 16px;
  animation: mail-toolbar-scroll-fade 1s steps(1, end);
  animation-timeline: scroll(self inline);
}
@keyframes mail-toolbar-scroll-fade {
  0% { mask-image: linear-gradient(to right, #000 calc(100% - 16px), transparent); }
  1% { mask-image: linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 16px), transparent); }
  100% { mask-image: linear-gradient(to right, transparent, #000 16px); }
}
.mail-message-editor :deep(.ne-tool svg),
.mail-message-editor :deep(.ne-style-item svg) { width: 16px; height: 16px; }
</style>
