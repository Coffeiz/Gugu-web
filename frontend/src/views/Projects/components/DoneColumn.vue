<template>
  <div
    ref="columnRef"
    class="done-col glass-card"
    data-col-status="done"
    data-column="done"
    data-layout-surface
  >
    <div class="col-header">
      <div class="col-title"><span class="col-dot"></span>已完成</div>
      <div class="col-header-right">
        <button class="archived-entry-mini" @click="$emit('open-archived')" title="查看已归档项目">已归档</button>
        <span class="col-count">{{ projects.length }}</span>
      </div>
    </div>
    <div ref="colBodyRef" class="col-body scroll-surface scroll-surface--compact"><DoneLayout ref="doneLayoutRef" :projects="projects" :ownership-version-for="ownershipVersionFor" :is-project-detached="isProjectDetached" @card-click="$emit('card-click', $event)" /></div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch, type PropType } from 'vue'
import { runtime } from '@/interaction/runtime'
import type { Project } from '@/types/project'
import DoneLayout from './done/DoneLayout.vue'

const props = defineProps({
  projects: { type: Array as PropType<Project[]>, default: () => [] },
  ownershipVersionFor: { type: Function as PropType<(projects: Project[]) => number>, required: true },
  isProjectDetached: { type: Function as PropType<(projectId: string) => boolean>, required: true },
})
defineEmits(['card-click', 'open-archived'])
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
.done-col { --glass-card-background: var(--column-bg); --glass-card-background-hover: var(--column-bg); --done-year-chevron-center:10px; --done-year-content-indent:20px; display:flex; flex-direction:column; padding:12px 10px; gap:8px; min-height:0; overflow:hidden; }
.done-col .col-header { display:flex; align-items:center; justify-content:space-between; padding:0 4px; flex-shrink:0; }
.done-col .col-title { display:flex; align-items:center; gap:7px; font-size:13px; font-weight:600; color:var(--text-primary); }
.done-col .col-dot { width:7px; height:7px; border-radius:50%; background:#5a9e88; flex-shrink:0; }
.done-col .col-header-right { display:flex; align-items:center; gap:8px; }
.done-col .col-count { font-size:11px; font-weight:700; color:#fff; background:rgba(123,127,178,.42); border-radius:20px; padding:1px 7px; min-width:22px; text-align:center; }
.done-col .archived-entry-mini { display:flex; align-items:center; padding:2px 8px; border-radius:7px; border:1px solid rgba(0,0,0,.08); background:rgba(255,255,255,.5); color:var(--text-secondary); font-size:11px; font-weight:600; cursor:pointer; }
.done-col .col-body { display:flex; flex-direction:column; gap:2px; flex:1; overflow-y:auto; min-width:0; box-sizing:border-box; overflow-x:hidden; scrollbar-gutter:auto; padding:2px 6px; }
.done-col .done-layout-root { display:flex; flex-direction:column; width:100%; min-width:0; }
.done-col .col-empty { display:flex; align-items:center; justify-content:center; min-height:96px; color:var(--text-secondary); opacity:.4; }
.done-col .recent-done { margin-bottom:10px; }
.done-col .recent-done-label { display:flex; align-items:center; gap:5px; font-size:11px; font-weight:600; color:#5a9e88; padding:0 2px 6px; }
.done-col .month-cards { display:flex; flex-direction:column; gap:6px; padding:4px; box-sizing:border-box; }
.done-col .recent-done .month-cards { border-left:none; margin-left:0; padding:4px 0; }
.done-col .done-card-item { flex:0 0 auto; width:100%; }
.done-col .year-row,.done-col .month-row { display:flex; align-items:center; gap:6px; width:100%; border:0; background:none; cursor:pointer; font-family:var(--font-sans); text-align:left; transition:background .12s; }
.done-col .year-row { padding:4px 6px; border-radius:6px; }
.done-col .month-row { padding:4px 8px; border-radius:7px; }
.done-col .year-row:hover,.done-col .month-row:hover { background:var(--surface-soft-hover); }
/* FlipChevron 组件自带旋转动画与颜色，此处只保留行级布局样式。 */
.done-col .year-label { font-size:12px; font-weight:700; color:var(--content-secondary); flex:1; }
.done-col .year-label.undated { color:var(--content-tertiary); }
.done-col .year-cnt,.done-col .month-cnt { font-size:10px; color:var(--content-tertiary); }
.done-col .month-name { font-size:11px; font-weight:500; color:var(--content-secondary); flex:1; }
.done-col .month-folder { display:grid; grid-template-rows:1fr; overflow:hidden; transform-origin:top; min-height:0; }
.done-col .month-folder[data-layout-open="false"]:not([data-runtime-group-animating="true"]) { height:0; overflow:hidden; }
/* 年组引导线以 year-row 箭头几何中心为锚点。left 是伪元素左边缘，因此用 translateX(-50%)
   把 1px 线的真实中心校准到 10px；子内容从 20px 开始，线右侧保留约 10px 的结构安全间距。 */
.done-col .year-folder { position:relative; min-height:0; overflow:hidden; padding:0 0 0 var(--done-year-content-indent); margin-top:1px; box-sizing:border-box; }
.done-col .year-folder::before { content:''; position:absolute; left:var(--done-year-chevron-center); transform:translateX(-50%); top:0; bottom:0; width:1px; background:var(--done-group-border); pointer-events:none; }
.done-col .year-folder[data-layout-open="false"]:not([data-runtime-group-animating="true"]) { height:0; overflow:hidden; }
.done-col .year-folder[data-layout-open="false"]:not([data-runtime-group-animating="true"]) > .done-group-layout-node { visibility:hidden; }
.done-col .done-card-list-enter-active,.done-col .done-card-list-leave-active { transition:opacity .22s ease; }
.done-col .done-card-list-enter-from,.done-col .done-card-list-leave-to { opacity:0; }
</style>
