<template>
  <div class="scrollable-card-layout">
    <div class="scrollable-card-layout__viewport scroll-surface scroll-surface--compact scroll-surface--glass-edges">
      <div v-if="slots.actions" class="scrollable-card-layout__actions">
        <slot name="actions" />
      </div>
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSlots } from 'vue'

const slots = useSlots()
</script>

<style scoped>
.scrollable-card-layout {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.scrollable-card-layout__viewport {
  --scrollbar-overlay-right-offset: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0 -8px;
  padding: 32px 8px 38px;
}

.scrollable-card-layout__actions {
  display: flex;
  align-items: flex-start;
  margin-bottom: 16px;
}

.scrollable-card-layout__viewport :deep(.scrollable-card-layout__empty) {
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--content-secondary);
}

.scrollable-card-layout__viewport :deep(.scrollable-card-layout__empty strong) {
  color: var(--content-primary);
}

.scrollable-card-layout__viewport :deep(.scrollable-card-layout__empty span) {
  max-width: 420px;
  font-size: 12px;
  text-align: center;
}
</style>
