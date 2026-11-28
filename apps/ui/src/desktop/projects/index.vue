<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import PageToolbar from '@/components/common/layout/PageToolbar.vue'
import { useUiStore } from '@/stores/ui'
import ProjectsPage from '@/views/Projects/index.vue'

const { t } = useI18n()
const uiStore = useUiStore()
</script>

<template>
  <section class="desktop-projects-page" :aria-label="$t('pageUi.projectBoard')">
    <ProjectsPage>
      <template #toolbar="{ openArchived, openDeleted }">
        <PageToolbar role="group" :aria-label="$t('pageUi.projectToolbar')">
          <ActionButton class="page-toolbar__action" fit @click="uiStore.openNewProject = true">
            <Icon name="action.add" :size="14" />{{ t('common.actions.createProject') }}
          </ActionButton>
          <div class="project-collection-actions">
            <ActionButton fit variant="secondary" :title="t('projects.archivedView')" @click="openArchived">
              {{ t('projects.archivedShort') }}
            </ActionButton>
            <ActionButton fit variant="danger" :title="t('projectsDeleted.deletedView')" @click="openDeleted">
              {{ t('projectsDeleted.deletedShort') }}
            </ActionButton>
          </div>
        </PageToolbar>
      </template>
    </ProjectsPage>
  </section>
</template>

<style scoped>
.desktop-projects-page { min-width: 0; min-height: 0; height: 100%; }
.desktop-projects-page :deep(.projects-page) {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--space-md);
  height: 100%;
}
.project-collection-actions { display: flex; gap: var(--space-xs); }
.desktop-projects-page :deep(.kanban) { height: 100%; gap: var(--space-md); }
@media (max-width: 760px) {
  .desktop-projects-page { height: auto; }
  .desktop-projects-page :deep(.projects-page) { grid-template-rows: auto auto; height: auto; }
  .desktop-projects-page :deep(.kanban) { height: auto; grid-template-columns: 1fr; }
  .desktop-projects-page :deep(.column),
  .desktop-projects-page :deep(.done-col) { min-height: 240px; }
}
</style>
