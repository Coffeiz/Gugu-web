<template>
  <div
    class="column"
    :data-col-status="column.key"
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
      />
      <div v-if="projects.length === 0" class="col-empty">拖拽项目到此</div>
      <button class="add-card" @click="$emit('add-project', column.key)">
        <svg width="14" height="14" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="opacity:0.5;flex-shrink:0">
          <line x1="11" y1="4" x2="11" y2="18"/><line x1="4" y1="11" x2="18" y2="11"/>
        </svg>
        <span class="add-card-text">新建项目</span>
      </button>
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
const emit = defineEmits(['card-click', 'drop-project', 'add-project'])

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
  font-size: 11px; font-weight: 700; color: #fff;
  background: rgba(123,127,178,0.42); border-radius: 20px;
  padding: 1px 7px; min-width: 22px; text-align: center;
}
.col-body {
  display: flex; flex-direction: column; gap: 8px;
  flex: 1; overflow-y: auto;
  padding: 2px 6px 2px 6px;
  margin-right: -8px; padding-right: 14px;
  scrollbar-gutter: stable;
}
.col-body::-webkit-scrollbar { width: 3px; }
.col-body::-webkit-scrollbar-track { background: transparent; margin-top: 8px; margin-bottom: 8px; }
.col-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 99px; }
.col-empty {
  text-align: center; font-size: 12px; color: var(--text-secondary);
  opacity: 0.4; padding: 32px 0; border: 1.5px dashed rgba(0,0,0,0.1);
  border-radius: var(--radius-md); margin-top: 4px;
}
.add-card {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  width: 100%; flex-shrink: 0; min-height: 82px;
  background: rgba(255,255,255,0.15);
  border: 1.5px dashed rgba(0,0,0,0.1);
  border-radius: var(--radius-md);
  corner-shape: squircle;
  box-shadow: 0 2px 8px rgba(80,90,110,0.04);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.18s;
}
.add-card:hover {
  border-color: rgba(123,127,178,0.4);
  color: var(--color-primary);
  background: rgba(123,127,178,0.05);
  box-shadow: 0 2px 10px rgba(80,90,110,0.08);
}
.add-card-text { font-size: 11px; font-weight: 600; }
</style>
