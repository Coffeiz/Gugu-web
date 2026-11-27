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
        {{ t(projectStatusLabelKey(column.key)) }}
      </div>
      <span class="col-count">{{ projects.length }}</span>
    </div>

    <div ref="colBodyRef" class="col-body scroll-surface scroll-surface--compact" data-layout-role="track" data-scroll-viewport>
      <!-- 位移动画统一由 Runtime FLIP 驱动，这里不需要 TransitionGroup 的位置捕获。 -->
      <div class="kanban-card-list">
        <Teleport v-for="project in projects" :key="project.id" to="body" :disabled="!isProjectDetached(String(project.id))">
          <ProjectCard
            v-memo="[project.id, project.status, project.currentStage, project.progress, project.stages, project.doneAt, project._stageBeforeDone, project.fileCount, project.priority, project.name, project.client, project.color, project.startDate, project.deadline, project.version]"
            :project="project"
            data-layout-role="card"
            @click="$emit('card-click', project)"
          />
        </Teleport>
        <button :key="`add-${column.key}`" class="add-card" data-flip-target @click="$emit('add-project', column.key)">
          <Icon name="action.add" :size="20" style="opacity:0.5" />
          <span class="add-card-text">{{ t('projects.add') }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { PROJECT_STATUS_COLORS } from '@/utils/projectColors'
import { onUnmounted, ref, watch, type PropType } from 'vue'
import { runtime } from '@/interaction/runtime'
import Icon from '@/components/common/icons/Icon.vue'
import ProjectCard from './ProjectCard.vue'
import type { Project } from '@/types/project'
import { projectStatusLabelKey } from '@/utils/projectStages'
import { useI18n } from 'vue-i18n'
const { t } = useI18n()

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

const colColor  = PROJECT_STATUS_COLORS[props.column.key] ?? '#9e9fc4'

</script>

<style scoped>
.column {
  display: flex; flex-direction: column;
  padding: var(--page-content-inset) var(--page-content-inset) 0; gap: var(--space-sm);
  min-width: 0; min-height: 0;
  /* 卡片 hover 的外阴影需要越过列的边界绘制；纵向滚动仍由 .col-body 独占。 */
  overflow: visible;
}
.col-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 var(--space-xs); flex-shrink: 0;
}
.col-title { display: flex; align-items: center; gap: var(--space-sm); font-size: 13px; font-weight: 600; color: var(--text-primary); }
.col-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.col-count {
  font-size: 11px; font-weight: 700; color: var(--action-primary);
  background: var(--action-soft); border-radius: 20px;
  padding: var(--space-xs) var(--space-sm); min-width: 22px; text-align: center;
}
.col-body {
  display: flex; flex-direction: column; gap: var(--space-sm);
  flex: 1; overflow-y: auto;
  overflow-anchor: none;
  min-width: 0; box-sizing: border-box;
  overflow-x: hidden;
  /* 滚动视口延伸到列边缘，等量内边距保留卡片原来的位置，并给阴影留出绘制空间。 */
  margin-inline: calc(-1 * var(--page-content-inset));
  padding: var(--space-sm) var(--page-content-inset) var(--page-content-inset);
}
.kanban-card-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  width: 100%;
}
.kanban-card-list-move {
  transition: transform 0.25s cubic-bezier(.22, 1, .36, 1);
}
/* 跟文件库「上传文件」(.fc-upload) 同款：只换边框/文字/背景色，不带外阴影、不抬起 */
.add-card {
  display: flex; align-items: center; justify-content: center; gap: var(--space-xs);
  width: 100%; flex-shrink: 0; min-height: 96px;
  background: var(--inline-action-bg);
  border: 1.5px dashed var(--inline-action-border);
  border-radius: var(--radius-sm);
  corner-shape: round;
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
