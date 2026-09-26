<template>
  <button
    class="app-close-button"
    :class="{
      'app-close-button--card-corner': cardCorner,
      'app-close-button--compact': compact,
    }"
    type="button"
    :title="title"
    :aria-label="title"
    @click="$emit('click', $event)"
  >
    <Icon name="action.close" :size="compact ? 11 : 14" />
  </button>
</template>

<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
withDefaults(defineProps<{ title?: string; cardCorner?: boolean; compact?: boolean }>(), {
  title: '关闭',
  cardCorner: false,
  compact: false,
})
defineEmits<{ (event: 'click', value: MouseEvent): void }>()
</script>

<style scoped>
.app-close-button--card-corner {
  position: absolute;
  top: var(--card-close-inset);
  right: var(--card-close-inset);
}
:global(.card-close-anchor) { position: relative; }
.app-close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 var(--control-height-sm);
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  padding: 0;
  border: 1px solid var(--content-divider);
  border-radius: var(--radius-sm);
  background: var(--surface-card-solid);
  color: var(--content-secondary);
  cursor: pointer;
  transition:
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard),
    color var(--motion-hover-control) var(--motion-ease-standard);
}
.app-close-button:hover {
  background: var(--surface-glass-hover);
  border-color: var(--content-divider);
  color: var(--content-primary);
}
.app-close-button--compact {
  flex-basis: var(--control-xs);
  width: var(--control-xs);
  height: var(--control-xs);
  border-radius: var(--radius-xs);
}
.app-close-button:focus-visible { outline:2px solid var(--action-primary); outline-offset:2px; }
</style>
