<script setup lang="ts">
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'

defineProps<{ active: boolean }>()
defineEmits<{ open: [] }>()
const { t } = useI18n()
</script>

<template>
  <ActionButton
    class="dev-tool-button"
    fit
    variant="secondary"
    :aria-label="t('navigation.devWorkbench')"
    :title="t('navigation.devWorkbench')"
    :aria-current="active ? 'page' : undefined"
    @click="$emit('open')"
  >
    <Icon name="navigation.grid" size="sm" tone="inherit" />
    <span>{{ t('navigation.devTools') }}</span>
  </ActionButton>
</template>

<style scoped>
.dev-tool-button {
  position: absolute;
  inset-inline-start: 0;
  top: 50%;
  translate: 0 -50%;
  pointer-events: auto;
  app-region: no-drag;
  -webkit-app-region: no-drag;
}
.dev-tool-button[aria-current="page"] {
  background: var(--sidebar-item-active);
  border-color: var(--sidebar-item-active-border);
  color: var(--sidebar-item-active-fg);
}
@media (max-width: 760px) {
  .dev-tool-button {
    position: static;
    translate: none;
  }
  .dev-tool-button span { display: none; }
}
</style>
