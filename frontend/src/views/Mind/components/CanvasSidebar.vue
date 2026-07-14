<template>
  <div
    class="canvas-drawer glass-card"
    :class="{ open: expanded, 'project-panel': panel === 'projects' }"
    :style="{ '--cd-target-width': panel === 'projects' ? '284px' : '190px' }"
    :data-project-drawer-dropzone="expanded && panel === 'projects' ? '' : undefined"
    @pointerdown.stop
  >
    <div class="cd-head">
      <Transition name="cd-expanded">
        <div v-if="headerVisible" class="cd-expanded-nav">
          <span class="cd-title">{{ panel === 'canvases' ? '画布' : '项目' }}</span>
          <button class="cd-toggle cd-return" title="收起" @click="togglePanel(panel)"><PhArrowRight :size="18" weight="bold" /></button>
        </div>
      </Transition>
      <Transition name="cd-compact">
        <div v-if="!expanded && compactReady" class="cd-compact-nav">
        <button class="cd-toggle" title="画布列表" @click="togglePanel('canvases')"><PhSquaresFour :size="16" weight="bold" /></button>
        <button class="cd-toggle" title="项目素材" @click="togglePanel('projects')"><PhBriefcase :size="16" weight="bold" /></button>
        </div>
      </Transition>
    </div>

    <!-- 两个面板始终挂载、各自在固定宽度下量高度。开关时只换目标尺寸与可见内容，
         不会再出现旧面板尺寸被新面板借用一帧的横向/纵向两段动画。 -->
    <div class="cd-collapse" :style="{ height: expanded ? `${targetHeight}px` : '0px' }">
      <div class="cd-stage">
        <section class="cd-content-panel canvas-panel" :class="{ visible: visiblePanel === 'canvases' && contentVisible }" :aria-hidden="visiblePanel !== 'canvases'">
          <div ref="canvasListRef" class="cd-list canvas-list">
            <div v-for="canvas in canvases" :key="canvas.id" class="canvas-item" :class="{ active: canvas.id === activeId }" @click="onOpen(canvas.id)">
              <span v-if="renamingId === canvas.id" class="rename-sizer" @click.stop>
                <span class="rename-ghost">{{ renameText || ' ' }}</span>
                <input
                  ref="renameInputRef"
                  v-model="renameText"
                  class="rename-input-inline"
                  v-enter="() => commitRename(canvas.id)"
                  @keydown.esc="cancelRename"
                  @blur="commitRename(canvas.id)"
                  @focus="($event.target as HTMLInputElement).select()"
                />
              </span>
              <span v-else class="ci-title">{{ canvas.title || '未命名画布' }}</span>
              <div class="ci-actions">
                <button :title="renamingId === canvas.id ? '确认' : '重命名'" class="ci-btn" @click.stop="renamingId === canvas.id ? commitRename(canvas.id) : startRename(canvas)">
                  <PhCheck v-if="renamingId === canvas.id" :size="11" weight="bold" />
                  <PhPencilSimple v-else :size="11" weight="bold" />
                </button>
                <button title="删除画布" class="ci-btn ci-delete" @click.stop="onDelete(canvas)"><PhTrash :size="11" weight="bold" /></button>
              </div>
            </div>
            <button class="canvas-create-card" @click="emit('create')"><PhPlus :size="14" weight="bold" />新建画布</button>
          </div>
        </section>

        <section class="cd-content-panel projects-panel" :class="{ visible: visiblePanel === 'projects' && contentVisible }" :aria-hidden="visiblePanel !== 'projects'">
          <div ref="projectListRef" class="cd-list project-list">
            <SearchInput v-model="projectQuery" class="project-search" placeholder="筛选项目" @pointerdown.stop />
            <div v-if="projectsLoading && !projects.length" class="project-skeletons" aria-hidden="true">
              <span v-for="index in 3" :key="index" class="project-skeleton"></span>
            </div>
            <template v-else>
              <!-- 三个状态分组的 key 恒定（进行中/待开始/已完成常驻），这层 TransitionGroup
                   永远不会真正触发 leave/enter，只用它的 -move FLIP 机制：某个分组因为增减
                   卡片变高变矮时，其它分组跟着平滑挪位，而不是瞬间跳到新位置。 -->
              <TransitionGroup name="drawer-project-groups" tag="div" class="project-groups">
                <section v-for="group in visibleProjectGroups" :key="group.status" class="project-group">
                  <div class="project-group-title"><span class="project-status-dot" :class="`is-${group.status}`"></span>{{ group.label }}<span>{{ group.items.length }}</span></div>
                  <TransitionGroup name="drawer-project-cards" tag="div" class="project-group-cards" @before-leave="captureLeavePosition">
                    <ProjectDrawerCard
                      v-for="project in group.items"
                      :key="project.id"
                      :project="project"
                      :canvas-scale="canvasScale"
                      :add-to-canvas="addProjectToCanvas"
                      @add="emit('addProject', project.id)"
                    />
                  </TransitionGroup>
                </section>
              </TransitionGroup>
              <div v-if="!projectsLoading && !filteredProjects.length" class="project-empty">没有匹配的项目</div>
            </template>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type PropType } from 'vue'
