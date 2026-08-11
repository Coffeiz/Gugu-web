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
         <div ref="projectListRef" class="cd-list project-list">
           <SearchInput v-model="projectQuery" class="project-search" placeholder="筛选项目" @pointerdown.stop />
           <DrawerTrack class="project-list-scroll" data-drawer-scroll="projects">
           <div v-if="projectsLoading && !projects.length" class="project-skeletons" aria-hidden="true">
              <span v-for="index in 3" :key="index" class="project-skeleton"></span>
            </div>
            <template v-else-if="canvasProjectIdsReady">
              <!-- 三个状态分组的 key 恒定；几何位移统一由布局协调器处理。 -->
              <TransitionGroup :css="false" tag="div" class="project-groups" move-class="project-groups-vue-move">
                <section v-for="group in visibleProjectGroups" :key="group.status" class="project-group" data-layout-role="group" :data-layout-key="group.status">
                  <button class="project-group-title" :aria-expanded="group.items.length > 0 && openProjectStatuses.has(group.status)" @click="group.items.length && toggleProjectStatus(group.status)">
                    <span class="project-status-dot" :class="`is-${group.status}`"></span>{{ group.label }}<span>{{ group.items.length }}</span>
                    <svg class="project-group-chevron" :class="{ open: group.items.length > 0 && openProjectStatuses.has(group.status) }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                      <path d="M2 3.5l3 3 3-3"/>
                    </svg>
                  </button>
                  <Transition
                    :css="false"
                    @enter="onGroupFoldEnter"
                    @leave="onGroupFoldLeave"
                  >
                    <div v-if="group.items.length > 0 && openProjectStatuses.has(group.status)" class="project-group-content">
                      <TransitionGroup :css="false" tag="div" class="project-group-cards">
                        <ProjectDrawerCard
                          v-for="project in group.items"
                          :key="project.id"
                          :project="project"
                          :canvas-scale="canvasScale"
                          :add-to-canvas="addProjectToCanvas"
                          @add="emit('addProject', project.id)"
                        />
                      </TransitionGroup>
                    </div>
                  </Transition>
                </section>
              </TransitionGroup>
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
import { computed, nextTick, onBeforeUnmount, onMounted, onBeforeUpdate, onUpdated, ref, watch, type PropType } from 'vue'
import { PhArrowRight, PhSquaresFour, PhStack } from '@phosphor-icons/vue'
import type { MindCanvas } from '@/services/api'
import type { Project } from '@/types/project'
import ProjectDrawerCard from './ProjectDrawerCard.vue'
import SearchInput from '@/components/common/SearchInput.vue'
import DrawerShell from './drawer/DrawerShell.vue'
import DrawerTrack from './drawer/DrawerTrack.vue'
import DrawerViewport from './drawer/DrawerViewport.vue'
import CanvasDrawerContent from './CanvasDrawerContent.vue'
import { createGroupLayoutTransaction } from '@/interaction/drag/animation/flipCoordinator'
import { createProjectGroupsLayoutAdapter } from '@/interaction/drag/adapters/projectGroupsLayout'
import { runtime } from '@/interaction/runtime'
import { MIND_CANVAS_OBJECT_TYPE, MIND_DRAWER_SURFACE_ID } from '@/interaction/runtime/canvas'

