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
import { computed, onMounted } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { useFilesCacheStore } from '@/stores/filesCache'
import KanbanColumn from './components/KanbanColumn.vue'
import DoneColumn   from './components/DoneColumn.vue'

const projectStore = useProjectStore()
const cacheStore   = useFilesCacheStore()

onMounted(() => {
  if (!cacheStore.loaded && !cacheStore.loading) cacheStore.load()
})

const nonDoneColumns = computed(() =>
  projectStore.kanbanColumns.filter(c => c.key !== 'done')
)

const liveFileCounts = computed(() => {
  const m = new Map()
  for (const f of cacheStore.allFiles) {
    if (f.projectId != null) m.set(f.projectId, (m.get(f.projectId) ?? 0) + 1)
  }
  return m
})

function columnProjects(statusKey) {
  const list = projectStore.projects
    .filter(p => p.status === statusKey)
    .map(p => ({ ...p, fileCount: liveFileCounts.value.get(p.id) ?? p.fileCount }))
  if (statusKey === 'done')   return list.sort((a, b) => (b.doneAt   ?? '').localeCompare(a.doneAt   ?? ''))
  if (statusKey === 'active') return list.sort((a, b) => (a.deadline ?? '').localeCompare(b.deadline ?? '') || a.id - b.id)
  return list.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.id - b.id)
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
