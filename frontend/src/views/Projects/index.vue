<template>
  <div class="projects-page">
    <div class="kanban">
      <KanbanColumn
        v-for="col in nonDoneColumns"
        :key="col.key"
        :column="col"
        :projects="columnProjects(col.key)"
        :animate-cards="kanbanCardsReady"
        @card-click="projectStore.openModal"
        @drop-project="handleDrop"
        @add-project="openNewWithStatus"
      />
      <DoneColumn
        ref="doneColumnRef"
        :projects="columnProjects('done')"
        @card-click="projectStore.openModal"
        @drop-project="handleDrop"
        @open-archived="showArchived = true"
      />
    </div>

    <ArchivedProjectsModal :show="showArchived" @close="showArchived = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { showAppError } from '@/composables/useAppToast'
import { useProjectStore } from '@/stores/projects'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useUiStore } from '@/stores/ui'
import KanbanColumn from './components/KanbanColumn.vue'
import DoneColumn   from './components/DoneColumn.vue'
import ArchivedProjectsModal from './components/ArchivedProjectsModal.vue'
import { doneLayoutMutationKey, registerDoneLayoutMutation } from './components/done/doneLayoutBridge'

const projectStore = useProjectStore()
const cacheStore   = useFilesCacheStore()
const uiStore      = useUiStore()
const doneColumnRef = ref<InstanceType<typeof DoneColumn> | null>(null)
const runDoneLayoutMutation = (mutate: () => void | Promise<void>) =>
  doneColumnRef.value?.runLayoutMutation(mutate) ?? Promise.resolve(mutate())
provide(doneLayoutMutationKey, runDoneLayoutMutation)
const unregisterDoneLayoutMutation = registerDoneLayoutMutation(runDoneLayoutMutation)
onUnmounted(unregisterDoneLayoutMutation)

const showArchived = ref(false)
// 项目请求回来时，“新建项目”按钮已经作为 TransitionGroup 子项挂在列表顶部；同一轮
// patch 把项目卡插到它前面，会被 Vue 误判为重排而从顶部 FLIP 下落。首批项目实际绘制
// 完成一帧后才开放 move 动画，之后的拖拽/增删仍保留正常让位。
const kanbanCardsReady = ref(false)
watch(() => projectStore.projectsLoaded, async loaded => {
  if (!loaded) return
  await nextTick()
  requestAnimationFrame(() => { kanbanCardsReady.value = true })
}, { immediate: true })

watch(() => projectStore.error, (message) => {
  if (!message) return
  showAppError(message)
})
// 打开弹层仍兜底调一次（比如首次预取失败），但已加载过的话 fetchArchivedProjects 内部会直接
// 短路跳过，不会再触发那下「加载中」闪烁——数据早在页面挂载时后台预取好了（见下）。
watch(showArchived, v => { if (v) projectStore.fetchArchivedProjects() })

onMounted(() => {
  if (!cacheStore.loaded && !cacheStore.loading) cacheStore.load()
  // 归档列表页面一进来就后台预取，避免用户点开归档按钮那一下要等网络往返、闪一下「加载中」
  if (!projectStore.archivedLoaded && !projectStore.archivedLoading) projectStore.fetchArchivedProjects()
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

// 按状态分组的项目列表，缓存进 computed——之前是个普通函数，每次父组件重渲染
// （项目移动、liveFileCounts 异步更新，往往是紧挨着的两次独立渲染）都会重新
// filter/map/sort 一遍，且 map() 每次都生成全新的 project 对象。这些新对象配合
// TransitionGroup 的 diff，在某些时机会让 Vue 把同一个 key 的 ProjectCard 实例
// 整个卸载重挂载，而不只是 patch props（实测：拖拽落地动画中途，卡片的 Vue
// 组件会在 <2ms 内 mounted→unmounted 一次，飞行中的克隆因此跟丢了目标元素引用，
// 表现为落地卡在原地不动、直到别的卡片动画结束才瞬间归位）。改成 computed 后，
// 只要 projects/cacheStore.loaded/liveFileCounts 这几个依赖没变，同一轮渲染
// 内多次调用 columnProjects() 用的是同一份缓存结果，同一个 project 对象引用，
// 不会再凭空多出这类相邻渲染间的对象churn。
const columnProjectsMap = computed(() => {
  const prioVal = p => ({ high: 3, medium: 2, low: 1 }[p.priority] ?? 0)
  const grouped = new Map()
  for (const p of projectStore.projects) {
    const list = grouped.get(p.status) ?? []
    // cache 已加载后以前端计数为准（只计根目录文件），避免回退到服务端含文件夹的数字
    list.push({ ...p, fileCount: cacheStore.loaded ? (liveFileCounts.value.get(p.id) ?? 0) : p.fileCount })
    grouped.set(p.status, list)
  }
  for (const [statusKey, list] of grouped) {
    if (statusKey === 'done') list.sort((a, b) => prioVal(b) - prioVal(a) || (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
    else if (statusKey === 'active') list.sort((a, b) => prioVal(b) - prioVal(a) || (a.deadline ?? '').localeCompare(b.deadline ?? '') || a.id - b.id)
    else list.sort((a, b) => prioVal(b) - prioVal(a) || (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.id - b.id)
  }
  return grouped
})

function columnProjects(statusKey) {
  return columnProjectsMap.value.get(statusKey) ?? []
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
}

.kanban {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  height: 100%;
  align-items: stretch;
}
</style>
