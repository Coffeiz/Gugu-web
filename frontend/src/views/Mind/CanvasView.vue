<template>
  <div ref="viewportRef" class="canvas-view" @pointerdown="startPan" @wheel.prevent="onWheel">
    <div class="canvas-world" :style="worldStyle">
      <svg class="relation-layer" viewBox="-5000 -5000 10000 10000" aria-hidden="true">
        <line
          v-for="relation in visibleRelations"
          :key="relation.id"
          :x1="relation.from.x" :y1="relation.from.y"
          :x2="relation.to.x" :y2="relation.to.y"
        />
      </svg>
      <CanvasNoteSticker
        v-for="item in store.canvasItems"
        :key="item.id"
        :item="item"
        :selected="selectedItemId === item.id"
        :connecting="connectingNodeId === item.nodeId"
        @select="selectItem"
        @drag-start="startItemDrag"
      />
    </div>

    <aside class="canvas-list glass-card" @pointerdown.stop>
      <div class="cl-head"><span>画布</span><button title="新建画布" @click="createCanvas"><PhPlus :size="15" weight="bold" /></button></div>
      <button
        v-for="canvas in store.canvases"
        :key="canvas.id"
        class="canvas-list-item"
        :class="{ active: canvas.id === activeCanvasId }"
        @click="openCanvas(canvas.id)"
      >
        <PhGraph :size="14" weight="bold" />
        <span>{{ canvas.title || '未命名画布' }}</span>
      </button>
    </aside>

    <div class="canvas-tools glass-card" @pointerdown.stop>
      <button title="新建画布便签" @click="createCanvasNote"><PhNotePencil :size="16" weight="bold" /></button>
      <button title="添加项目、文件或活动" :class="{ active: pickerOpen }" @click="openRefPicker"><PhPlus :size="16" weight="bold" /></button>
      <span class="tool-divider"></span>
      <button title="缩小" @click="zoomAtCenter(-.12)"><PhMinus :size="15" weight="bold" /></button>
      <button title="恢复 100%" class="zoom-label" @click="resetView">{{ Math.round(camera.scale * 100) }}%</button>
      <button title="放大" @click="zoomAtCenter(.12)"><PhPlus :size="15" weight="bold" /></button>
    </div>

    <section v-if="pickerOpen" class="note-picker glass-card" @pointerdown.stop>
      <div class="np-head"><span>添加项目、文件或活动</span><button title="关闭" @click="pickerOpen = false"><PhX :size="14" weight="bold" /></button></div>
      <input v-model="refQuery" class="np-search" placeholder="搜索项目、文件、活动" />
      <button v-for="ref in refResults" :key="`${ref.type}-${ref.id}`" class="np-note" @click="addRef(ref)">
        <strong>{{ ref.label }}</strong><span>{{ refTypeLabel(ref.type) }}{{ ref.subtitle ? ` · ${ref.subtitle}` : '' }}</span>
      </button>
      <div v-if="refQuery && !refResults.length" class="np-empty">没有找到可添加的对象</div>
    </section>

    <CanvasInspector
      :item="selectedItem"
      :relation-count="selectedRelationCount"
      :connecting="connectingNodeId === selectedItem?.nodeId"
      @close="selectedItemId = null"
      @connect="toggleConnect"
      @remove="removeSelected"
      @save="saveCanvasNote"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PhGraph, PhMinus, PhNotePencil, PhPlus, PhX } from '@phosphor-icons/vue'
import type { MindCanvasItem, MindRefSuggestItem } from '@/services/api'
import { mindApi } from '@/services/api'
import { useMindStore } from '@/stores/mind'
import CanvasInspector from './components/CanvasInspector.vue'
import CanvasNoteSticker from './components/CanvasNoteSticker.vue'

const store = useMindStore()
const route = useRoute()
const router = useRouter()
const viewportRef = ref<HTMLElement | null>(null)
const selectedItemId = ref<number | null>(null)
const pickerOpen = ref(false)
const refQuery = ref('')
const refResults = ref<MindRefSuggestItem[]>([])
const connectingNodeId = ref<number | null>(null)
const camera = reactive({ x: 0, y: 0, scale: 1 })
const activeCanvasId = computed(() => store.activeCanvasId)
const worldStyle = computed(() => ({ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }))
const selectedItem = computed(() => store.canvasItems.find(item => item.id === selectedItemId.value) || null)
const selectedRelationCount = computed(() => selectedItem.value
  ? store.canvasRelations.filter(relation => relation.srcNodeId === selectedItem.value!.nodeId || relation.dstNodeId === selectedItem.value!.nodeId).length
  : 0)
const itemByNodeId = computed(() => new Map(store.canvasItems.map(item => [item.nodeId, item])))
const visibleRelations = computed(() => store.canvasRelations.flatMap((relation) => {
  const src = itemByNodeId.value.get(relation.srcNodeId)
  const dst = itemByNodeId.value.get(relation.dstNodeId)
  if (!src || !dst) return []
  return [{ id: relation.id, from: itemCenter(src), to: itemCenter(dst) }]
}))

