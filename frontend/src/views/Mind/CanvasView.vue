<template>
  <div class="canvas-page">
    <MindCanvas
      ref="canvasRef"
      :canvas-key="activeCanvasId"
      :items="store.canvasItems"
      :relations="store.canvasRelations"
      :relation-anchors="relationAnchors"
      @remove="removeItem"
      @return-to-drawer="returnProjectToDrawer"
      @remove-relation="removeRelation"
      @link-nodes="linkNodes"
      @open-ref="openRef"
      @item-moved="onItemMoved"
      @view-change="onViewChange"
    />

    <!-- UI 与顶部胶囊一样放到 body 顶层，避免被 body 上的拖拽 clone/camGlue 层叠上下文压住。 -->
    <Teleport to="body">
      <CanvasSidebar
        :canvases="store.canvases"
        :active-id="activeCanvasId"
        :projects="projectStore.projects"
        :canvas-project-ids="canvasProjectIds"
        :canvas-project-ids-ready="canvasProjectIdsReady"
        :projects-loading="projectStore.loading"
        :canvas-scale="canvasRef?.camera.scale ?? 1"
        :add-project-to-canvas="addProjectAtScreen"
        :rename-canvas="renameCanvas"
        @create="createCanvas"
        @open="openCanvas"
        @delete="deleteCanvas"
        @add-project="addProjectAtCenter"
      />

      <CanvasToolbar
        :scale="canvasRef?.camera.scale ?? 1"
        @create-note="createCanvasNote"
        @add-ref="addRef"
        @zoom="delta => canvasRef?.zoomAtCenter(delta)"
        @reset-view="resetView"
      />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { MindCanvasItem, MindRefSuggestItem } from '@/services/api'
import { useMindRefActions } from '@/composables/useMindRefActions'
import { showAppError } from '@/composables/useAppToast'
import type { RelationAnchorSides } from '@/composables/useMindCanvas'
import { useMindStore } from '@/stores/mind'
import { useProjectStore } from '@/stores/projects'
import CanvasSidebar from './components/CanvasSidebar.vue'
import CanvasToolbar from './components/CanvasToolbar.vue'
import MindCanvas from './components/MindCanvas.vue'

type CanvasRefItem = MindRefSuggestItem & { type: 'project' | 'file' | 'event' }

const store = useMindStore()
const projectStore = useProjectStore()
const { openMindRef } = useMindRefActions()

const canvasRef = ref<InstanceType<typeof MindCanvas> | null>(null)
// 抽屉只能在当前画布项目加载完后量项目高度，否则首帧会把已放入画布的项目计入缓存。
const canvasProjectIdsReady = ref(false)
const activeCanvasId = computed(() => store.activeCanvasId)
// 数据库约束 uq_canvas_node 已保证同一项目在同一画布只会有一个展示项；抽屉只展示尚未摆入
// 当前画布的项目，拖入成功后由 canvasItems 的响应式更新自动移出，无需另维护一份临时状态。
const canvasProjectIds = computed(() => new Set(
  store.canvasItems
    .filter(item => item.node.kind === 'ref' && item.node.refType === 'project' && item.node.refId != null)
    .map(item => item.node.refId as number),
))
const relationAnchors = computed<Record<string, RelationAnchorSides>>(() => {
  const data = store.canvases.find(canvas => canvas.id === activeCanvasId.value)?.data
  const value = data?.relationAnchors
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, RelationAnchorSides> = {}
  for (const [id, sides] of Object.entries(value)) {
    if (!sides || typeof sides !== 'object') continue
    const { srcSide, dstSide } = sides as Partial<RelationAnchorSides>
    if ((srcSide === 'left' || srcSide === 'right') && (dstSide === 'left' || dstSide === 'right')) {
      result[id] = { srcSide, dstSide }
    }
  }
  return result
})

onMounted(async () => {
  // 项目抽屉会在首屏就被打开，项目数据不能等笔记/画布请求串行完成后才开始拉；否则抽屉
  // 先按空内容横向展开、请求回来才突然长高。三份独立数据并行加载，抽屉首次展开就有稳定高度。
  await Promise.all([
    !store.loaded ? store.fetchNotes() : Promise.resolve(),
    !store.canvasesLoaded ? store.fetchCanvases() : Promise.resolve(),
    !projectStore.projectsLoaded && !projectStore.loading ? projectStore.fetchProjects() : Promise.resolve(),
  ])
  await ensureCanvas()
})
async function ensureCanvas() {
  const rememberedId = Number(localStorage.getItem('mind-last-canvas-id'))
  const fallbackId = Number.isFinite(rememberedId) && store.canvases.some(canvas => canvas.id === rememberedId)
    ? rememberedId
    : store.canvases[0]?.id
  let id = fallbackId
  if (id == null) {
    const canvas = await store.createCanvas()
    id = canvas.id
  }
  if (!Number.isFinite(id) || !store.canvases.some(canvas => canvas.id === id)) {
    const canvas = store.canvases[0] || await store.createCanvas()
    id = canvas.id
  }
  await activateCanvas(id)
}