import { PhArrowRight, PhBriefcase, PhCheck, PhPencilSimple, PhPlus, PhSquaresFour, PhTrash } from '@phosphor-icons/vue'
import type { MindCanvas } from '@/services/api'
import type { Project } from '@/types/project'
import ProjectDrawerCard from './ProjectDrawerCard.vue'
import SearchInput from '@/components/common/SearchInput.vue'

const props = defineProps({
  canvases: { type: Array as PropType<MindCanvas[]>, required: true },
  activeId: { type: Number as PropType<number | null>, default: null },
  projects: { type: Array as PropType<Project[]>, required: true },
  canvasProjectIds: { type: Object as PropType<Set<number>>, required: true },
  projectsLoading: { type: Boolean, default: false },
  // 抽屉卡抓起后会脱离抽屉、落进按相机缩放渲染的画布；把当前比例交给物理克隆，
  // 让 clone1 从第一帧起就是画布尺寸，不能等 clone2 交接时才突然缩小。
  canvasScale: { type: Number, default: 1 },
  addProjectToCanvas: {
    type: Function as PropType<(projectId: number, center: { x: number; y: number }, size: { w: number; h: number }) => Promise<HTMLElement | null>>,
    required: true,
  },
})
const emit = defineEmits<{
  (e: 'create'): void
  (e: 'open', id: number): void
  (e: 'delete', id: number): void
  (e: 'rename', id: number, title: string): void
  (e: 'addProject', id: number): void
}>()

type Panel = 'canvases' | 'projects'
const expanded = ref(false)
const compactReady = ref(true)
const panel = ref<Panel>('canvases')
const visiblePanel = ref<Panel>('canvases')
const contentVisible = ref(false)
const headerVisible = ref(false)
const canvasListRef = ref<HTMLElement | null>(null)
const projectListRef = ref<HTMLElement | null>(null)
const panelHeights = ref<Record<Panel, number>>({ canvases: 0, projects: 0 })
const targetHeight = computed(() => panelHeights.value[panel.value])
let canvasListObserver: ResizeObserver | null = null
let projectListObserver: ResizeObserver | null = null
let contentTimer: ReturnType<typeof setTimeout> | null = null
let compactTimer: ReturnType<typeof setTimeout> | null = null
let projectResizeTimer: ReturnType<typeof setTimeout> | null = null

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

// leave-active 把离场卡切成 position:absolute 时不给 top/left，指望浏览器按它离场前的
// 「静态位置」自动摆放——用 DevTools 性能录制实测抓到过这个自动定位算错：离场卡被摆到了
// 所在 .project-group-cards 容器的最顶端（跟第一张卡重叠），不是它离场前所在的那个位置。
// 这层容器是可滚动 .cd-list 的后代、又套了两层 TransitionGroup，浏览器的「静态位置」推算
// 在这种嵌套场景下不可靠。不再依赖浏览器猜，改成在真正离场前用 getBoundingClientRect()
// 量出它此刻相对 .project-group-cards（offsetParent，见其 position:relative）的像素坐标，
// 直接写成明确的 top/left——浏览器不用再猜，也就没有猜错的余地。
function captureLeavePosition(el: Element) {
  const node = el as HTMLElement
  const parent = node.offsetParent as HTMLElement | null
  if (!parent) return
  const rect = node.getBoundingClientRect()
  const parentRect = parent.getBoundingClientRect()
  node.style.position = 'absolute'
  node.style.left = `${rect.left - parentRect.left}px`
  node.style.top = `${rect.top - parentRect.top}px`
  node.style.width = `${rect.width}px`
}
function measurePanel(panelName: Panel) {
  const list = panelName === 'canvases' ? canvasListRef.value : projectListRef.value
  if (!list) return
  panelHeights.value = {
    ...panelHeights.value,
    [panelName]: Math.min(list.scrollHeight, window.innerHeight * 0.55),
  }
}
function measurePanels() {
  measurePanel('canvases')
  measurePanel('projects')
}
function clearContentTimer() {
  if (contentTimer) clearTimeout(contentTimer)
  contentTimer = null
}
function clearCompactTimer() {
  if (compactTimer) clearTimeout(compactTimer)
  compactTimer = null
}
function revealContent(delay: number) {
  clearContentTimer()
  contentTimer = setTimeout(() => {
    // 先让外壳的展开尺寸提交一帧，再揭示内容；否则某些浏览器会把两次状态写入合帧，
    // 直接跳到清晰终态，看不见本应有的 blur/opacity 淡入。
    requestAnimationFrame(() => {
      headerVisible.value = true
      contentVisible.value = true
    })
  }, delay)
}
async function togglePanel(nextPanel: Panel) {
  if (expanded.value && panel.value === nextPanel) {
    contentVisible.value = false
    headerVisible.value = false
    clearContentTimer()
    clearCompactTimer()
    // 内容和外壳立即开始收起；展开头部保留在 DOM 中完成 leave 动画，不能随着 expanded
    // 同一帧卸载，否则右侧返回图标会直接消失而不是淡出。
    expanded.value = false
    compactTimer = setTimeout(() => {
      compactReady.value = true
    }, 180)
    return
  }
  clearCompactTimer()
  compactReady.value = false
  headerVisible.value = false
  contentVisible.value = false
  panel.value = nextPanel
  visiblePanel.value = nextPanel
  await nextTick()
  measurePanels()
  expanded.value = true
  // 内容面板一开始就按最终尺寸定位，只由外壳 overflow 裁切展开；下一帧立即淡入，
  // 让它与宽高变化并行，而非等抽屉完全展开后才出现。
  revealContent(0)
}

