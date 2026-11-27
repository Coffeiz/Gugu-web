<script setup lang="ts">
import SkeletonBlock from '@/components/common/feedback/skeleton/SkeletonBlock.vue'
</script>

<template>
  <div class="mail-page">
    <div class="mail-columns">
      <div class="mail-folders glass-card">
        <div class="mail-pane-toolbar">
          <SkeletonBlock style="--skeleton-width: 40px; --skeleton-height: 16px" />
          <div class="mail-skeleton-actions">
            <SkeletonBlock v-for="action in 2" :key="action" class="mail-skeleton-button" />
          </div>
        </div>
        <div class="mail-skeleton-sidebar">
          <SkeletonBlock style="--skeleton-width: 104px" />
          <div class="mail-skeleton-accounts">
            <SkeletonBlock style="--skeleton-width: 64px; --skeleton-height: 10px" />
            <SkeletonBlock v-for="entry in 3" :key="entry" style="--skeleton-width: 84%" />
          </div>
        </div>
      </div>
      <div class="mail-list glass-card">
        <div class="mail-pane-toolbar">
          <SkeletonBlock class="mail-skeleton-search" />
          <SkeletonBlock class="mail-skeleton-button" />
        </div>
        <div class="mail-skeleton-messages">
          <SkeletonBlock style="--skeleton-width: 78px" />
          <div v-for="row in 6" :key="row" class="mail-skeleton-message">
            <div class="mail-skeleton-meta">
              <SkeletonBlock style="--skeleton-width: 44%; --skeleton-height: 10px" />
              <SkeletonBlock style="--skeleton-width: 28%; --skeleton-height: 10px" />
            </div>
            <SkeletonBlock style="--skeleton-width: 82%" />
            <SkeletonBlock style="--skeleton-width: 38%; --skeleton-height: 10px" />
          </div>
        </div>
      </div>
      <div class="mail-content glass-card">
        <div class="mail-pane-toolbar">
          <SkeletonBlock style="--skeleton-width: 72px" />
        </div>
        <div class="mail-skeleton-reading">
          <SkeletonBlock style="--skeleton-width: 54%; --skeleton-height: 20px" />
          <SkeletonBlock style="--skeleton-width: 42%" />
          <div class="mail-skeleton-body">
            <SkeletonBlock />
            <SkeletonBlock style="--skeleton-width: 88%" />
            <SkeletonBlock style="--skeleton-width: 64%" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="./mail-layout.css"></style>
<style scoped>
.mail-pane-toolbar, .mail-skeleton-actions, .mail-skeleton-meta {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}
.mail-skeleton-actions { margin-inline-start: auto; }
.mail-skeleton-button { --skeleton-width: 28px; --skeleton-height: 28px; flex: none; }
.mail-skeleton-search { --skeleton-height: 32px; min-width: 0; }
.mail-skeleton-sidebar, .mail-skeleton-messages, .mail-skeleton-reading {
  display: grid;
  align-content: start;
  gap: var(--space-md);
  min-height: 0;
  padding: var(--page-content-inset);
  overflow: hidden;
}
.mail-skeleton-accounts, .mail-skeleton-message, .mail-skeleton-body {
  display: grid;
  gap: var(--space-sm);
}
.mail-skeleton-accounts { border-top: 1px solid var(--content-divider); padding-top: var(--space-md); }
.mail-skeleton-message {
  gap: var(--space-xs);
  padding-block: var(--space-sm);
  border-bottom: 1px solid var(--content-divider);
}
.mail-skeleton-meta { justify-content: space-between; }
</style>