let pan: { pointerId: number; startX: number; startY: number; originX: number; originY: number } | null = null
let itemDrag: { pointerId: number; itemId: number; startX: number; startY: number; originX: number; originY: number } | null = null
let viewInitialized = false

onMounted(async () => {
  if (!store.loaded) await store.fetchNotes()
  if (!store.canvasesLoaded) await store.fetchCanvases()
  await ensureCanvas()
})

watch(() => route.params.id, async () => {
  await ensureCanvas()
})
watch(refQuery, async (query) => {
  const value = query.trim()
  refResults.value = value ? await mindApi.refSuggest(value) : []
})

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
    selectedItemId.value = null
    connectingNodeId.value = null
    await nextTick()
    centerView()
  }
}

function centerView() {
  const viewport = viewportRef.value
  if (!viewport) return
  camera.x = viewport.clientWidth / 2
  camera.y = viewport.clientHeight / 2
  camera.scale = 1
  viewInitialized = true
}

function itemCenter(item: MindCanvasItem) {
  return { x: item.x + (item.w || 244) / 2, y: item.y + (item.h || 148) / 2 }
}

async function createCanvas() {
  const canvas = await store.createCanvas()
  await router.push({ name: 'MindCanvas', params: { id: canvas.id } })
}
async function openCanvas(id: number) {
  if (id !== activeCanvasId.value) await router.push({ name: 'MindCanvas', params: { id } })
}
function selectItem(item: MindCanvasItem) {
  if (connectingNodeId.value != null && connectingNodeId.value !== item.nodeId) {
    store.createCanvasRelation(connectingNodeId.value, item.nodeId)
    connectingNodeId.value = null
  }
  selectedItemId.value = item.id
}
function toggleConnect() {
  connectingNodeId.value = connectingNodeId.value === selectedItem.value?.nodeId ? null : selectedItem.value?.nodeId || null
}
async function removeSelected() {
  if (selectedItemId.value == null) return
  await store.removeCanvasItem(selectedItemId.value)
  selectedItemId.value = null
  connectingNodeId.value = null
}
function openRefPicker() {
  pickerOpen.value = !pickerOpen.value
  refQuery.value = ''
}
async function createCanvasNote() {
  const viewport = viewportRef.value
  if (!viewport || activeCanvasId.value == null) return
  const x = (viewport.clientWidth / 2 - camera.x) / camera.scale - 122
  const y = (viewport.clientHeight / 2 - camera.y) / camera.scale - 74
  const item = await store.createCanvasNote(activeCanvasId.value, { x, y, title: '新便签' })
  selectedItemId.value = item.id
}
async function addRef(refItem: MindRefSuggestItem) {
  const viewport = viewportRef.value
  if (!viewport || activeCanvasId.value == null) return
  const x = (viewport.clientWidth / 2 - camera.x) / camera.scale - 122
  const y = (viewport.clientHeight / 2 - camera.y) / camera.scale - 74
  const item = await store.addRefToCanvas(activeCanvasId.value, refItem.type, refItem.id, x, y)
  selectedItemId.value = item.id
  pickerOpen.value = false
  refQuery.value = ''
}
function refTypeLabel(type: MindRefSuggestItem['type']) {
  return ({ project: '项目', file: '文件', event: '活动' }[type])
}
async function saveCanvasNote(fields: { title: string; contentMd: string }) {
  if (!selectedItem.value) return
  await store.updateCanvasNote(selectedItem.value.nodeId, fields)
}

function startPan(event: PointerEvent) {
  if (event.button !== 0 || itemDrag) return
  selectedItemId.value = null
  connectingNodeId.value = null
  pan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: camera.x, originY: camera.y }
  viewportRef.value?.setPointerCapture(event.pointerId)
}
function startItemDrag(event: PointerEvent, item: MindCanvasItem) {
  if (event.button !== 0) return
  if (connectingNodeId.value != null) return
  selectedItemId.value = item.id
  itemDrag = { pointerId: event.pointerId, itemId: item.id, startX: event.clientX, startY: event.clientY, originX: item.x, originY: item.y }
  viewportRef.value?.setPointerCapture(event.pointerId)
}
function onPointerMove(event: PointerEvent) {
  if (pan?.pointerId === event.pointerId) {
    camera.x = pan.originX + event.clientX - pan.startX
    camera.y = pan.originY + event.clientY - pan.startY
  }
  if (itemDrag?.pointerId === event.pointerId) {
    const item = store.canvasItems.find(current => current.id === itemDrag!.itemId)
    if (!item) return
    item.x = itemDrag.originX + (event.clientX - itemDrag.startX) / camera.scale
    item.y = itemDrag.originY + (event.clientY - itemDrag.startY) / camera.scale
  }
}
async function onPointerUp(event: PointerEvent) {
  if (itemDrag?.pointerId === event.pointerId) {
    const item = store.canvasItems.find(current => current.id === itemDrag!.itemId)
    const drag = itemDrag
    itemDrag = null
    if (item) await store.updateCanvasItem(item.id, { x: item.x, y: item.y, z: store.nextCanvasZ() })
    viewportRef.value?.releasePointerCapture(drag.pointerId)
  }
  if (pan?.pointerId === event.pointerId) {
    viewportRef.value?.releasePointerCapture(pan.pointerId)
    pan = null
  }
}
function onWheel(event: WheelEvent) {
  const viewport = viewportRef.value
  if (!viewport) return
  const rect = viewport.getBoundingClientRect()
  const factor = event.deltaY < 0 ? 1.1 : .9
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, camera.scale * factor)
}
function zoomAtCenter(delta: number) {
  const viewport = viewportRef.value
  if (!viewport) return
  zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, camera.scale + delta)
}
function zoomAt(screenX: number, screenY: number, nextScale: number) {
  const scale = Math.min(1.7, Math.max(.45, nextScale))
  const worldX = (screenX - camera.x) / camera.scale
  const worldY = (screenY - camera.y) / camera.scale
  camera.scale = scale
  camera.x = screenX - worldX * scale
  camera.y = screenY - worldY * scale
}
function resetView() { centerView() }