const renamingId = ref<number | null>(null)
const renameText = ref('')
const renameInputRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
function onOpen(id: number) {
  if (renamingId.value == null) emit('open', id)
}
function onDelete(canvas: MindCanvas) {
  if (!window.confirm(`删除画布「${canvas.title || '未命名画布'}」？画布上的贴纸摆放将一并清空，此操作不可撤销。`)) return
  emit('delete', canvas.id)
}
function startRename(canvas: MindCanvas) {
  renamingId.value = canvas.id
  renameText.value = canvas.title || ''
  nextTick(() => {
    const input = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value
    input?.focus()
    input?.select()
  })
}
function cancelRename() {
  renamingId.value = null
  renameText.value = ''
}
function commitRename(id: number) {
  if (renamingId.value !== id) return
  const title = renameText.value.trim()
  renamingId.value = null
  if (title) emit('rename', id, title)
}

onMounted(() => {
  canvasListObserver = new ResizeObserver(() => measurePanel('canvases'))
  // 项目卡拖去画布时源卡先是原位占位（keepSourcePlaceholder），要等新画布卡接手落地
  // 动画后才会被真的从数据里摘掉；一摘掉，Vue 给它套 leave-active（position:absolute，
  // 脱离文档流），.project-list 的 scrollHeight 当帧就变小，ResizeObserver 同步触发
  // measurePanel 收缩 .cd-collapse 的高度——这时那张卡自己的 .16s 淡出还没播完，容器
  // 却已经在收，视觉上就是"虚线框跟着挤了一下"。防抖到比这张卡的离场过渡（.16s 淡出 +
  // 那一下 -move FLIP 落定）略长，让容器收缩等卡片真正淡完、兄弟卡落定后再一次到位。
  projectListObserver = new ResizeObserver(() => {
    if (projectResizeTimer) clearTimeout(projectResizeTimer)
    projectResizeTimer = setTimeout(() => measurePanel('projects'), 220)
  })
  if (canvasListRef.value) canvasListObserver.observe(canvasListRef.value)
  if (projectListRef.value) projectListObserver.observe(projectListRef.value)
  measurePanels()
  window.addEventListener('resize', measurePanels)
})
onBeforeUnmount(() => {
  clearContentTimer()
  clearCompactTimer()
  if (projectResizeTimer) clearTimeout(projectResizeTimer)
  canvasListObserver?.disconnect()
  projectListObserver?.disconnect()
  window.removeEventListener('resize', measurePanels)
})
</script>

