<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import CalendarSkeleton from '@/views/Calendar/components/CalendarSkeleton.vue'
import MailRouteSkeleton from '@/views/Mail/MailRouteSkeleton.vue'
import TerminalSkeleton from '@/views/Terminals/components/TerminalSkeleton.vue'
import ProjectsSkeleton from '@/views/Projects/components/ProjectsSkeleton.vue'
import ScrollableCardLayout from '@/components/common/layout/ScrollableCardLayout.vue'
import PageSkeleton from './PageSkeleton.vue'
import NoteDetailSkeleton from './NoteDetailSkeleton.vue'
import SkeletonBlock from './SkeletonBlock.vue'

defineProps({ routeName: String, desktop: Boolean })
const { t } = useI18n()
</script>

<template>
  <div class="workspace-route-skeleton" :class="{ 'is-desktop': desktop }" role="status" :aria-label="t('common.status.loading')">
    <div v-if="routeName === 'Calendar'" class="calendar-route" aria-hidden="true">
      <div class="route-toolbar glass-card">
        <SkeletonBlock style="--skeleton-width: 184px" />
        <SkeletonBlock style="--skeleton-width: 116px" />
      </div>
      <div class="calendar-route-body">
        <div class="route-calendar-grid glass-card"><CalendarSkeleton /></div>
        <div class="route-panel glass-card">
          <SkeletonBlock style="--skeleton-width: 62%; --skeleton-height: 16px" />
          <SkeletonBlock style="--skeleton-width: 34%" />
          <SkeletonBlock style="--skeleton-width: 54%" />
        </div>
      </div>
    </div>
    <div v-else-if="routeName === 'Projects'" class="projects-route" aria-hidden="true">
      <ProjectsSkeleton />
    </div>
    <div v-else-if="routeName === 'MindNotes'" class="notes-route" aria-hidden="true">
      <div class="route-toolbar glass-card"><SkeletonBlock style="--skeleton-width: 148px" /></div>
      <div class="route-panel glass-card"><PageSkeleton variant="list" :count="5" /></div>
      <NoteDetailSkeleton class="glass-card" />
    </div>
    <div v-else-if="routeName === 'MindCanvas'" class="canvas-route" aria-hidden="true">
      <div class="canvas-route-toolbar glass-card">
        <SkeletonBlock v-for="control in 6" :key="control" class="canvas-route-control" />
      </div>
      <div class="canvas-route-drawer glass-card">
        <SkeletonBlock v-for="control in 2" :key="control" class="canvas-route-control" />
      </div>
    </div>
    <MailRouteSkeleton v-else-if="routeName === 'mail'" aria-hidden="true" />
    <TerminalSkeleton v-else-if="routeName === 'Terminals'" aria-hidden="true" />
    <ScrollableCardLayout v-else-if="['Schedules', 'Skills', 'SkillsHome', 'SkillsMcp'].includes(routeName ?? '')"
      class="card-route" aria-hidden="true">
      <template #actions>
        <SkeletonBlock style="--skeleton-width: var(--toolbar-action-min-width); --skeleton-height: var(--toolbar-compact-control-height)" />
      </template>
      <template v-if="routeName === 'SkillsHome' || routeName === 'Skills'">
        <section v-for="group in 2" :key="group" class="route-skill-group">
          <SkeletonBlock style="--skeleton-width: 76px" />
          <PageSkeleton collection="skills" :count="2" />
        </section>
      </template>
      <PageSkeleton v-else-if="routeName === 'SkillsMcp'" collection="mcp" />
      <PageSkeleton v-else-if="routeName === 'Schedules'" collection="schedules" />
    </ScrollableCardLayout>
    <div v-else class="panel-route" aria-hidden="true">
      <div v-if="routeName === 'Files'" class="route-toolbar glass-card">
        <SkeletonBlock style="--skeleton-width: 144px" />
        <SkeletonBlock style="--skeleton-width: 160px" />
      </div>
      <div class="route-panel glass-card">
        <SkeletonBlock v-if="routeName !== 'Files'" style="--skeleton-width: 100px; --skeleton-height: 28px" />
        <PageSkeleton v-if="routeName === 'Files'" collection="files" />
        <PageSkeleton v-else variant="list" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace-route-skeleton { height: 100%; }
.calendar-route, .panel-route { display: flex; flex-direction: column; gap: var(--space-md); height: 100%; }
.route-toolbar {
  gap: var(--space-xs);
  box-sizing: border-box;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: calc(var(--toolbar-compact-control-height) + 2 * var(--toolbar-inset) + 2px);
  padding: var(--toolbar-inset);
}
.calendar-route-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: var(--space-md);
}
.route-calendar-grid { position: relative; min-width: 0; overflow: hidden; }
.route-panel { flex: 1; min-width: 0; min-height: 0; display: grid; align-content: start; gap: var(--space-lg); padding: var(--page-content-inset); overflow: hidden; }
.projects-route { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-lg); height: calc(100vh - 152px); }
.notes-route {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: 316px minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--space-md);
  height: 100%;
  padding: 0 var(--space-xl) var(--space-xl);
}
.notes-route > .route-toolbar { grid-column: 1 / -1; }
.notes-route > .note-detail-skeleton { grid-column: 2; }
.canvas-route { position: fixed; inset: 0; z-index: 8; background: var(--mind-canvas-bg, #e8ebf3); }
.canvas-route-toolbar, .canvas-route-drawer {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  justify-content: space-evenly;
  border-radius: var(--radius-pill);
}
.canvas-route-toolbar {
  left: calc(50% + var(--sidebar-width) / 2);
  bottom: var(--floating-edge);
  transform: translateX(-50%);
  width: calc(243px + 2 * var(--space-sm) + 2px);
  height: calc(var(--control-md) + 2 * var(--space-sm) + 2px);
}
.canvas-route-drawer {
  right: var(--floating-edge);
  top: 50%;
  transform: translateY(-50%);
  width: var(--canvas-toolbar-height);
  height: calc(var(--canvas-toolbar-height) * 2);
  flex-direction: column;
}
.card-route { height: 100%; }
.route-skill-group { display: grid; gap: var(--space-md); }
.route-skill-group + .route-skill-group { margin-top: var(--space-lg); padding-top: var(--space-lg); border-top: 1px solid var(--content-divider); }
.is-desktop { position: relative; width: 100%; }
.is-desktop .notes-route { padding: 0; }
.is-desktop .canvas-route {
  position: absolute;
  z-index: 1;
  background: var(--glass-card-background);
  overflow: hidden;
}
.is-desktop .canvas-route-toolbar {
  left: 50%;
  bottom: calc(var(--floating-edge) - var(--desktop-workspace-edge) - 1px);
}
.is-desktop .canvas-route-drawer {
  top: calc(50% - (var(--desktop-topbar-height) - var(--desktop-workspace-edge)) / 2);
  right: calc(var(--floating-edge) - var(--desktop-workspace-edge) - 1px);
}
.canvas-route-control { --skeleton-width: 14px; --skeleton-height: 14px; }
</style>
