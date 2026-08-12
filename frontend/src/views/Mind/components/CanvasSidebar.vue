<template>
  <DrawerShell
    :open="expanded"
    :width="panel === 'projects' ? '284px' : '190px'"
    :panel-class="panel === 'projects' ? 'project-panel' : ''"
    :data-project-drawer-dropzone="expanded && panel === 'projects' ? '' : undefined"
    @pointerdown.stop
  >
    <template #header><div class="cd-head">
      <Transition name="cd-expanded">
        <div v-if="headerVisible" class="cd-expanded-nav">
          <span class="cd-title">{{ panel === 'canvases' ? '画布' : '项目' }}</span>
          <button class="cd-toggle cd-return" title="收起" :disabled="drawerAnimating" @click="togglePanel(panel)"><PhArrowRight :size="18" weight="bold" /></button>
        </div>
      </Transition>
      <Transition name="cd-compact">
        <div v-if="!expanded" class="cd-compact-nav">
        <button class="cd-toggle" title="画布列表" :disabled="drawerAnimating" @click="togglePanel('canvases')"><PhSquaresFour :size="16" weight="bold" /></button>
        <button class="cd-toggle" title="项目素材" :disabled="drawerAnimating" @click="togglePanel('projects')"><PhStack :size="16" weight="bold" /></button>
        </div>
      </Transition>
    </div></template>

    <!-- 两个面板始终挂载、各自在固定宽度下量高度。开关时只换目标尺寸与可见内容，
         不会再出现旧面板尺寸被新面板借用一帧的横向/纵向两段动画。 -->
    <DrawerViewport
      ref="drawerViewportRef"
      :open="expanded"
      :target-height="targetHeight"
      :scroll-key="panel"
      :class="panel === 'canvases' ? 'canvas-viewport' : 'project-viewport'"
    >
      <div class="cd-stage">
        <section class="cd-content-panel canvas-panel" :class="{ visible: visiblePanel === 'canvases' && contentVisible }" :aria-hidden="visiblePanel !== 'canvases'">
          <DrawerTrack class="canvas-track" data-drawer-scroll="canvases">
            <CanvasDrawerContent ref="canvasContentRef" :canvases="canvases" :active-id="activeId" :rename="props.renameCanvas" @create="emit('create')" @open="onOpen" @delete="onDelete" @layout-finished="measurePanel('canvases')" />
          </DrawerTrack>
        </section>

       <section class="cd-content-panel projects-panel" :class="{ visible: visiblePanel === 'projects' && contentVisible }" :aria-hidden="visiblePanel !== 'projects'">
         <div ref="projectListRef" class="cd-list project-list" data-layout-surface="mind:drawer:projects">
           <SearchInput v-model="projectQuery" class="project-search" placeholder="筛选项目" @pointerdown.stop />
           <DrawerTrack class="project-list-scroll" data-drawer-scroll="projects">
           <div v-if="projectsLoading && !projects.length" class="project-skeletons" aria-hidden="true">
              <span v-for="index in 3" :key="index" class="project-skeleton"></span>
            </div>
            <template v-else-if="canvasProjectIdsReady">
              <!-- 三个状态分组的 key 恒定；几何位移统一由 Runtime 编排。 -->
              <div class="project-groups" data-layout-collection="mind:drawer:projects">
                <section v-for="group in visibleProjectGroups" :key="group.status" class="project-group" data-layout-role="group" data-layout-group="mind:drawer:projects" :data-layout-key="group.status">
                  <button class="project-group-title" :aria-expanded="group.items.length > 0 && openProjectStatuses.has(group.status)" @click="group.items.length && toggleProjectStatus(group.status)">
                    <span class="project-status-dot" :class="`is-${group.status}`"></span>{{ group.label }}<span>{{ group.items.length }}</span>
                    <svg class="project-group-chevron" :class="{ open: group.items.length > 0 && openProjectStatuses.has(group.status) }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                      <path d="M2 3.5l3 3 3-3"/>
                    </svg>
                  </button>
                  <div
                    v-if="group.items.length > 0"
                    class="project-group-content"
                    data-layout-content="mind:drawer:projects"
                    :data-layout-open="openProjectStatuses.has(group.status) ? 'true' : 'false'"
                  >
                    <div class="project-group-cards">
                      <ProjectDrawerCard
                        v-for="project in group.items"
                        :key="project.id"
                        :project="project"
                        :canvas-scale="canvasScale"
                        :add-to-canvas="addProjectToCanvas"
                        @add="emit('addProject', project.id)"
                      />
                    </div>
                  </div>
                </section>
              </div>
              <div v-if="!projectsLoading && projectQuery.trim() && !filteredProjects.length" class="project-empty">没有匹配的项目</div>
           </template>
            </DrawerTrack>
         </div>
       </section>
      </div>
    </DrawerViewport>
  </DrawerShell>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { PhArrowRight, PhSquaresFour, PhStack } from '@phosphor-icons/vue'
