<template>
  <div class="canvas-page">
    <MindCanvas
      ref="canvasRef"
      :items="store.canvasItems"
      :relations="store.canvasRelations"
      @remove="removeItem"
      @remove-relation="removeRelation"
      @link-nodes="linkNodes"
      @save-note="saveCanvasNote"
      @open-ref="openRef"
      @item-moved="onItemMoved"
      @view-change="onViewChange"
    />

    <CanvasSidebar :canvases="store.canvases" :active-id="activeCanvasId" @create="createCanvas" @open="openCanvas" />

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

async function removeItem(item: MindCanvasItem) {
  await store.removeCanvasItem(item.id)
}
async function removeRelation(id: number) {
  await store.removeCanvasRelation(id)
}
/** 贴纸边缘圆点拖到另一张贴纸上松手时触发，见 MindCanvas.vue 的 onConnectDragStart。 */
async function linkNodes(srcNodeId: number, dstNodeId: number) {
  await store.createCanvasRelation(srcNodeId, dstNodeId)
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
  await store.createCanvasNote(activeCanvasId.value, { x, y, title: '新便签' })
}
async function addRef(refItem: CanvasRefItem) {
  if (activeCanvasId.value == null) return
  const { x, y } = centerOfViewport()
  await store.addRefToCanvas(activeCanvasId.value, refItem.type, refItem.id, x, y)
}
async function saveCanvasNote(item: MindCanvasItem, fields: { title: string; contentMd: string }) {
  await store.updateCanvasNote(item.nodeId, fields)
}
async function onItemMoved(item: MindCanvasItem) {
  await store.updateCanvasItem(item.id, { x: item.x, y: item.y, z: store.nextCanvasZ() })
}
</script>

<style scoped>
.canvas-page { position: fixed; inset: 0; }
</style>