<style scoped>
.canvas-drawer {
  position: absolute; top: 50%; right: var(--floating-edge); z-index: 8; transform: translateY(-50%);
  box-sizing: border-box; width: var(--canvas-toolbar-height); overflow: hidden;
  /* 跟展开态用同一个 25px，收展全程圆角数值不变，只有宽度在动——不然收起态原来的
     999px（窄边被强制箍成满圆）展开时会先经历一段「大圆滚成矩形」的形变感。 */
  border-radius: 25px;
  corner-shape: round;
  transition: width 0.38s cubic-bezier(.22,1,.36,1),
              border-radius 0.38s cubic-bezier(.22,1,.36,1),
              background 0.25s ease, box-shadow 0.25s ease;
}
.canvas-drawer.open { width: 190px; border-radius: 25px; }
.canvas-drawer.open.project-panel { width: 284px; }
.cd-head {
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
.cd-expanded-nav { display: flex; align-items: center; width: 100%; box-sizing: border-box; padding: 0 7px 0 25px; }
.cd-compact-nav { display: flex; flex-direction: column; align-items: center; justify-content: space-evenly; width: 100%; height: 100%; }
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

.cd-collapse { position: relative; width: var(--cd-target-width); overflow: hidden; transition: height .38s cubic-bezier(.22,1,.36,1); }
.cd-stage { position: relative; width: 100%; height: 100%; }
.cd-content-panel { position: absolute; top: 0; left: 0; opacity: 0; filter: blur(6px); pointer-events: none; transition: opacity .26s cubic-bezier(.22,1,.36,1), filter .26s cubic-bezier(.22,1,.36,1); }
.cd-content-panel.visible { opacity: 1; filter: blur(0); pointer-events: auto; }
.canvas-panel { width: 190px; }
.projects-panel { width: 284px; }
.cd-list { box-sizing: border-box; max-height: 55vh; overflow-y: auto; padding: 0 9px 9px; }
.canvas-list { width: 190px; }
.project-list { display: flex; flex-direction: column; gap: 9px; width: 284px; min-height: 312px; }

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

.project-search { flex: 0 0 38px; }
.project-groups, .project-group-cards { display: flex; flex-direction: column; gap: 6px; }
.project-groups { gap: 9px; }
.project-group { display: flex; flex-direction: column; gap: 6px; }
/* leave-active 把离场卡切成 position:absolute（见下方 .drawer-project-cards-leave-active）
   時没有 top/left，浏览器按它离场前的「静态位置」摆放——但这个静态位置是相对**最近的
   已定位祖先**算的，而不是它离场前视觉所在的这个 flex 容器。.project-group-cards 本身
   不带 position，最近定位祖先一路上翻到 .cd-content-panel（projects-panel），中间隔着
   一层可滚动的 .cd-list（overflow-y:auto，有独立 padding/scrollTop）；离场卡因此会按
   .cd-content-panel 的坐标系重新摆放，跟它离场前在 .cd-list 里滚动之后的真实视觉位置对
   不上，看着就是"虚线框动了一下"。补一个 position:relative 把定位祖先钉在它离场前的
   直接父容器上，静态位置的坐标系跟视觉位置保持一致，不再跳。 */
.project-group-cards { position: relative; }
/* Vue TransitionGroup 先按新布局摆放兄弟，再把它们反向平移回旧位置；只需给 transform
   同项目页一致的快进慢收曲线，拖出的项目离场后其它卡便会自然让位而非瞬移。 */
.drawer-project-cards-move, .drawer-project-groups-move {
  transition: transform .42s cubic-bezier(.22,1,.36,1);
}
.drawer-project-cards-leave-active {
  position: absolute;
  width: 240px;
  transition: opacity .16s ease;
  /* 用 DevTools 性能录制实测抓到过：离场这张卡会同时被扣上 -move 类——Vue 同一次 patch
     里，除了把它标成 leave（见上面 position:absolute 的原地淡出），还会把它当成"位置变了
     的兄弟元素"一起塞进 FLIP 反推，用内联 style 直接写一段 transform 位移量，交给 -move
     的 transition 慢慢归零。这段内联 transform 跟这里的原地占位叠在一起，就是"虚线框先被
     推移一下才淡出"。用 !important 压掉 Vue 写进来的内联 transform——离场卡不需要参与那次
     位移，只要原地淡出。 */
  transform: none !important;
}
.drawer-project-cards-leave-to { opacity: 0; }
.project-group-title { display: flex; align-items: center; gap: 5px; padding: 3px 3px 0; color: var(--text-secondary); font-size: 10px; font-weight: 700; }
.project-group-title > span:last-child { margin-left: auto; font-variant-numeric: tabular-nums; opacity: .6; }
.project-status-dot { width: 6px; height: 6px; border-radius: 50%; }
.project-status-dot.is-pending { background: #d46b6b; }
.project-status-dot.is-active { background: #c9943a; }
.project-status-dot.is-done { background: #5a9e88; }
.project-empty { padding: 18px 8px; color: var(--text-secondary); font-size: 11px; text-align: center; }
.project-skeletons { display: flex; flex-direction: column; gap: 9px; }
.project-skeleton { display: block; height: 104px; border-radius: var(--radius-md); background: rgba(255,255,255,.38); box-shadow: inset 0 1px 0 rgba(255,255,255,.55); }
</style>