import type { MindCanvas } from '@/services/api'
import type { Project } from '@/types/project'
import ProjectDrawerCard from './ProjectDrawerCard.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import DrawerShell from './drawer/DrawerShell.vue'
import DrawerTrack from './drawer/DrawerTrack.vue'
import DrawerViewport from './drawer/DrawerViewport.vue'
import CanvasDrawerContent from './CanvasDrawerContent.vue'
import { runtime } from '@/interaction/runtime'
import { MIND_DRAWER_SURFACE_ID, MIND_PROJECT_OBJECT_TYPE } from '@/interaction/runtime/canvas'

const props = defineProps({
  canvases: { type: Array as PropType<MindCanvas[]>, required: true },
  activeId: { type: Number as PropType<number | null>, default: null },
  projects: { type: Array as PropType<Project[]>, required: true },
  canvasProjectIds: { type: Object as PropType<Set<number>>, required: true },
  canvasProjectIdsReady: { type: Boolean, default: false },
  projectsLoading: { type: Boolean, default: false },
  // 抽屉是 grid Surface，但它的卡片会飞入带相机缩放的 free 画布；把当前画布比例
  // 暴露给 Runtime Surface，由 Runtime 统一处理代理从抽屉尺寸到画布尺寸的衔接。
  canvasScale: { type: Number, default: 1 },
  addProjectToCanvas: {
    type: Function as PropType<(projectId: number, center: { x: number; y: number }, size: { w: number; h: number }) => Promise<HTMLElement | null>>,
    required: true,
  },
  renameCanvas: {
    type: Function as PropType<(id: number, title: string) => Promise<unknown>>,
    required: true,
  },
})
const emit = defineEmits<{
  (e: 'create'): void
  (e: 'open', id: number): void
  (e: 'delete', id: number): void
  (e: 'addProject', id: number): void
}>()

