<template>
  <div
    ref="columnRef"
    class="done-col glass-card"
    data-col-status="done"
    data-column="done"
    data-layout-surface
  >
    <div class="col-header">
      <div class="col-title"><span class="col-dot" :style="{ background: PROJECT_STATUS_COLORS.done }"></span>{{ t('projects.done') }}</div>
      <div class="col-header-right">
        <button v-if="showCollectionActions" class="project-collection-entry-mini archived-entry-mini" @click="$emit('open-archived')" :title="t('projects.archivedView')">{{ t('projects.archivedShort') }}</button>
        <button v-if="showCollectionActions" class="project-collection-entry-mini deleted-entry-mini" @click="$emit('open-deleted')" :title="t('projectsDeleted.deletedView')">{{ t('projectsDeleted.deletedShort') }}</button>
        <span class="col-count">{{ projects.length }}</span>
      </div>
    </div>
    <div ref="colBodyRef" class="col-body scroll-surface scroll-surface--compact"><DoneLayout ref="doneLayoutRef" :projects="projects" :ownership-version-for="ownershipVersionFor" :is-project-detached="isProjectDetached" @card-click="$emit('card-click', $event)" /></div>
  </div>
</template>

<script setup lang="ts">
import { PROJECT_STATUS_COLORS } from '@/utils/projectColors'
import { onUnmounted, ref, watch, type PropType } from 'vue'
import { runtime } from '@/interaction/runtime'
import type { Project } from '@/types/project'
import DoneLayout from './done/DoneLayout.vue'
import { useI18n } from 'vue-i18n'

defineProps({
  showCollectionActions: { type: Boolean, default: true },
  projects: { type: Array as PropType<Project[]>, default: () => [] },
  ownershipVersionFor: { type: Function as PropType<(projects: Project[]) => number>, required: true },
  isProjectDetached: { type: Function as PropType<(projectId: string) => boolean>, required: true },
})
defineEmits(['card-click', 'open-archived', 'open-deleted'])
const { t } = useI18n()
const colBodyRef = ref<HTMLElement | null>(null)
const columnRef = ref<HTMLElement | null>(null)
const columnGeneration = runtime.surfaces.register({
  id: 'done',
  type: 'project-column',
  accepts: ['project-card'],
  layout: 'grid',
  element: null,
  viewport: () => colBodyRef.value,
})
watch(columnRef, (element, previous) => {
  const current = runtime.surfaces.get('done')
  if (current?.generation !== columnGeneration) return
  if (element === null && current.element && current.element !== previous) return
  runtime.surfaces.setElement('done', element)
}, { flush: 'post' })
onUnmounted(() => {
  if (runtime.surfaces.get('done')?.generation === columnGeneration) {
    runtime.surfaces.unregister('done', columnGeneration)
  }
})
</script>

