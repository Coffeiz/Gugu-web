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

    <div ref="colBodyRef" class="col-body">
      <TransitionGroup tag="div" name="kanban-card-list" class="kanban-card-list" :css="!controlled">
        <Teleport v-for="project in projects" :key="project.id" to="body" :disabled="!isDetached(String(project.id))">
          <ProjectCard
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
      </TransitionGroup>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, type PropType } from 'vue'
import { runtime, useRuntimeTransition, useSurface } from '@/interaction/runtime'
import ProjectCard from './ProjectCard.vue'
import type { Project } from '@/types/project'

const props = defineProps({
  column:   { type: Object, required: true },
  projects: { type: Array as PropType<Project[]>, default: () => [] },
})
defineEmits(['card-click', 'add-project'])
const { elementRef: columnRef } = useSurface({
  id: props.column.key,
  type: 'project-column',
  accepts: ['project-card'],
  viewport: () => colBodyRef.value,
})
const colBodyRef = ref<HTMLElement | null>(null)
const { controlled } = useRuntimeTransition(props.column.key)

// detach 策略专用：卡片被 Runtime 接管（抓起）时要用 <Teleport> 搬去 body，
// 否则源节点只是 visibility:hidden，仍占着列表布局的位置，兄弟卡片没法收位
// （跟 gugu-interaction-runtime demo 的 KanbanBoard.vue 是同一套接线）。
// Owner 是框架无关的 reactive(Map)，要显式订阅才能驱动 Teleport 的 disabled。
const ownershipVersion = ref(0)
const stopOwnershipSubscription = runtime.owner.subscribe(() => {
  ownershipVersion.value += 1
})
onUnmounted(stopOwnershipSubscription)

function isDetached(projectId: string): boolean {
  ownershipVersion.value
  return runtime.owner.isControlled(projectId)
}

const colColors: Record<string, string> = { pending: '#d46b6b', active: '#c9943a' }
const colColor  = colColors[props.column.key] ?? '#9e9fc4'

</script>

<style scoped>
/* 玻璃质感（background/border/圆角/box-shadow/backdrop-filter）走全局 .glass-card；
   看板列比 --glass-bg 标准的大面板值（0.56）更透，覆盖成看板专用的 0.25，且不跟随
   .glass-card:hover 变亮（悬停/拖拽状态另有 .drag-over own 语义，不该被通用 hover 抢）。 */
.column {
  --glass-bg: rgba(255,255,255,0.25);
  --glass-bg-hover: rgba(255,255,255,0.25);
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
  /* 固定预留滚动条空间：内容跨过溢出阈值时，卡片宽度不能被动态挤窄。overlay 是
     非标准属性，系统设为始终显示滚动条时仍会退化成 auto。 */
  scrollbar-gutter: stable;
  padding: 2px 6px;
  margin-right: 0;
}
.col-body::-webkit-scrollbar { width: 3px; }
.col-body::-webkit-scrollbar-track { background: transparent; margin-top: 8px; margin-bottom: 8px; }
.col-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 99px; }
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
  background: rgba(255,255,255,0.15);
  border: 1.5px dashed rgba(0,0,0,0.1);
  border-radius: var(--radius-md);
  corner-shape: squircle;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.18s;
}
.add-card:hover {
  border-color: rgba(123,127,178,0.35);
  color: var(--color-primary);
  background: rgba(255,255,255,0.3);
}
.add-card-text { font-size: 11px; font-weight: 600; }
</style>