type Panel = 'canvases' | 'projects'
const expanded = ref(false)
const panel = ref<Panel>('canvases')
const visiblePanel = ref<Panel>('canvases')
const contentVisible = ref(false)
const headerVisible = ref(false)
const canvasContentRef = ref<InstanceType<typeof CanvasDrawerContent> | null>(null)
const projectListRef = ref<HTMLElement | null>(null)
const drawerViewportRef = ref<InstanceType<typeof DrawerViewport> | null>(null)
const drawerAnimating = computed(() => drawerViewportRef.value?.isAnimating ?? false)
const panelHeights = ref<Record<Panel, number>>({ canvases: 0, projects: 0 })
const targetHeight = computed(() => panelHeights.value[panel.value])
let canvasListObserver: ResizeObserver | null = null
let projectListObserver: ResizeObserver | null = null
let drawerSurfaceGeneration: number | null = null
let projectGroupTogglePending = false
const projectQuery = ref('')
const filteredProjects = computed(() => {
  const query = projectQuery.value.trim().toLowerCase()
  const available = props.projects.filter(project => !props.canvasProjectIds.has(project.id))
  return query ? available.filter(project => `${project.name} ${project.client || ''}`.toLowerCase().includes(query)) : available
})
const projectGroups = computed(() => [
  { status: 'active', label: '进行中', items: filteredProjects.value.filter(project => project.status === 'active') },
  { status: 'pending', label: '待开始', items: filteredProjects.value.filter(project => project.status === 'pending') },
  { status: 'done', label: '已完成', items: filteredProjects.value.filter(project => project.status === 'done') },
])
// 三个状态分组标题常驻显示，不因为某个状态一时没有项目就整块消失/出现——这块 UI 结构本身
// 稳定下来后，也顺带绕开了"分组从无到有/从有到无"这种结构性增删的过渡时机问题（比如卡片
// 挂载和分组自己的入场动画谁先谁后，会露出一帧还没被物理模块接管的本体，见 devlog）。
const visibleProjectGroups = computed(() => projectGroups.value)
const openProjectStatuses = ref(new Set<string>(['active', 'pending']))
watch(expanded, () => { void nextTick(syncRuntimeDrawerSurface) })
let previousDrawerProjectIds = new Set<number>()
let drawerProjectSnapshotReady = false
watch(filteredProjects, (projects) => {
  const currentIds = new Set(projects.map(project => project.id))
  if (!drawerProjectSnapshotReady) {
    previousDrawerProjectIds = currentIds
    drawerProjectSnapshotReady = true
    return
  }
  const statusesToOpen: string[] = []
  for (const project of projects) {
    if (previousDrawerProjectIds.has(project.id)) continue
    const status = project.status
    if (!openProjectStatuses.value.has(status)) {
      statusesToOpen.push(status)
    }
  }
  previousDrawerProjectIds = currentIds
  // project-list-scroll 有 max-height，项目变少时外层尺寸可能不变，ResizeObserver
  // 不会发出通知；DOM 提交后主动量最终的可用项目高度。
  void nextTick(() => {
    syncCollapsedProjectGroups()
    measurePanel('projects')
    void runProjectGroupToggles(statusesToOpen)
  })
}, { immediate: true, flush: 'post' })

watch(() => props.canvasProjectIdsReady, (ready) => {
  if (ready) void nextTick(() => measurePanel('projects'))
}, { flush: 'post' })

// 画布列表的子项删除会先经过自身 FLIP，ResizeObserver 不一定能捕获到外层最终高度；
// 数据提交后主动重测，避免删除后抽屉保留旧的底部空白。
watch(() => props.canvases.length, () => {
  void nextTick(() => measurePanel('canvases'))
}, { flush: 'post' })

function measurePanel(panelName: Panel) {
  if (panelName === 'projects' && !props.canvasProjectIdsReady) return
  const list = panelName === 'canvases' ? canvasContentRef.value?.listRef : projectListRef.value
  if (!list) return
  // 画布列表的子项 FLIP 会把向下位移计入 scrollHeight，删除时会短暂得到一个偏大的目标值，
  // 让抽屉先收一小段、等 FLIP 结束后再收一次。画布列表自身没有独立滚动高度，使用实际布局
  // 高度即可让外层收缩和卡片让位从同一刻开始；项目列表仍保留 scrollHeight 语义。
  const measuredHeight = panelName === 'canvases'
    ? list.getBoundingClientRect().height
    : list.scrollHeight
  // 内容面板在切换可见性时会短暂处于 height:0；无内容的中间态不能覆盖已经量好的
  // 展开目标，否则高度事务会被重置成 0。
  if (measuredHeight <= 0) return
  const nextHeight = Math.min(measuredHeight, window.innerHeight * 0.55)
  if (panelHeights.value[panelName] === nextHeight) return
  panelHeights.value = {
    ...panelHeights.value,
    [panelName]: nextHeight,
  }
}
function measurePanels() {
  measurePanel('canvases')
  measurePanel('projects')
}
async function runProjectGroupToggle(status: string, opening = !openProjectStatuses.value.has(status)): Promise<void> {
  const root = drawerViewportRef.value?.viewportRef ?? projectListRef.value
  const group = root?.querySelector<HTMLElement>(`.project-group[data-layout-key="${CSS.escape(status)}"]`)
  const content = group?.querySelector<HTMLElement>('.project-group-content')
  if (!root || !content || projectGroupTogglePending) return

  projectGroupTogglePending = true
  const profile = runtime.getMotionProfile()?.group
  try {
    await runtime.runGroupToggle({
    root,
    content,
    opening,
    mutate: () => {
      const next = new Set(openProjectStatuses.value)
      if (opening) next.add(status)
      else next.delete(status)
      openProjectStatuses.value = next
    },
    waitForLayout: async () => {
      await nextTick()
      syncCollapsedProjectGroups()
      measurePanel('projects')
      // 让 DrawerViewport 先收到新的目标高度；随后 Runtime 再播放组和 surface 的同一笔事务。
      await nextTick()
    },
    duration: profile?.duration,
    easing: profile?.easing,
    })
  } finally {
    projectGroupTogglePending = false
    void nextTick(measureProjectsAfterGroupSettles)
  }
}

