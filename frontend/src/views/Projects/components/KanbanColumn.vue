<template>
  <div
    ref="columnRef"
    class="column glass-card"
    :data-col-status="column.key"
    :data-column="column.key"
    data-layout-surface
  >
    <div class="col-header">
      <div class="col-title">
        <span class="col-dot" :style="{ background: colColor }"></span>
        {{ column.label }}
      </div>
      <span class="col-count">{{ projects.length }}</span>
    </div>

    <div ref="colBodyRef" class="col-body scroll-surface scroll-surface--compact">
      <!-- 位移动画统一由 Runtime FLIP 驱动，这里不需要 TransitionGroup 的位置捕获。 -->
      <div class="kanban-card-list">
        <Teleport v-for="project in projects" :key="project.id" to="body" :disabled="!isProjectDetached(String(project.id))">
          <ProjectCard
            v-memo="[project.id, project.status, project.currentStage, project.progress, project.stages, project.doneAt, project._stageBeforeDone, project.fileCount, project.priority, project.name, project.client, project.color, project.startDate, project.deadline, project.version]"
            :project="project"
            @click="$emit('card-click', project)"
          />
        </Teleport>
        <button :key="`add-${column.key}`" class="add-card" data-flip-target @click="$emit('add-project', column.key)">
          <svg width="14" height="14" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="opacity:0.5;flex-shrink:0">
            <line x1="11" y1="4" x2="11" y2="18"/><line x1="4" y1="11" x2="18" y2="11"/>
          </svg>
          <span class="add-card-text">新建项目</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch, type PropType } from 'vue'
import { runtime } from '@/interaction/runtime'
import ProjectCard from './ProjectCard.vue'
import type { Project } from '@/types/project'

const props = defineProps({
  column:   { type: Object, required: true },
  projects: { type: Array as PropType<Project[]>, default: () => [] },
  isProjectDetached: { type: Function as PropType<(projectId: string) => boolean>, required: true },
})
defineEmits(['card-click', 'add-project'])
const colBodyRef = ref<HTMLElement | null>(null)
const columnRef = ref<HTMLElement | null>(null)
const columnGeneration = runtime.surfaces.register({
  id: props.column.key,
  type: 'project-column',
  accepts: ['project-card'],
  layout: 'grid',
  element: null,
  viewport: () => colBodyRef.value,
})
watch(columnRef, (element, previous) => {
  const current = runtime.surfaces.get(props.column.key)
  if (current?.generation !== columnGeneration) return
  if (element === null && current.element && current.element !== previous) return
  runtime.surfaces.setElement(props.column.key, element)
}, { flush: 'post' })
onUnmounted(() => {
  if (runtime.surfaces.get(props.column.key)?.generation === columnGeneration) {
    runtime.surfaces.unregister(props.column.key, columnGeneration)
  }
})
// detach 策略专用：卡片被 Runtime 接管（抓起）时要用 <Teleport> 搬去 body，
// 否则源节点只是 visibility:hidden，仍占着列表布局的位置，兄弟卡片没法收位
// （跟 gugu-interaction-runtime demo 的 KanbanBoard.vue 是同一套接线）。

const colColors: Record<string, string> = { pending: '#d46b6b', active: '#c9943a' }
const colColor  = colColors[props.column.key] ?? '#9e9fc4'

</script>

<style scoped>
/* Column background is a product role now. Feed the shared --column-bg into glass-card rather than
   shadowing --surface-glass locally, so Projects / Schedules / Design preview resolve the same value. */
.column {
  --glass-card-background: var(--column-bg);
  --glass-card-background-hover: var(--column-bg);
  display: flex; flex-direction: column;
  padding: 12px 10px; gap: 8px;
  min-width: 0; min-height: 0; overflow: hidden;
}
.col-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 4px; flex-shrink: 0;
}
.col-title { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.col-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.col-count {
  font-size: 11px; font-weight: 700; color: #fff;
  background: rgba(123,127,178,0.42); border-radius: 20px;
  padding: 1px 7px; min-width: 22px; text-align: center;
}
.col-body {
  display: flex; flex-direction: column; gap: 8px;
  flex: 1; overflow-y: auto;
  min-width: 0; box-sizing: border-box;
  overflow-x: hidden;
  /* scroll-surface reserves the gutter before overflow and the global scrollbar contract owns
     width/track/safe inset. Cards therefore never change width when the thumb appears. */
  padding: 2px 6px;
  margin-right: 0;
}
.kanban-card-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.kanban-card-list-move {
  transition: transform 0.25s cubic-bezier(.22, 1, .36, 1);
}
/* 跟文件库「上传文件」(.fc-upload) 同款：只换边框/文字/背景色，不带外阴影、不抬起 */
.add-card {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; flex-shrink: 0; min-height: 96px;
  background: var(--inline-action-bg);
  border: 1.5px dashed var(--inline-action-border);
  border-radius: var(--radius-md);
  corner-shape: squircle;
  color: var(--inline-action-fg);
  cursor: pointer;
  /* transform 由 Runtime FLIP 独占；不能使用 transition: all，
     否则旧的列表位移或 hover 状态会让新建按钮二次进动。 */
  transition: border-color 0.18s, color 0.18s, background 0.18s;
}
.add-card:hover {
  border-color: var(--inline-action-border-hover);
  color: var(--inline-action-fg-hover);
  background: var(--inline-action-bg-hover);
}
.add-card-text { font-size: 11px; font-weight: 600; }
</style>
