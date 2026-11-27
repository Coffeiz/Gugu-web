<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import FirstUseEmptyState from '@/components/common/layout/FirstUseEmptyState.vue'
import { useDelayedSkeleton } from '@/composables/core/useDelayedSkeleton'
const props = defineProps({ label: { type: String, default: '' }, delayed: { type: Boolean, default: true } })
const { t } = useI18n()
const visible = useDelayedSkeleton(() => true)
</script>

<template>
  <div class="page-loading-state" :aria-busy="true">
    <FirstUseEmptyState v-if="!props.delayed || visible" class="page-loading-state__content" :title="label || t('common.status.loading')">
      <template #icon><Icon name="resource.marketplace" :size="24" /></template>
    </FirstUseEmptyState>
  </div>
</template>

<style scoped>
.page-loading-state { display: flex; flex: 1 0 auto; align-self: stretch; min-width: 0; min-height: 240px; width: 100%; height: 100%; box-sizing: border-box; }
.page-loading-state__content { flex: 1; }
.page-loading-state :deep(.first-use-empty__icon) { animation: page-loading-breathe 1.4s ease-in-out infinite; }
@keyframes page-loading-breathe { 50% { opacity: .4; } }
@media (prefers-reduced-motion: reduce) { .page-loading-state :deep(.first-use-empty__icon) { animation: none; } }
</style>