function measureProjectsAfterGroupSettles() {
  const list = projectListRef.value
  if (!list) return
  if (list.querySelector('[data-runtime-group-animating="true"]')) {
    window.setTimeout(measureProjectsAfterGroupSettles, 40)
    return
  }
  syncCollapsedProjectGroups()
  measurePanel('projects')
}
async function runProjectGroupToggles(statuses: string[]): Promise<void> {
  for (const status of [...new Set(statuses)]) {
    await runProjectGroupToggle(status, true)
  }
}
function toggleProjectStatus(status: string) {
  void runProjectGroupToggle(status)
}
async function togglePanel(nextPanel: Panel) {
  if (drawerAnimating.value) return
  if (expanded.value && panel.value === nextPanel) {
    contentVisible.value = false
    headerVisible.value = false
    // 内容和外壳立即开始收起；展开头部保留在 DOM 中完成 leave 动画，不能随着 expanded
    // 同一帧卸载，否则右侧返回图标会直接消失而不是淡出。
    expanded.value = false
    return
  }
  headerVisible.value = false
  contentVisible.value = false
  panel.value = nextPanel
  visiblePanel.value = nextPanel
  // 先临时解除内容面板的 height:0，让 scrollHeight 读取真实内容高度；如果直接在
  // 隐藏状态测量，cd-content-panel:not(.visible) 会把高度压成 0，DrawerViewport
  // 只能从 0 开始展开，视觉上就会先变成长条再补高度。
  contentVisible.value = true
  await nextTick()
  measurePanels()
  // 保持内容面板参与布局；如果这里再次设为 false，viewport 高度动画期间会只剩
  // 一个没有内容的横向抽屉，随后内容揭示才会把高度瞬间补上。
  headerVisible.value = true
  expanded.value = true
  // 内容已经在测量阶段挂载，宽度和高度事务现在可以与内容一起并行展开。
}

function onOpen(id: number) {
  emit('open', id)
}
function onDelete(canvas: MindCanvas) {
  emit('delete', canvas.id)
}

function syncRuntimeDrawerSurface() {
  const element = document.querySelector<HTMLElement>('[data-project-drawer-dropzone]')
  if (drawerSurfaceGeneration === null) {
    drawerSurfaceGeneration = runtime.surfaces.register({
      id: MIND_DRAWER_SURFACE_ID,
      type: 'mind-drawer',
      element,
      // 项目抽屉只接受画布项目卡，其他画布卡片不能触发抽屉 landing。
      accepts: [MIND_PROJECT_OBJECT_TYPE],
      layout: 'grid',
      camera: { scale: () => props.canvasScale },
    })
  } else {
    runtime.surfaces.setElement(MIND_DRAWER_SURFACE_ID, element)
  }
}

onMounted(() => {
  canvasListObserver = new ResizeObserver(() => measurePanel('canvases'))
  projectListObserver = new ResizeObserver(() => {
    if (projectListRef.value?.querySelector('[data-runtime-group-animating="true"]')) return
    measurePanel('projects')
  })
  if (canvasContentRef.value?.listRef) canvasListObserver.observe(canvasContentRef.value.listRef)
  if (projectListRef.value) projectListObserver.observe(projectListRef.value)
  measurePanels()
  syncCollapsedProjectGroups()
  syncRuntimeDrawerSurface()
  window.addEventListener('resize', measurePanels)
})

