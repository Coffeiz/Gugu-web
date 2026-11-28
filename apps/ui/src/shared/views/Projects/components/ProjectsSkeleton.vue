<script setup lang="ts">
import PageSkeleton from '@/components/common/feedback/skeleton/PageSkeleton.vue'
import SkeletonBlock from '@/components/common/feedback/skeleton/SkeletonBlock.vue'

defineProps({ showContent: { type: Boolean, default: true } })
</script>

<template>
  <section v-for="column in 3" :key="column" class="projects-loading-column glass-card">
    <template v-if="showContent">
      <SkeletonBlock style="--skeleton-width: 64px" />
      <PageSkeleton variant="list" :count="3" />
    </template>
  </section>
</template>

<style scoped>
.projects-loading-column { min-width: 0; padding: var(--page-content-inset); display: grid; align-content: start; gap: var(--space-xs); }
</style>
