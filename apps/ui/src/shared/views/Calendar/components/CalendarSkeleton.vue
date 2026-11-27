<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import SkeletonBlock from '@/components/common/feedback/skeleton/SkeletonBlock.vue'

defineProps({ rows: { type: Number, default: 6 } })
const { t } = useI18n()
</script>

<template>
  <div class="calendar-loading" role="status" :aria-label="t('common.status.loading')"
    :style="{ '--calendar-loading-rows': rows }">
    <div v-for="cell in 7 * rows" :key="cell" class="calendar-loading-cell" aria-hidden="true">
      <SkeletonBlock v-if="cell <= 7 || cell % 3 === 0" style="--skeleton-width: 24px; --skeleton-height: 8px" />
    </div>
  </div>
</template>

<style scoped>
.calendar-loading {
  position: absolute;
  inset: 16px 16px 8px;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  grid-template-rows: repeat(var(--calendar-loading-rows), minmax(0, 1fr));
  border-top: 1px solid var(--content-divider);
  border-left: 1px solid var(--content-divider);
}
.calendar-loading-cell { padding: var(--space-sm); border: solid var(--content-divider); border-width: 0 1px 1px 0; }
</style>
