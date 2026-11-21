<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import SkeletonBlock from './SkeletonBlock.vue'

const { t } = useI18n()
const paragraphs = [
  ['96%', '88%', '56%'],
  ['91%', '74%', '83%', '45%'],
  ['84%', '65%'],
]
</script>

<template>
  <div class="note-detail-skeleton" role="status" :aria-label="t('common.status.loading')">
    <div class="note-skeleton-reading" aria-hidden="true">
      <div class="note-skeleton-title"><SkeletonBlock style="--skeleton-width: 48%; --skeleton-height: 22px" /></div>
      <div class="note-skeleton-divider" />
      <div class="note-skeleton-body">
        <div v-for="(paragraph, index) in paragraphs" :key="index" class="note-skeleton-paragraph">
          <SkeletonBlock v-for="(width, line) in paragraph" :key="line"
            :style="{ '--skeleton-width': width, '--skeleton-height': '10px' }" />
        </div>
      </div>
      <div class="note-skeleton-actions">
        <SkeletonBlock v-for="item in 2" :key="item" style="--skeleton-width: 64px; --skeleton-height: 38px" />
      </div>
    </div>
    <div class="note-skeleton-info" aria-hidden="true">
      <SkeletonBlock style="--skeleton-width: 48px" />
      <div v-for="item in 3" :key="item" class="note-skeleton-field">
        <SkeletonBlock style="--skeleton-width: 48px; --skeleton-height: 9px" />
        <SkeletonBlock style="--skeleton-width: 96px; --skeleton-height: 9px" />
      </div>
      <div class="note-skeleton-info-divider" />
      <SkeletonBlock style="--skeleton-width: 48px" />
      <SkeletonBlock style="--skeleton-width: 72px; --skeleton-height: 9px; margin-top: 12px" />
    </div>
  </div>
</template>

<style scoped>
.note-detail-skeleton {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: minmax(0, 1fr) 264px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.note-skeleton-reading {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 20px 28px 10px;
}
.note-skeleton-title { height: 31px; display: flex; align-items: center; }
.note-skeleton-divider, .note-skeleton-info-divider { border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 8%, transparent); }
.note-skeleton-divider { margin: 12px 0 14px; }
.note-skeleton-body { flex: 1; min-height: 0; overflow: hidden; }
.note-skeleton-paragraph { display: grid; gap: 8px; margin-bottom: 18px; }
.note-skeleton-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 12px; }
.note-skeleton-actions > * { flex-shrink: 1; }
.note-skeleton-info {
  min-width: 0;
  padding: 20px 18px;
  border-left: 1px solid color-mix(in srgb, var(--text-primary) 8%, transparent);
}
.note-skeleton-field { display: flex; justify-content: space-between; gap: 10px; margin-top: 14px; }
.note-skeleton-info-divider { margin: 18px 0 14px; }
</style>
