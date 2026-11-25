<template>
  <div class="chat-drop-overlay" :class="{ 'chat-ref-overlay': kind === 'reference' }">
    <svg v-if="kind === 'reference'" width="30" height="30" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M216,68H133.39l-26-29.29a20,20,0,0,0-15-6.71H40A20,20,0,0,0,20,52V200.62A19.41,19.41,0,0,0,39.38,220H216.89A19.13,19.13,0,0,0,236,200.89V88A20,20,0,0,0,216,68ZM44,56H90.61l10.67,12H44ZM212,196H44V92H212Z" />
    </svg>
    <svg v-else aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 16V6M8 10l4-4 4 4"/>
      <path d="M5 19h14"/>
    </svg>
    <span>{{ t(kind === 'reference' ? 'chat.dropReference' : 'chat.dropAttachment') }}</span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{ kind: 'reference' | 'attachment' }>()
const { t } = useI18n()
</script>

<style scoped>
.chat-drop-overlay {
  position: absolute; inset: 0; z-index: 120;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  pointer-events: none;   /* 让拖拽事件穿透到 .chat-window，drop/dragleave 才能正常触发 */
  background: var(--gugu-chat-drop-bg);
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  border: 2px dashed var(--gugu-chat-drop-border); border-radius: var(--gugu-chat-radius);
  color: var(--action-primary); font-size: 14px; font-weight: 600;
}
</style>