function syncCollapsedProjectGroups() {
  projectListRef.value?.querySelectorAll<HTMLElement>('.project-group-content').forEach(content => {
    if (content.dataset.runtimeGroupAnimating === 'true') return
    if (content.dataset.layoutOpen === 'true') {
      if (content.style.height === '0px') {
        content.style.height = ''
        content.style.overflow = ''
      }
      return
    }
    if (!content.style.height) {
      content.style.height = '0px'
      content.style.overflow = 'hidden'
    }
  })
}
onBeforeUnmount(() => {
  canvasListObserver?.disconnect()
  projectListObserver?.disconnect()
  window.removeEventListener('resize', measurePanels)
  if (drawerSurfaceGeneration !== null) {
    runtime.surfaces.unregister(MIND_DRAWER_SURFACE_ID, drawerSurfaceGeneration)
    drawerSurfaceGeneration = null
  }
})
</script>

<style scoped>
.cd-head {
  position: relative;
  display: flex;
  align-items: center;
  height: var(--canvas-toolbar-height);
  flex-shrink: 0;
  /* 收起时内容区从一行列表缩到 0、目录头从单枚入口变两枚入口；高度必须同样
     插值，不能让头部先瞬跳再等内容区收合。 */
  transition: height .38s cubic-bezier(.22,1,.36,1);
}
/* 顶栏行高固定 50px（--canvas-toolbar-height），flex 竖直居中天然让内容的几何中心落在
   距顶 25px——跟圆角半径（.canvas-drawer.open 的 25px）相同，横向也照这个数走：标题
   左边距、返回按钮的几何中心（padding-right 7px + 自身宽 36px 的一半 18px = 25px）
   都钉在离边缘 25px，三边统一对齐同一个「圆角中心」，不再各自取不同的数。 */
.cd-expanded-nav { position: absolute; inset: 0; display: flex; align-items: center; width: 100%; box-sizing: border-box; padding: 0 7px 0 25px; }
.cd-compact-nav { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: space-evenly; width: 100%; height: calc(var(--canvas-toolbar-height) * 2); pointer-events: auto; }
.cd-toggle { flex-shrink: 0; width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 50%; background: none; color: var(--text-secondary); cursor: pointer; transition: background .18s ease, color .18s ease; }
.cd-toggle:hover, .cd-toggle.active { background: rgba(123,127,178,.11); color: var(--color-primary); }
.canvas-drawer:not(.open) .cd-head { height: calc(var(--canvas-toolbar-height) * 2); flex-direction: column; }
.canvas-drawer:not(.open) .cd-title { display: none; }
.cd-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; color: var(--text-secondary); font-size: 13px; font-weight: 700; opacity: 0; transition: opacity .15s ease; }
.canvas-drawer.open .cd-title { opacity: 1; transition-delay: .08s; }
.cd-return { margin-left: auto; }
.cd-expanded-enter-active, .cd-expanded-leave-active {
  transition: opacity .18s cubic-bezier(.22,1,.36,1), filter .18s cubic-bezier(.22,1,.36,1);
}
.cd-expanded-enter-from, .cd-expanded-leave-to { opacity: 0; filter: blur(3px); }
.cd-compact-enter-active { transition: opacity .22s ease-out, filter .22s ease-out; }
.cd-compact-enter-from { opacity: 0; filter: blur(3px); }

.cd-stage { position: relative; width: 100%; height: 100%; }
.cd-content-panel { position: absolute; top: 0; left: 0; opacity: 0; filter: blur(6px); pointer-events: none; transition: opacity .26s cubic-bezier(.22,1,.36,1), filter .26s cubic-bezier(.22,1,.36,1); }
.cd-content-panel:not(.visible) { height: 0; overflow: hidden; }
.cd-content-panel.visible { opacity: 1; filter: blur(0); pointer-events: auto; }
.canvas-panel { width: 190px; }
.projects-panel { width: 284px; }
.cd-list { box-sizing: border-box; max-height: none; overflow: visible; padding: 0 9px 9px; }
.canvas-list { width: 190px; }
.project-list { display: flex; flex-direction: column; width: 284px; height: auto; max-height: 55vh; min-height: 0; gap: 0; }
.project-list-scroll { flex: none; max-height: calc(55vh - 38px); overflow-y: auto; min-height: 0; padding-bottom: 9px; scrollbar-gutter: stable; }

