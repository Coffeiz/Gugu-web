<template>
  <button
    class="app-close-button"
    :class="{
      'app-close-button--card-corner': cardCorner,
      'app-close-button--compact': compact,
    }"
    type="button"
    :title="title ?? t('common.actions.close')"
    :aria-label="title ?? t('common.actions.close')"
    @click="$emit('click', $event)"
  >
    <Icon name="action.close" :size="compact ? 12 : 14" />
  </button>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
withDefaults(defineProps<{ title?: string; cardCorner?: boolean; compact?: boolean }>(), {
  cardCorner: false,
  compact: false,
})
const { t } = useI18n()
defineEmits<{ (event: 'click', value: MouseEvent): void }>()
</script>

<style scoped>
.app-close-button--card-corner {
  position: absolute;
  inset-block-start: var(--card-close-inset);
  inset-inline-end: var(--card-close-inset);
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
  border-radius: var(--radius-xs);
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
  border: none;
  border-radius: var(--radius-compact);
  background: transparent;
}
.app-close-button--compact:hover { background: var(--surface-soft-hover); }
@media (prefers-reduced-motion: reduce) {
  .app-close-button { transition: none; }
}
.app-close-button:focus-visible { outline:2px solid var(--action-primary); outline-offset:2px; }
</style>