<style>
.done-col { --done-year-chevron-center:10px; --done-year-content-indent:20px; display:flex; flex-direction:column; padding: var(--page-content-inset) var(--page-content-inset) 0; gap:var(--space-sm); min-height:0; overflow:hidden; }
.done-col .col-header { display:flex; align-items:center; justify-content:space-between; padding:0 var(--space-xs); flex-shrink:0; }
.done-col .col-title { display:flex; align-items:center; gap:var(--space-sm); font-size:13px; font-weight:600; color:var(--text-primary); }
.done-col .col-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
.done-col .col-header-right { display:flex; align-items:center; gap:var(--space-sm); }
.done-col .col-count { font-size:11px; font-weight:700; color:var(--action-primary); background:var(--action-soft); border-radius:20px; padding:var(--space-xs) var(--space-sm); min-width:22px; text-align:center; }
.done-col .project-collection-entry-mini { display:flex; align-items:center; padding:var(--space-xs) var(--space-sm); border-radius:7px; border:1px solid var(--border-subtle); background:var(--surface-soft); color:var(--text-secondary); font-size:11px; font-weight:600; cursor:pointer; transition:background .15s, color .15s, border-color .15s; }
.done-col .project-collection-entry-mini:hover { background:var(--surface-soft-hover); color:var(--text-primary); }
.done-col .archived-entry-mini {
  color:var(--control-fg);
  border-color:var(--input-border);
  background:var(--control-bg);
}
.done-col .archived-entry-mini:hover {
  color:var(--control-fg-strong);
  border-color:var(--input-border-hover);
  background:var(--control-bg-hover);
}
.done-col .deleted-entry-mini {
  color:var(--status-danger);
  border-color:color-mix(in srgb,var(--status-danger) 30%,var(--border-subtle));
  background:var(--status-danger-bg);
}
.done-col .deleted-entry-mini:hover {
  color:var(--status-danger);
  border-color:var(--status-danger);
  background:color-mix(in srgb,var(--status-danger) 14%,var(--surface-soft));
}
.done-col .col-body { display:flex; flex-direction:column; gap:var(--space-xs); flex:1; overflow-y:auto; min-width:0; box-sizing:border-box; overflow-x:hidden; scrollbar-gutter:auto; margin-inline: calc(-1 * var(--page-content-inset)); padding: var(--space-sm) var(--page-content-inset) var(--page-content-inset); }
.done-col .done-layout-root { display:flex; flex-direction:column; width:100%; min-width:0; }
.done-col .col-empty { display:flex; align-items:center; justify-content:center; min-height:96px; color:var(--text-secondary); opacity:.4; }
.done-col .recent-done { margin-bottom:var(--space-sm); }
.done-col .recent-done-label { display:flex; align-items:center; gap:var(--space-xs); font-size:11px; font-weight:600; color:#5a9e88; padding:0 var(--space-xs) var(--space-xs); }
.done-col .month-cards { display:flex; flex-direction:column; gap:var(--space-xs); padding:var(--space-xs); box-sizing:border-box; }
.done-col .recent-done .month-cards { border-left:none; margin-left:0; padding:var(--space-xs) 0; }
.done-col .done-card-item { flex:0 0 auto; width:100%; }
.done-col .year-row,.done-col .month-row { display:flex; align-items:center; gap:var(--space-xs); width:100%; border:0; background:none; cursor:pointer; font-family:var(--font-sans); text-align:left; transition:background .12s; }
.done-col .year-row { padding:var(--space-xs) var(--space-xs); border-radius:6px; }
.done-col .month-row { padding:var(--space-xs) var(--space-sm); border-radius:7px; }
.done-col .year-row:hover,.done-col .month-row:hover { background:var(--surface-soft-hover); }
/* FlipChevron 组件自带旋转动画与颜色，此处只保留行级布局样式。 */
.done-col .year-label { font-size:12px; font-weight:700; color:var(--content-secondary); flex:1; }
.done-col .year-label.undated { color:var(--content-tertiary); }
.done-col .year-cnt,.done-col .month-cnt { font-size:10px; color:var(--content-tertiary); }
.done-col .month-name { font-size:11px; font-weight:500; color:var(--content-secondary); flex:1; }
.done-col .month-folder { display:grid; grid-template-rows:1fr; transform-origin:top; min-height:0; }
.done-col :is(.month-folder, .year-folder)[data-runtime-group-animating="true"] { overflow:hidden; }
.done-col .month-folder[data-layout-open="false"]:not([data-runtime-group-animating="true"]) { height:0; overflow:hidden; }
.done-col .month-folder[data-layout-open="false"]:not([data-runtime-group-animating="true"]) > .month-cards { display:none; }
.done-col .year-folder { --tree-guide-anchor:var(--done-year-chevron-center); position:relative; min-height:0; padding:0 0 0 var(--done-year-content-indent); margin-top:var(--space-xs); box-sizing:border-box; }
.done-col .year-folder[data-layout-open="false"]:not([data-runtime-group-animating="true"]) { height:0; overflow:hidden; }
.done-col .year-folder[data-layout-open="false"]:not([data-runtime-group-animating="true"]) > .done-group-layout-node { visibility:hidden; }
.done-col .year-folder[data-layout-open="false"]:not([data-runtime-group-animating="true"]) .done-card-item { display:none; }
.done-col .done-card-list-enter-active,.done-col .done-card-list-leave-active { transition:opacity .22s ease; }
.done-col .done-card-list-enter-from,.done-col .done-card-list-leave-to { opacity:0; }
</style>