.canvas-item { display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; height: 32px; padding: 0 4px 0 8px; border-radius: 6px; background: none; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.canvas-create-card { display: flex; align-items: center; justify-content: center; gap: 5px; width: 100%; height: 32px; margin-top: 5px; box-sizing: border-box; border: 1.5px dashed rgba(0,0,0,.12); border-radius: 6px; background: rgba(255,255,255,.16); color: var(--text-secondary); font: 600 12px var(--font-sans); cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease; }
.canvas-create-card:hover { background: rgba(123,127,178,.07); border-color: rgba(123,127,178,.4); color: var(--color-primary); }
.ci-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.canvas-item:hover { background: rgba(255,255,255,.55); }
.canvas-item.active { background: rgba(255,255,255,.86); color: var(--color-primary); font-weight: 700; box-shadow: 0 1px 3px rgba(60,70,100,.08); }
.rename-sizer { flex: 1; min-width: 0; }
.ci-actions { display: flex; flex-shrink: 0; gap: 2px; opacity: 0; transition: opacity .15s; }
.canvas-item:hover .ci-actions, .canvas-item:has(.rename-input-inline) .ci-actions { opacity: 1; }
.ci-btn { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; border: 0; border-radius: 5px; background: none; color: var(--text-secondary); cursor: pointer; }
.ci-btn:hover { background: rgba(123,127,178,.16); color: var(--color-primary); }
.ci-delete:hover { background: rgba(200,90,90,.14); color: #c85a5a; }

.project-search {
  flex: 0 0 38px;
}
.canvas-track[data-drawer-scroll] { height: 100%; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; }
.project-groups, .project-group-cards { display: flex; flex-direction: column; gap: 6px; }
.project-groups { gap: 9px; }
.project-group { display: flex; flex-direction: column; gap: 6px; }
/* 组内容常驻 DOM，开合高度和卡片出现状态由 Runtime 事务控制。 */
.project-group-content { min-height: 0; overflow: hidden; }
.project-group-content > .project-group-cards { min-height: 0; }
.project-group-cards { position: relative; min-height: 0; align-self: stretch; }
.project-group-cards > .drawer-project-card { flex: 0 0 auto; }
.project-group-title {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: 4px 6px; border: none; border-radius: 6px;
  background: none; cursor: pointer;
  font: 700 12px var(--font-sans); color: rgba(0,0,0,.62); letter-spacing: .03em;
  text-align: left; transition: background .12s;
}
.project-group-title:hover { background: rgba(0,0,0,.04); }
.project-group-title > span:nth-last-child(2) { margin-left: auto; font-size: 10px; font-weight: 400; color: rgba(0,0,0,.38); font-variant-numeric: tabular-nums; }
.project-group-chevron { margin-left: 3px !important; flex-shrink: 0; color: rgba(0,0,0,.2); transform: rotate(0deg); transition: transform .2s cubic-bezier(.22,1,.36,1); }
.project-group-chevron.open { transform: rotate(180deg); }
.project-status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.project-status-dot.is-pending { background: #d46b6b; }
.project-status-dot.is-active { background: #c9943a; }
.project-status-dot.is-done { background: #5a9e88; }
.project-empty { padding: 18px 8px; color: var(--text-secondary); font-size: 11px; text-align: center; }
.project-skeletons { display: flex; flex-direction: column; gap: 9px; }
.project-skeleton { display: block; height: 104px; border-radius: var(--radius-md); background: rgba(255,255,255,.38); box-shadow: inset 0 1px 0 rgba(255,255,255,.55); }
</style>
