<script setup lang="ts">
import type { PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import SkeletonBlock from './SkeletonBlock.vue'

defineProps({
  variant: { type: String as PropType<'grid' | 'list'>, default: 'grid' },
  collection: String as PropType<'schedules' | 'skills' | 'mcp' | 'files'>,
  count: { type: Number, default: 6 },
})
const { t } = useI18n()
</script>

<template>
  <div class="page-skeleton" :class="collection ? `card-collection--${collection}` : `page-skeleton--${variant}`" role="status" :aria-label="t('common.status.loading')">
    <div v-for="item in count" :key="item" class="skeleton-item" aria-hidden="true">
      <SkeletonBlock v-if="!collection || collection === 'files'" class="skeleton-icon" />
      <div class="skeleton-lines">
        <SkeletonBlock style="--skeleton-width: 72%" />
        <SkeletonBlock style="--skeleton-width: 45%; --skeleton-height: 8px" />
        <SkeletonBlock v-if="collection && collection !== 'files'" class="skeleton-card-body" />
      </div>
      <SkeletonBlock v-if="collection && collection !== 'files'" class="skeleton-card-action" />
    </div>
  </div>
</template>

<style scoped>
.page-skeleton { align-content: start; }
.page-skeleton--grid, .page-skeleton--list { display: grid; gap: 12px; }
.page-skeleton--grid { grid-template-columns: repeat(auto-fit, minmax(min(112px, 100%), 1fr)); }
.skeleton-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--content-divider);
  border-radius: var(--card-radius);
}
.page-skeleton--grid .skeleton-item { flex-direction: column; justify-content: center; min-height: 106px; }
.card-collection--files .skeleton-item { position: relative; flex-direction: column; justify-content: center; min-height: 122px; }
.card-collection--files .skeleton-icon { --skeleton-width: 42px; --skeleton-height: 42px; }
.card-collection--files .skeleton-lines { justify-items: center; }
:is(.card-collection--skills, .card-collection--mcp, .card-collection--schedules) .skeleton-item {
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  min-height: 112px;
  padding: 13px 15px;
}
.card-collection--schedules .skeleton-item { min-height: 154px; }
.card-collection--mcp .skeleton-item { break-inside: avoid; margin-bottom: 12px; }
.skeleton-card-body { --skeleton-height: 24px; }
.skeleton-card-action { --skeleton-height: 10px; --skeleton-width: 52px; align-self: end; }
.skeleton-lines { display: grid; gap: 8px; width: 100%; }
.skeleton-icon { --skeleton-width: 28px; --skeleton-height: 28px; flex: none; }
</style>
