<template>
  <div class="scrollable-card-layout">
    <PageToolbar v-if="actionLabel || slots.actions" class="scrollable-card-layout__toolbar desktop-page-toolbar">
      <slot name="actions">
        <ActionButton class="page-toolbar__action" fit @click="$emit('action')">
          <Icon name="action.add" :size="14" />{{ actionLabel }}
        </ActionButton>
      </slot>
    </PageToolbar>
    <div class="scrollable-card-layout__panel" :class="[panelClass, { 'glass-card': actionLabel || slots.actions }]">
      <slot name="notice" />
      <div class="scrollable-card-layout__viewport scroll-surface scroll-surface--compact"
        :class="{ 'has-empty': slots.empty }">
        <div v-if="slots.empty" class="scrollable-card-layout__first-use"><slot name="empty" /></div>
        <slot v-else />
      </div>
      <slot name="footer" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSlots } from 'vue'
import ActionButton from '../controls/ActionButton.vue'
import Icon from '../icons/Icon.vue'
import PageToolbar from './PageToolbar.vue'

defineProps({ actionLabel: String, panelClass: String })
defineEmits<{ action: [] }>()

const slots = useSlots()
</script>

<style scoped>
.scrollable-card-layout {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.scrollable-card-layout__toolbar {
  min-height: var(--topbar-height);
  justify-content: flex-start;
  padding: var(--space-xs) var(--space-lg);
  margin-bottom: var(--space-md);
}

.scrollable-card-layout__panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.scrollable-card-layout__panel.glass-card {
  padding-inline: var(--space-lg);
}

.scrollable-card-layout__panel.glass-card > .scrollable-card-layout__viewport {
  padding-block: var(--space-lg);
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