const props = defineProps({
  canvases: { type: Array as PropType<MindCanvas[]>, required: true },
  activeId: { type: Number as PropType<number | null>, default: null },
  projects: { type: Array as PropType<Project[]>, required: true },
  canvasProjectIds: { type: Object as PropType<Set<number>>, required: true },
  canvasProjectIdsReady: { type: Boolean, default: false },
  projectsLoading: { type: Boolean, default: false },
  // 抽屉卡抓起后会脱离抽屉、落进按相机缩放渲染的画布；把当前比例交给物理克隆，
  // 让 clone1 从第一帧起就是画布尺寸，不能等 clone2 交接时才突然缩小。
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
let projectGroupAnimationCount = 0
let projectGroupScrollRaf: number | null = null
let drawerSurfaceGeneration: number | null = null
let drawerTargetGeneration: number | null = null
const DRAWER_LAYOUT_DURATION = 340
const DRAWER_LAYOUT_EASING = 'cubic-bezier(.22,1,.36,1)'
const projectGroupsLayout = createProjectGroupsLayoutAdapter({
  getRoot: () => projectListRef.value?.querySelector<HTMLElement>('.project-groups') ?? null,
  captureScroll: () => drawerViewportRef.value?.captureScroll() ?? null,
  restoreScroll: snapshot => drawerViewportRef.value?.restoreScroll(snapshot as Parameters<NonNullable<typeof drawerViewportRef.value>['restoreScroll']>[0]),
  duration: DRAWER_LAYOUT_DURATION,
  easing: DRAWER_LAYOUT_EASING,
})
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
      const next = new Set(openProjectStatuses.value)
      next.add(status)
      openProjectStatuses.value = next
      statusesToOpen.push(status)
    }
  }
  previousDrawerProjectIds = currentIds
  // 拖入画布抽屉时，状态组是由数据监听器自动打开的，不会经过点击组标题的入口；
  // 补上同一笔外层高度事务，让新卡进入、组展开和抽屉高度变化从同一帧开始。
  if (statusesToOpen.length) {
    void nextTick(() => statusesToOpen.forEach(status => animateViewportWithGroup(status, true, 0)))
  }
  // project-list-scroll 有 max-height，项目变少时外层尺寸可能不变，ResizeObserver
  // 不会发出通知；DOM 提交后主动量最终的可用项目高度。
  void nextTick(() => measurePanel('projects'))
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
  if (panelName === 'projects' && projectGroupAnimationCount > 0) return
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
function projectGroupTitleScrollTarget(status: string): { scroller: HTMLElement, target: number } | null {
  const group = projectListRef.value?.querySelector<HTMLElement>(`.project-group[data-layout-key="${CSS.escape(status)}"]`)
  const title = group?.querySelector<HTMLElement>('.project-group-title')
  const scroller = projectListRef.value?.querySelector<HTMLElement>('.project-list-scroll')
  if (!title || !scroller) return null
  const titleRect = title.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  const target = scroller.scrollTop + titleRect.top - scrollerRect.top
  return {
    scroller,
    target: Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight)),
  }
}
function alignProjectGroupTitleDuringExpand(status: string, smooth = true) {
  if (projectGroupScrollRaf !== null) cancelAnimationFrame(projectGroupScrollRaf)
  if (!smooth) {
    const result = projectGroupTitleScrollTarget(status)
    if (result) result.scroller.scrollTop = result.target
    return
  }
  const deadline = performance.now() + DRAWER_LAYOUT_DURATION + 80
  const tick = () => {
    const result = projectGroupTitleScrollTarget(status)
    if (!result) {
      projectGroupScrollRaf = null
      return
    }
    const distance = result.target - result.scroller.scrollTop
    if (performance.now() < deadline) {
      result.scroller.scrollTop += distance * 0.18
      projectGroupScrollRaf = requestAnimationFrame(tick)
    } else {
      result.scroller.scrollTop = result.target
      projectGroupScrollRaf = null
    }
  }
  tick()
}
// 折叠元素自己的高度用真实过渡在变化（createGroupLayoutTransaction 直接 animate
// element.style.height），它是文档流里的普通块级元素——后面的兄弟 .project-group
// 会跟着这个高度变化逐帧自动回流、自动挪位，浏览器原生免费提供平滑效果，不需要
// projectGroupsLayout 那套 FLIP 补间。之前 toggle 路径也接了 FLIP，实测会在「已有
// 一组展开」时把同一次挪位用 transform 重新播一遍——折叠过渡明明已经带动兄弟组
// 平滑到位，FLIP 事务又照着 before/after 快照播了一次，看着就是"动画放完了又来一次"。
// FLIP 只留给 data-update（拖拽改数据，组内卡片数量非连续突变，没有平滑高度过渡
// 可言）这条路径。
function onGroupFoldEnter(el: Element, done: () => void) {
  projectGroupAnimationCount += 1
  // 组高度事务接管自然回流；旧的标题 FLIP 若继续播放，会把同一批标题
  // 再写一层 transform，松手瞬间就会出现标题重叠。
  projectGroupsLayout.cancel()
  const group = el.parentElement
  const status = group?.dataset.layoutKey
  if (status) {
    // 已完成组通常位于列表底部，拖入时 clone2 正在交接；持续滚动会让落点盒子
    // 同帧变化，产生一次可见顿挫。该组进入时固定即时对齐，点击展开仍走缓动路径。
    const landingInProgress = document.body.classList.contains('phys-dragging')
      || !!el.querySelector('.phys-drag-source-placeholder, .phys-reveal-snap, .phys-just-revealed')
    alignProjectGroupTitleDuringExpand(status, !landingInProgress)
  }
  const tx = createGroupLayoutTransaction(el as HTMLElement, DRAWER_LAYOUT_DURATION, DRAWER_LAYOUT_EASING)
  void tx.play(true).finally(() => {
    done()
    projectGroupAnimationCount = Math.max(0, projectGroupAnimationCount - 1)
    if (projectGroupAnimationCount === 0) requestAnimationFrame(() => measurePanel('projects'))
  })
  if (status) animateViewportWithGroup(status, true, 0)
}
function onGroupFoldLeave(el: Element, done: () => void) {
  projectGroupAnimationCount += 1
  projectGroupsLayout.cancel()
  const previousHeight = (el as HTMLElement).getBoundingClientRect().height
  const tx = createGroupLayoutTransaction(el as HTMLElement, DRAWER_LAYOUT_DURATION, DRAWER_LAYOUT_EASING)
  void tx.play(false).finally(() => {
    done()
    projectGroupAnimationCount = Math.max(0, projectGroupAnimationCount - 1)
    if (projectGroupAnimationCount === 0) {
      // v-if 的离场节点在 done() 后还要经过 Vue 的卸载调度；下一帧可能仍读到
      // “标题存在、内容高度已是 0”的中间 DOM。等两帧再校准，避免把这个中间值
      // 写进 DrawerViewport，导致外层先缩到 0 再恢复最终高度。
      requestAnimationFrame(() => requestAnimationFrame(() => measurePanel('projects')))
    }
  })
  const status = el.parentElement?.dataset.layoutKey
  if (status) animateViewportWithGroup(status, false, previousHeight)
}
function animateViewportWithGroup(status: string, opening: boolean, previousHeight: number) {
  const group = projectListRef.value?.querySelector<HTMLElement>(`.project-group[data-layout-key="${CSS.escape(status)}"]`)
  const content = group?.querySelector<HTMLElement>('.project-group-content')
  const groupGap = group ? parseFloat(getComputedStyle(group).rowGap) || 0 : 0
  const contentHeight = content?.scrollHeight ?? 0
  const maxHeight = window.innerHeight * 0.55
  const currentHeight = drawerViewportRef.value?.viewportRef?.getBoundingClientRect().height
    ?? panelHeights.value.projects
  // 收缩时 viewport 可能已经被 max-height 截断，不能用「当前 viewport - 组高度」
  // 反推目标，否则滚动区域里的其它组会被一起扣掉，目标会错误变成 0。
  const naturalListHeight = projectListRef.value?.scrollHeight ?? currentHeight
  let targetNaturalHeight = naturalListHeight + contentHeight + groupGap
  if (!opening && content) {
    // 收起事务已经开始，但 Vue 的离场节点还在 DOM 中。临时把该 wrapper
    // 设为最终的 0 高度读取外层自然高度，随后恢复事务当前样式；这样能在
    // 组动画开始时就拿到外层目标，而不必等组动画结束后才测量。
    const previousInlineHeight = content.style.height
    const previousInlineMarginTop = content.style.marginTop
    content.style.height = '0px'
    content.style.marginTop = `-${groupGap}px`
    void content.offsetHeight
    targetNaturalHeight = projectListRef.value?.scrollHeight ?? naturalListHeight
    content.style.height = previousInlineHeight
    content.style.marginTop = previousInlineMarginTop
  }
  const target = Math.max(0, Math.min(maxHeight, targetNaturalHeight))
  // 让 DrawerViewport 的 props watcher 负责启动唯一一笔外层高度事务；直接调用
  // animateTo 再改 panelHeights 会形成两次相同的高度动画。
  if (Math.abs(panelHeights.value.projects - target) >= 0.5) {
    panelHeights.value = { ...panelHeights.value, projects: target }
  }
}
function toggleProjectStatus(status: string) {
  // 仍要调一次 requestLayout('toggle')：它唯一剩下的作用是置位 skipNextDataUpdate，
  // 抵消紧跟着 onBeforeUpdate 触发的那次 'data-update' 请求——否则 toggle 引起的
  // 重渲染会被 data-update 路径当成“数据变了”又捕一次 FLIP，等于换了个入口重新
  // 引入同一个二次动画问题。
  projectGroupsLayout.requestLayout('toggle')
  const group = projectListRef.value?.querySelector<HTMLElement>(`.project-group[data-layout-key="${CSS.escape(status)}"]`)
  const content = group?.querySelector<HTMLElement>('.project-group-content')
  const previousHeight = content?.getBoundingClientRect().height ?? 0
  const opening = !openProjectStatuses.value.has(status)
  if (opening) alignProjectGroupTitleDuringExpand(status)
  const next = new Set(openProjectStatuses.value)
  next.has(status) ? next.delete(status) : next.add(status)
  openProjectStatuses.value = next
  void nextTick(() => {
    animateViewportWithGroup(status, opening, previousHeight)
  })
}
onBeforeUpdate(() => {
  // 跨抽屉/画布拖拽会直接改变项目数据，状态组本身不会经过 toggleProjectStatus；
  // 这里补上同一套组位移事务，避免源组收缩后其它状态组瞬移。
  // 但组高度事务进行期间，下面的标题应跟随自然回流；此时再捕获一笔
  // data-update FLIP 会把离场中的中间布局留到动画结束后，造成已完成组迟到重叠。
  if (projectGroupAnimationCount > 0) return
  projectGroupsLayout.requestLayout('data-update')
})
onUpdated(() => {
  if (projectGroupAnimationCount === 0) void projectGroupsLayout.measureAndPlay()
})
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
      accepts: [MIND_CANVAS_OBJECT_TYPE],
    })
  } else {
    runtime.surfaces.setElement(MIND_DRAWER_SURFACE_ID, element)
  }
  if (drawerTargetGeneration === null) {
    drawerTargetGeneration = runtime.targets.register({
      id: 'mind:drawer-target',
      surfaceId: MIND_DRAWER_SURFACE_ID,
      element,
      accepts: [MIND_CANVAS_OBJECT_TYPE],
      priority: 1,
    })
  } else {
    runtime.targets.setElement('mind:drawer-target', element)
  }
}

