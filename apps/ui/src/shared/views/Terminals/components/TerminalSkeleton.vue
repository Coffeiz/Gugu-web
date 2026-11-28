<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import SkeletonBlock from '@/components/common/feedback/skeleton/SkeletonBlock.vue'

defineProps({ showContent: { type: Boolean, default: true } })
const { t } = useI18n()
</script>

<template>
  <div class="terminals-page terminal-skeleton" role="status" :aria-label="t('common.status.loading')">
    <div class="terminal-list terminal-panel glass-card" aria-hidden="true">
      <div v-for="item in showContent ? 2 : 0" :key="item" class="terminal-skeleton-row">
        <SkeletonBlock class="terminal-skeleton-icon" />
        <div class="terminal-skeleton-copy">
          <SkeletonBlock style="--skeleton-width: 76%" />
          <SkeletonBlock style="--skeleton-width: 50%; --skeleton-height: 8px" />
        </div>
      </div>
      <div v-if="showContent" class="terminal-skeleton-row terminal-skeleton-add">
        <SkeletonBlock style="--skeleton-width: 76px" />
      </div>
    </div>
    <div class="terminal-main terminal-panel glass-card" aria-hidden="true">
      <div v-if="showContent" class="terminal-main-head">
        <div class="terminal-skeleton-title">
          <SkeletonBlock style="--skeleton-width: 96px; --skeleton-height: 14px" />
          <SkeletonBlock style="--skeleton-width: 144px; --skeleton-height: 8px" />
        </div>
        <div class="terminal-actions">
          <SkeletonBlock v-for="action in 4" :key="action" class="terminal-skeleton-action" />
        </div>
      </div>
      <div v-if="showContent" class="terminal-skeleton-output">
        <SkeletonBlock style="--skeleton-width: 18%" />
        <SkeletonBlock style="--skeleton-width: 44%" />
        <SkeletonBlock style="--skeleton-width: 31%" />
      </div>
      <div v-if="showContent" class="terminal-input">
        <SkeletonBlock class="terminal-skeleton-command" />
        <SkeletonBlock class="terminal-skeleton-action" />
      </div>
    </div>
  </div>
</template>

<style scoped src="../terminal-layout.css"></style>
<style scoped>
.terminal-skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-height: 50px;
  flex: none;
  padding: 0 var(--space-sm);
  border: 1px solid var(--content-divider);
  border-radius: var(--radius-xs);
}
.terminal-skeleton-add { justify-content: center; }
.terminal-skeleton-icon { --skeleton-width: 28px; --skeleton-height: 28px; flex: none; }
.terminal-skeleton-copy { flex: 1; }
.terminal-skeleton-title, .terminal-skeleton-copy { display: grid; gap: var(--space-xs); }
.terminal-skeleton-action { --skeleton-width: 56px; --skeleton-height: var(--control-height-sm); }
.terminal-skeleton-output {
  flex: 1;
  min-height: 0;
  display: grid;
  align-content: start;
  gap: var(--space-sm);
  padding: var(--page-content-inset);
  background: #101319;
}
.terminal-skeleton-output :deep(.skeleton-block) { background: rgb(255 255 255 / 10%); }
.terminal-skeleton-command { --skeleton-height: var(--control-height-sm); flex: 1; min-width: 0; }
</style>
