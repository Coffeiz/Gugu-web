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
        @add-project="openNewWithStatus"
      />
      <DoneColumn
        :projects="columnProjects('done')"
        @card-click="projectStore.openModal"
        @drop-project="handleDrop"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useUiStore } from '@/stores/ui'
import KanbanColumn from './components/KanbanColumn.vue'
import DoneColumn   from './components/DoneColumn.vue'

const projectStore = useProjectStore()
const cacheStore   = useFilesCacheStore()
const uiStore      = useUiStore()

onMounted(() => {
  if (!cacheStore.loaded && !cacheStore.loading) cacheStore.load()
})

// 全局搜索点击项目 → 跳转本页后高亮对应项目卡（不打开编辑弹窗）
watch(() => uiStore.pendingProjectHighlight, (id) => {
  if (id == null) return
  const ms  = uiStore.pendingProjectHighlightMs || 1800        // 缺省 1.8s；新手引导设 5000
  const cls = uiStore.pendingProjectHighlightBreath ? 'onboard-flash' : 'search-flash'  // 引导用「呼吸」动画
  uiStore.pendingProjectHighlight = null
  uiStore.pendingProjectHighlightMs = null
  uiStore.pendingProjectHighlightBreath = false
  _flashProject(id, ms, cls)
}, { immediate: true })

function _flashProject(id, ms = 1800, cls = 'search-flash') {
  let tries = 0
  const tick = () => {
    const el = document.querySelector<HTMLElement>(`[data-project-id="${id}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.style.animationDuration = ms + 'ms'   // 覆盖 CSS 默认时长，让高亮整体持续 ms
      el.classList.add(cls)
      setTimeout(() => { el.classList.remove(cls); el.style.animationDuration = '' }, ms)
    } else if (tries++ < 20) {
      setTimeout(tick, 100)   // 项目卡还没渲染（刚跳转/数据加载中），等一会重试，最多 ~2s
    }
  }
  setTimeout(tick, 100)
}

const nonDoneColumns = computed(() =>
  projectStore.kanbanColumns.filter(c => c.key !== 'done')
)

const liveFileCounts = computed(() => {
  const m = new Map()
  for (const f of cacheStore.allFiles) {
    const pid = f.projectId
    if (pid != null) m.set(pid, (m.get(pid) ?? 0) + 1)
  }
  return m
})

function columnProjects(statusKey) {
  const list = projectStore.projects
    .filter(p => p.status === statusKey)
    // cache 已加载后以前端计数为准（只计根目录文件），避免回退到服务端含文件夹的数字
    .map(p => ({ ...p, fileCount: cacheStore.loaded ? (liveFileCounts.value.get(p.id) ?? 0) : p.fileCount }))
  const prioVal = p => ({ high: 3, medium: 2, low: 1 }[p.priority] ?? 0)
  if (statusKey === 'done')   return list.sort((a, b) => prioVal(b) - prioVal(a) || (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
  if (statusKey === 'active') return list.sort((a, b) => prioVal(b) - prioVal(a) || (a.deadline ?? '').localeCompare(b.deadline ?? '') || a.id - b.id)
  return list.sort((a, b) => prioVal(b) - prioVal(a) || (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.id - b.id)
}

function handleDrop({ projectId, targetStatus }) {
  projectStore.moveProject(projectId, targetStatus)
}

function openNewWithStatus(status) {
  uiStore.newProjectInitStatus = status ?? null
  uiStore.openNewProject = true
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