onMounted(() => {
  canvasListObserver = new ResizeObserver(() => measurePanel('canvases'))
  projectListObserver = new ResizeObserver(() => {
    if (projectGroupAnimationCount > 0) return
    measurePanel('projects')
  })
  if (canvasContentRef.value?.listRef) canvasListObserver.observe(canvasContentRef.value.listRef)
  if (projectListRef.value) projectListObserver.observe(projectListRef.value)
  measurePanels()
  syncRuntimeDrawerSurface()
  window.addEventListener('resize', measurePanels)
})
onBeforeUnmount(() => {
  canvasListObserver?.disconnect()
  projectListObserver?.disconnect()
  window.removeEventListener('resize', measurePanels)
  if (drawerSurfaceGeneration !== null) {
    runtime.surfaces.unregister(MIND_DRAWER_SURFACE_ID, drawerSurfaceGeneration)
    drawerSurfaceGeneration = null
  }
  if (drawerTargetGeneration !== null) {
    runtime.targets.unregister('mind:drawer-target', drawerTargetGeneration)
    drawerTargetGeneration = null
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
.project-groups-vue-move { transition: none !important; }
.project-group { display: flex; flex-direction: column; gap: 6px; }
/* 折叠动画改走 JS 实测像素高度（见 onGroupFoldEnter/onGroupFoldLeave），不再用
   grid-template-rows: 1fr/0fr 这个技巧——fr 单位插值在浏览器里对「最后一帧精确到 0」
   处理不完全一致，跟 <Transition> 等 transitionend 才卸载元素配合，会在快结束时冒出
   一帧亚像素级的吸入感（2026-07-17 复现，探针数据显示动画全程连续、唯独最后一帧有
   极小跳变，是这个技巧的已知局限，不是逻辑 bug）。这里只保留 overflow:hidden 兜底，
   实际高度/transition 由 JS 钩子接管。 */
.project-group-content { min-height: 0; overflow: hidden; }
.project-group-content > .project-group-cards { min-height: 0; }
/* leave-active 把离场卡切成 position:absolute（见下方 .drawer-project-cards-leave-active）
   時没有 top/left，浏览器按它离场前的「静态位置」摆放——但这个静态位置是相对**最近的
   已定位祖先**算的，而不是它离场前视觉所在的这个 flex 容器。.project-group-cards 本身
   不带 position，最近定位祖先一路上翻到 .cd-content-panel（projects-panel），中间隔着
   一层可滚动的 .cd-list（overflow-y:auto，有独立 padding/scrollTop）；离场卡因此会按
   .cd-content-panel 的坐标系重新摆放，跟它离场前在 .cd-list 里滚动之后的真实视觉位置对
   不上，看着就是"虚线框动了一下"。补一个 position:relative 把定位祖先钉在它离场前的
   直接父容器上，静态位置的坐标系跟视觉位置保持一致，不再跳。 */
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
