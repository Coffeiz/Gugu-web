<template>
  <div class="canvas-page">
    <MindCanvas
      ref="canvasRef"
      :items="store.canvasItems"
      :relations="store.canvasRelations"
      :relation-anchors="relationAnchors"
      @remove="removeItem"
      @remove-relation="removeRelation"
      @link-nodes="linkNodes"
      @open-ref="openRef"
      @item-moved="onItemMoved"
      @view-change="onViewChange"
    />

    <CanvasSidebar :canvases="store.canvases" :active-id="activeCanvasId" @create="createCanvas" @open="openCanvas" @delete="deleteCanvas" @rename="renameCanvas" />

    <CanvasToolbar
      :scale="canvasRef?.camera.scale ?? 1"
      @create-note="createCanvasNote"
      @add-ref="addRef"
      @zoom="delta => canvasRef?.zoomAtCenter(delta)"
      @reset-view="() => canvasRef?.centerView()"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { MindCanvasItem, MindRefSuggestItem } from '@/services/api'
import { useMindRefActions } from '@/composables/useMindRefActions'
import type { RelationAnchorSides } from '@/composables/useMindCanvas'
import { useMindStore } from '@/stores/mind'
import CanvasSidebar from './components/CanvasSidebar.vue'
import CanvasToolbar from './components/CanvasToolbar.vue'
import MindCanvas from './components/MindCanvas.vue'

type CanvasRefItem = MindRefSuggestItem & { type: 'project' | 'file' | 'event' }

const store = useMindStore()
const route = useRoute()
const router = useRouter()
const { openMindRef } = useMindRefActions()

const canvasRef = ref<InstanceType<typeof MindCanvas> | null>(null)
const activeCanvasId = computed(() => store.activeCanvasId)
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
  if (!store.loaded) await store.fetchNotes()
  if (!store.canvasesLoaded) await store.fetchCanvases()
  await ensureCanvas()
})
watch(() => route.params.id, async () => { await ensureCanvas() })

async function ensureCanvas() {
  let id = Number(route.params.id)
  if (!Number.isFinite(id) || !store.canvases.some(canvas => canvas.id === id)) {
    const canvas = store.canvases[0] || await store.createCanvas()
    id = canvas.id
    await router.replace({ name: 'MindCanvas', params: { id } })
    return
  }
  if (store.activeCanvasId !== id) {
    await store.loadCanvas(id)
    await nextTick()
    restoreView(id)
  }
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
function onViewChange(view: { x: number; y: number; scale: number }) {
  const id = activeCanvasId.value
  if (id == null) return
  if (viewSaveTimer) clearTimeout(viewSaveTimer)
  viewSaveTimer = setTimeout(() => { store.saveCanvasView(id, view).catch(() => {}) }, 500)
}

async function createCanvas() {
  const canvas = await store.createCanvas()
  await router.push({ name: 'MindCanvas', params: { id: canvas.id } })
}
async function openCanvas(id: number) {
  if (id !== activeCanvasId.value) await router.push({ name: 'MindCanvas', params: { id } })
}
/** 删的若不是当前正看着的画布，store.deleteCanvas 已经把它从 store.canvases 摘掉，
 *  CanvasSidebar 的列表跟着响应式更新，这里什么都不用做。删的正是当前画布才需要处理：
 *  路由的 id 还停在已删除的那个，不会自己变，得显式导去别的画布——优先跳列表里剩下的
 *  第一张，一张都不剩就照 ensureCanvas() 空画布兜底那一套新建一张。 */
async function deleteCanvas(id: number) {
  const wasActive = id === activeCanvasId.value
  await store.deleteCanvas(id)
  if (!wasActive) return
  const next = store.canvases[0] ?? await store.createCanvas()
  await router.push({ name: 'MindCanvas', params: { id: next.id } })
}

async function renameCanvas(id: number, title: string) {
  await store.renameCanvas(id, title)
}

async function removeItem(item: MindCanvasItem) {
  await store.removeCanvasItem(item.id)
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
async function onItemMoved(item: MindCanvasItem) {
  await store.updateCanvasItem(item.id, { x: item.x, y: item.y, z: store.nextCanvasZ() })
}
</script>

<style scoped>
.canvas-page { position: fixed; inset: 0; }
</style>