let activationSeq = 0
/** 画布 ID 的唯一切换入口；路由只负责进入画布模式，当前画布由 Store 管理。 */
async function activateCanvas(id: number) {
  if (!store.canvases.some(canvas => canvas.id === id)) return
  const seq = ++activationSeq
  flushViewSave()
  canvasProjectIdsReady.value = false
  try {
    const loaded = await store.loadCanvas(id)
    if (!loaded) return
  } catch {
    if (seq === activationSeq) {
      canvasProjectIdsReady.value = true
      showAppError('画布加载失败，请稍后重试')
    }
    return
  }
  if (seq !== activationSeq || store.activeCanvasId !== id) return
  canvasProjectIdsReady.value = true
  localStorage.setItem('mind-last-canvas-id', String(id))
  await nextTick()
  if (seq === activationSeq) restoreView(id)
}

/** 打开画布时优先回到用户上次离开时的视角（存在 mind_maps.data_json 里）；
 *  从没保存过（新画布/迁移前的旧画布）就退而求其次，落在所有贴纸摆放的几何中心——
 *  比固定回到画布原点更可能一眼看到内容。都没有（空画布）才用默认几何原点。 */
function restoreView(id: number) {
  const canvas = canvasRef.value
  if (!canvas) return
  const saved = store.canvases.find(current => current.id === id)?.data as { x?: unknown; y?: unknown; scale?: unknown } | undefined
  if (saved && typeof saved.x === 'number' && typeof saved.y === 'number' && typeof saved.scale === 'number') {
    canvas.camera.x = saved.x
    canvas.camera.y = saved.y
    canvas.camera.scale = saved.scale
    return
  }
  if (store.canvasItems.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const item of store.canvasItems) {
      const w = item.w || 244, h = item.h || 148
      minX = Math.min(minX, item.x); minY = Math.min(minY, item.y)
      maxX = Math.max(maxX, item.x + w); maxY = Math.max(maxY, item.y + h)
    }
    canvas.centerOn((minX + maxX) / 2, (minY + maxY) / 2)
    return
  }
  canvas.centerView()
}

let viewSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingViewSave: { id: number; view: { x: number; y: number; scale: number } } | null = null
function onViewChange(view: { x: number; y: number; scale: number }) {
  const id = activeCanvasId.value
  if (id == null) return
  pendingViewSave = { id, view }
  if (viewSaveTimer) clearTimeout(viewSaveTimer)
  viewSaveTimer = setTimeout(flushViewSave, 500)
}
function flushViewSave() {
  if (viewSaveTimer) clearTimeout(viewSaveTimer)
  viewSaveTimer = null
  const pending = pendingViewSave
  pendingViewSave = null
  if (pending) store.saveCanvasView(pending.id, pending.view).catch(() => {})
}
function resetView() {
  canvasRef.value?.resetScaleAtCenter()
}
onBeforeUnmount(flushViewSave)

async function createCanvas() {
  const canvas = await store.createCanvas()
  await activateCanvas(canvas.id)
}
async function openCanvas(id: number) {
  if (id === activeCanvasId.value) return
  await activateCanvas(id)
}
/** 删除当前画布后通过统一入口切到剩余画布；删除非当前画布只更新列表。 */
async function deleteCanvas(id: number) {
  const wasActive = id === activeCanvasId.value
  await store.deleteCanvas(id)
  if (!wasActive) return
  const next = store.canvases[0] ?? await store.createCanvas()
  await activateCanvas(next.id)
}

async function renameCanvas(id: number, title: string) {
  await store.renameCanvas(id, title)
}

