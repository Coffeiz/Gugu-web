<script setup lang="ts">
import ProjectsPage from '@/views/Projects/index.vue'
</script>

<template>
  <section class="desktop-projects-page" aria-label="项目看板">
    <ProjectsPage />
  </section>
</template>

<style scoped>
.desktop-projects-page { min-width: 0; min-height: 0; height: 100%; }
.desktop-projects-page :deep(.projects-page),
.desktop-projects-page :deep(.kanban) { height: 100%; }
@media (max-width: 760px) {
  .desktop-projects-page { height: auto; min-height: 0; }
  .desktop-projects-page :deep(.kanban) { height: auto; grid-template-columns: 1fr; }
  .desktop-projects-page :deep(.column),
  .desktop-projects-page :deep(.done-col) { min-height: 240px; }
}
</style>
