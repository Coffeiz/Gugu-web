<template>
  <div class="projects-page">
    <div class="kanban">
      <KanbanColumn
        v-for="col in nonDoneColumns"
        :key="col.key"
        :column="col"
        :projects="columnProjects(col.key)"
        @card-click="projectStore.openModal"
        @drop-project="handleDrop"
      />
      <DoneColumn
        :projects="columnProjects('done')"
        @card-click="projectStore.openModal"
        @drop-project="handleDrop"
      />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useProjectStore } from '@/stores/projects'
import KanbanColumn from './components/KanbanColumn.vue'
import DoneColumn   from './components/DoneColumn.vue'

const projectStore = useProjectStore()

const nonDoneColumns = computed(() =>
  projectStore.kanbanColumns.filter(c => c.key !== 'done')
)

function columnProjects(statusKey) {
  return projectStore.projects.filter(p => p.status === statusKey)
}

function handleDrop({ projectId, targetStatus }) {
  projectStore.moveProject(projectId, targetStatus)
}
</script>

<style scoped>
.projects-page {
  height: calc(100vh - 152px);
  display: flex;
  flex-direction: column;
}

.kanban {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  flex: 1;
  min-height: 0;
  align-items: stretch;
}
</style>