function onResize() {
  if (!viewInitialized) return
  centerView()
}
window.addEventListener('pointermove', onPointerMove)
window.addEventListener('pointerup', onPointerUp)
window.addEventListener('resize', onResize)
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('resize', onResize)
})
</script>

<style scoped>
.canvas-view {
  position: fixed; inset: 0; z-index: 0; overflow: hidden; cursor: grab; user-select: none;
  background-color: #e8ebf3;
  background-image: radial-gradient(circle, rgba(108, 116, 153, .28) .8px, transparent .9px);
  background-size: 20px 20px;
}
.canvas-view:active { cursor: grabbing; }
.canvas-world { position: absolute; width: 0; height: 0; transform-origin: 0 0; will-change: transform; }
.relation-layer { position: absolute; left: -5000px; top: -5000px; width: 10000px; height: 10000px; overflow: visible; pointer-events: none; }
.relation-layer line { stroke: rgba(104, 111, 164, .45); stroke-width: 2; stroke-dasharray: 5 6; }
.canvas-list { position: absolute; top: 12px; left: 12px; z-index: 8; width: 176px; padding: 9px; border-radius: 8px; background: rgba(249,250,255,.68); border: 1px solid rgba(255,255,255,.82); }
.cl-head { display: flex; align-items: center; justify-content: space-between; height: 28px; padding: 0 5px 4px 7px; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.cl-head button, .canvas-tools button, .np-head button { display: inline-flex; align-items: center; justify-content: center; border: 0; background: none; color: var(--text-secondary); cursor: pointer; }
.cl-head button { width: 25px; height: 25px; border-radius: 6px; }
.cl-head button:hover, .canvas-tools button:hover, .np-head button:hover { color: var(--color-primary); background: rgba(123,127,178,.11); }
.canvas-list-item { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: 6px; background: none; color: var(--text-secondary); text-align: left; font-size: 12px; cursor: pointer; }
.canvas-list-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.canvas-list-item:hover { background: rgba(255,255,255,.55); }
.canvas-list-item.active { background: rgba(255,255,255,.86); color: var(--color-primary); font-weight: 700; box-shadow: 0 1px 3px rgba(60,70,100,.08); }
.canvas-tools { position: absolute; left: 50%; bottom: 18px; z-index: 8; display: flex; align-items: center; height: 42px; padding: 0 7px; border-radius: 999px; background: rgba(249,250,255,.82); border: 1px solid rgba(255,255,255,.88); box-shadow: 0 8px 22px rgba(70,78,108,.14); transform: translateX(-50%); }
.canvas-tools button { width: 32px; height: 32px; border-radius: 999px; }
.canvas-tools button.active { background: rgba(123,127,178,.15); color: var(--color-primary); }
.canvas-tools .zoom-label { width: 45px; font-size: 11px; font-weight: 700; }
.tool-divider { width: 1px; height: 17px; margin: 0 4px; background: rgba(123,127,178,.18); }
.note-picker { position: absolute; left: 202px; top: 12px; z-index: 9; width: 270px; max-height: 390px; overflow: auto; padding: 10px; border-radius: 8px; background: rgba(249,250,255,.86); border: 1px solid rgba(255,255,255,.85); }
.np-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 8px; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.np-head button { width: 24px; height: 24px; border-radius: 5px; }
.np-search { width: 100%; height: 31px; box-sizing: border-box; margin: 0 0 6px; padding: 0 9px; border: 1px solid rgba(123,127,178,.15); border-radius: 6px; outline: 0; background: rgba(255,255,255,.56); color: var(--text-primary); font: inherit; font-size: 11.5px; }
.np-search:focus { border-color: rgba(123,127,178,.45); background: rgba(255,255,255,.8); }
.np-note { display: flex; flex-direction: column; gap: 3px; width: 100%; padding: 9px; border: 0; border-radius: 6px; background: none; color: var(--text-primary); text-align: left; cursor: pointer; }
.np-note:hover { background: rgba(255,255,255,.72); }
.np-note strong, .np-note span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.np-note strong { font-size: 12px; }
.np-note span, .np-empty { color: var(--text-secondary); font-size: 11px; }
.np-empty { padding: 18px 8px; text-align: center; }
</style>