async function removeItem(item: MindCanvasItem) {
  await store.removeCanvasItem(item.id)
}
function returnProjectToDrawer(item: MindCanvasItem) {
  void store.returnCanvasItemToDrawer(item.id).catch(() => showAppError('项目移回抽屉失败，已恢复到画布'))
}
async function removeRelation(id: number) {
  await store.removeCanvasRelation(id)
}
/** 贴纸边缘圆点拖到另一张贴纸上松手时触发，见 MindCanvas.vue 的 onConnectDragStart。 */
async function linkNodes(srcNodeId: number, dstNodeId: number, sides: RelationAnchorSides) {
  const canvasId = activeCanvasId.value
  if (canvasId == null) return
  // related 在语义上仍是无向关系；画布视图则允许同一节点对用不同端点各连一条，形成 loop。
  // 先把用户这次拖出的端点换成后端归一后的方向，再和已有边逐一比较：同端点组合直接复用，
  // 另一组端点才明确请求平行边，避免手滑重复拖出一堆完全重合的线。
  const normalizeSides = (relationSrcId: number): RelationAnchorSides =>
    relationSrcId === srcNodeId
      ? sides
      : { srcSide: sides.dstSide, dstSide: sides.srcSide }
  const samePair = store.canvasRelations.filter(relation =>
    (relation.srcNodeId === srcNodeId && relation.dstNodeId === dstNodeId) ||
    (relation.srcNodeId === dstNodeId && relation.dstNodeId === srcNodeId),
  )
  for (const current of samePair) {
    const existingSides = relationAnchors.value[String(current.id)]
    const normalized = normalizeSides(current.srcNodeId)
    if (existingSides?.srcSide === normalized.srcSide && existingSides.dstSide === normalized.dstSide) return
  }
  const relation = await store.createCanvasRelation(srcNodeId, dstNodeId, samePair.length > 0)
  if (relationAnchors.value[String(relation.id)]) return
  // related 是无向关系，后端会按 node id 归一 src/dst；随之交换锚点，保证存的是响应中那条边的方向。
  const normalized = normalizeSides(relation.srcNodeId)
  await store.saveCanvasRelationAnchors(canvasId, { ...relationAnchors.value, [relation.id]: normalized })
}
function openRef(item: MindCanvasItem) {
  if (item.node.kind !== 'ref' || !item.node.refType || item.node.refId == null) return
  openMindRef(item.node.refType, item.node.refId)
}

function centerOfViewport() {
  const canvas = canvasRef.value
  if (!canvas) return { x: 0, y: 0 }
  const center = canvas.viewportCenter()
  const world = canvas.screenToWorld(center.x, center.y)
  return { x: world.x - 122, y: world.y - 74 }
}
async function createCanvasNote() {
  if (activeCanvasId.value == null) return
  const { x, y } = centerOfViewport()
  // 画布便签不再有"无色"这个选项（见 ColorSwatches.vue 的 allowNone），新建时就得落一个
  // 默认色，不能留 null 等用户自己再点——按用户要求，默认色是橙（'amber'）。
  await store.createCanvasNote(activeCanvasId.value, { x, y, title: '新便签', color: 'amber' })
}
async function addRef(refItem: CanvasRefItem) {
  if (activeCanvasId.value == null) return
  const { x, y } = centerOfViewport()
  await store.addRefToCanvas(activeCanvasId.value, refItem.type, refItem.id, x, y)
}
async function addProjectAtCenter(projectId: number) {
  if (activeCanvasId.value == null) return
  const { x, y } = centerOfViewport()
  await store.addRefToCanvas(activeCanvasId.value, 'project', projectId, x, y)
}
/** 抽屉项目松手后先本地乐观插入一张画布卡，立刻交给抽屉克隆做落地动画——不等
 * createRefNode/addCanvasItem 这两次串行请求（真实环境轻松上百毫秒），克隆体才不会
 * 在空中冻住顿一下。接口在背后跑，成功后原地换真实数据，失败则原地摘除并提示。 */
async function addProjectAtScreen(projectId: number, center: { x: number; y: number }, _size: { w: number; h: number }) {
  const canvas = canvasRef.value
  const canvasId = activeCanvasId.value
  if (!canvas || canvasId == null) return null
  const world = canvas.screenToWorld(center.x, center.y)
  const { item, ready } = store.addProjectRefOptimistic(canvasId, projectId, world.x - 120, world.y - 60)
  ready.catch(() => showAppError('添加到画布失败，请重试'))
  await nextTick()
  return document.querySelector<HTMLElement>(`[data-canvas-item-id="${item.id}"]`)
}
async function onItemMoved(item: MindCanvasItem) {
  await store.bringCanvasItemToFront(item.id, item.x, item.y)
}
</script>

<style scoped>
.canvas-page { position: fixed; inset: 0; z-index: 8; }
</style>
