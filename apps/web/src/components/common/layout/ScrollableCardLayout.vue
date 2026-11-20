<template>
  <div class="scrollable-card-layout">
    <div class="scrollable-card-layout__viewport scroll-surface scroll-surface--compact"
      :class="{ 'has-empty': slots.empty }">
      <div v-if="slots.actions" class="scrollable-card-layout__actions">
        <slot name="actions" />
      </div>
      <div v-if="slots.empty" class="scrollable-card-layout__first-use"><slot name="empty" /></div>
      <slot v-else />
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

.scrollable-card-layout__viewport.has-empty {
  display: flex;
  flex-direction: column;
}

.scrollable-card-layout__first-use {
  flex: 1 0 auto;
  display: grid;
  place-items: center;
}

.scrollable-card-layout__actions {
  flex: none;
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

</style>
