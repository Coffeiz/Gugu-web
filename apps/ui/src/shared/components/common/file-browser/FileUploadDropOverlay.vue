<template>
  <Transition name="drop-fade">
    <div v-if="visible" class="drop-overlay" aria-hidden="true">
      <div class="drop-zone-hint">
        <svg width="36" height="36" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 30V16M15 22l7-7 7 7"/><path d="M8 36h28"/>
        </svg>
        <span class="drop-hint">{{ t('filesUi.dropToUpload') }}</span>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
defineProps({ visible: Boolean })
</script>

<style scoped>
/* ── 拖拽遮罩 ── */
.drop-overlay {
  position: absolute; inset: 0; z-index: 50;
  background: color-mix(in srgb, var(--surface-base) 82%, transparent);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  border-radius: inherit;
  corner-shape: inherit;
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.drop-zone-hint {
  display: flex; flex-direction: column; align-items: center; gap: var(--space-sm);
  padding: 40px 60px;
  background: color-mix(in srgb, var(--surface-floating) 90%, transparent);
  border: 2px dashed color-mix(in srgb, var(--action-primary) 45%, transparent); border-radius: 20px;
  color: var(--action-primary);
}
.drop-hint { font-size: 16px; font-weight: 700; color: var(--text-primary); }

.drop-fade-enter-active, .drop-fade-leave-active { transition: opacity 0.18s; }
.drop-fade-enter-from, .drop-fade-leave-to { opacity: 0; }

</style>
