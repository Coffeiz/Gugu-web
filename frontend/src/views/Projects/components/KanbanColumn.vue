<template>
  <div
    class="column"
    :class="{ 'drag-over': isDragOver }"
    @dragover.prevent="isDragOver = true"
    @dragleave="isDragOver = false"
    @drop.prevent="onDrop"
  >
    <div class="col-header">
      <div class="col-title">
        <span class="col-dot" :style="{ background: colColor }"></span>
        {{ column.label }}
      </div>
      <span class="col-count">{{ projects.length }}</span>
    </div>

    <div class="col-body">
      <ProjectCard
        v-for="project in projects"
        :key="project.id"
        :project="project"
        @click="$emit('card-click', project)"
        @dragstart="(e) => { e.dataTransfer.setData('projectId', project.id) }"
      />
      <div v-if="projects.length === 0" class="col-empty">拖拽项目到此</div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import ProjectCard from './ProjectCard.vue'

const props = defineProps({
  column:   { type: Object, required: true },
  projects: { type: Array, default: () => [] },
})
const emit = defineEmits(['card-click', 'drop-project'])

const isDragOver = ref(false)

const colColors = { pending: '#d46b6b', active: '#c9943a' }
const colColor  = colColors[props.column.key] ?? '#9e9fc4'

function onDrop(e) {
  isDragOver.value = false
  const projectId = Number(e.dataTransfer.getData('projectId'))
  if (projectId) emit('drop-project', { projectId, targetStatus: props.column.key })
}
</script>

<style scoped>
.column {
  display: flex; flex-direction: column;
  background: rgba(255,255,255,0.18);
  border: 1px solid rgba(255,255,255,0.45);
  border-radius: var(--radius-lg);
  corner-shape: squircle;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.7);
  padding: 12px 10px; gap: 8px;
  min-width: 0; min-height: 0; overflow: hidden;
  transition: background 0.15s, box-shadow 0.15s;
}
.column.drag-over {
  background: rgba(123,127,178,0.1);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 0 0 2px rgba(123,127,178,0.3);
}
.col-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 4px; flex-shrink: 0;
}
.col-title { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.col-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.col-count {
  font-size: 11px; font-weight: 600; color: var(--text-secondary);
  background: rgba(0,0,0,0.06); border-radius: 20px;
  padding: 1px 7px; min-width: 22px; text-align: center;
}
.col-body {
  display: flex; flex-direction: column; gap: 8px;
  flex: 1; overflow-y: auto; padding: 2px 6px;
}
.col-body::-webkit-scrollbar { width: 3px; }
.col-body::-webkit-scrollbar-track { background: transparent; margin-top: 8px; margin-bottom: 8px; }
.col-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 99px; }
.col-empty {
  text-align: center; font-size: 12px; color: var(--text-secondary);
  opacity: 0.4; padding: 32px 0; border: 1.5px dashed rgba(0,0,0,0.1);
  border-radius: var(--radius-md); margin-top: 4px;
}
</style>
