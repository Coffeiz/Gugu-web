<template>
  <div ref="viewportRef" class="mind-canvas" :style="bgStyle" @pointerdown="onViewportPointerDown" @wheel.prevent="onWheelZoom">
    <div class="canvas-world" :style="worldStyle">
      <RelationLayer
        :key="canvasKey ?? 'none'"
        :items="relationItems" :relations="visibleRelations"
        :draft="connectionDrag.active ? { from: connectionDrag.from, to: connectionDrag.to, fromSide: connectionDrag.originSide, toSide: connectionDrag.targetSide } : null"
        :landing-positions="landingPositions" :measured-sizes="measuredSizes" :relation-anchors="relationAnchors"
        :hovered-node-id="hoveredNodeId" :visual-frame="runtimeVisualFrame" :active-visual-node-id="activeVisualNodeId" :screen-to-world="screenToWorld"
        @remove="id => emit('removeRelation', id)"
      />

      <template v-for="item in visibleItems" :key="item.clientKey ?? item.id">
        <NoteSticker
          v-if="item.node.kind === 'canvas_note'"
          :item="item" :connecting="connectionDrag.originNodeId === item.nodeId" :connection-target-side="connectionTargetSide(item.nodeId)" :screen-to-world="screenToWorld" :scale="camera.scale"
          @remove="item => emit('remove', item)" @measured="onItemMeasured"
          @connect-drag-start="(e, side) => onConnectDragStart(e, item.nodeId, side)" @hover="onItemHover"
        />
        <ProjectRefCard
          v-else-if="item.node.refType === 'project'"
          :item="item" :connecting="connectionDrag.originNodeId === item.nodeId" :connection-target-side="connectionTargetSide(item.nodeId)" :screen-to-world="screenToWorld" :scale="camera.scale"
          @remove="item => emit('remove', item)" @measured="onItemMeasured"
          @open="item => emit('openRef', item)" @return-to-drawer="item => emit('returnToDrawer', item)"
          @connect-drag-start="(e, side) => onConnectDragStart(e, item.nodeId, side)" @hover="onItemHover"
        />
        <FileRefCard
          v-else-if="item.node.refType === 'file'"
          :item="item" :connecting="connectionDrag.originNodeId === item.nodeId" :connection-target-side="connectionTargetSide(item.nodeId)" :screen-to-world="screenToWorld" :scale="camera.scale"
          @remove="item => emit('remove', item)" @measured="onItemMeasured"
          @open="item => emit('openRef', item)"
          @connect-drag-start="(e, side) => onConnectDragStart(e, item.nodeId, side)" @hover="onItemHover"
        />
        <EntitySticker
          v-else
          :item="item" :connecting="connectionDrag.originNodeId === item.nodeId" :connection-target-side="connectionTargetSide(item.nodeId)" :screen-to-world="screenToWorld" :scale="camera.scale"
          @remove="item => emit('remove', item)" @measured="onItemMeasured"
          @open="item => emit('openRef', item)"
          @connect-drag-start="(e, side) => onConnectDragStart(e, item.nodeId, side)" @hover="onItemHover"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/** 无限画布：相机负责平移/缩放；对象拖拽统一走 interaction runtime；这里编排关系拖拽。 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type PropType } from 'vue'
import type { MindCanvasItem, MindRelation } from '@/services/api'
import { runtime, type MoveAction, type NodeConnectionEndpoint, type RuntimeEvent } from '@/interaction/runtime'
import { MIND_CANVAS_OBJECT_TYPES, MIND_CANVAS_OBJECT_TYPE, MIND_CANVAS_SURFACE_ID, MIND_PROJECT_DRAWER_SURFACE_ID, mindCanvasObjectId, registerMindLandingTargetResolver } from '@/interaction/runtime/canvas'
import { itemSize, useMindCanvas, type RelationAnchorSides } from '@/composables/useMindCanvas'
import { overlapsWorldRect, worldViewport } from '@/utils/canvasViewport'
import { relationEnvelope } from '@/utils/canvasRelationGeometry'
import EntitySticker from './EntitySticker.vue'
import FileRefCard from './FileRefCard.vue'
import NoteSticker from './NoteSticker.vue'
import ProjectRefCard from './ProjectRefCard.vue'
import RelationLayer from './RelationLayer.vue'
import { cacheCanvasItemSize, measuredCanvasItemSize, migrateCanvasItemSize } from '../utils/canvasItemMeasurements'
import { beginRuntimeCanvasProbe, logRuntimeCanvasProbe, markRuntimeCanvasProbe, measureRuntimeCanvasProbe } from '@/utils/runtimePerformanceProbe'

const props = defineProps({
  items: { type: Array as PropType<MindCanvasItem[]>, required: true },
  relations: { type: Array as PropType<MindRelation[]>, required: true },
  relationAnchors: { type: Object as PropType<Record<string, RelationAnchorSides>>, default: () => ({}) },
  canvasKey: { type: Number as PropType<number | null>, default: null },
})
const emit = defineEmits<{
  (e: 'remove', item: MindCanvasItem): void
  (e: 'returnToDrawer', item: MindCanvasItem): void
  (e: 'removeRelation', id: number): void
  (e: 'linkNodes', srcNodeId: number, dstNodeId: number, sides: RelationAnchorSides, runtimeConnection: NodeConnectionEndpoint): void
  (e: 'openRef', item: MindCanvasItem): void
  (e: 'itemMoved', item: MindCanvasItem): void
  (e: 'viewChange', view: { x: number; y: number; scale: number; viewport?: { width: number; height: number } }): void
}>()

const viewportRef = ref<HTMLElement | null>(null)
const measuredSizes = reactive(new Map<number, { w: number; h: number }>())
const measuredSizesByClientKey = new Map<string, { w: number; h: number }>()
const viewportSize = reactive({ width: 0, height: 0 })
const {
  camera, centerView, screenToWorld, zoomAt, zoomAtCenter, workspaceCenter, onWheel,
  startPan, panMove, panEnd,
} = useMindCanvas(viewportRef)

const worldStyle = computed(() => ({ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }))
watch(() => props.items, items => {
  items.forEach(item => migrateCanvasItemSize(measuredSizes, measuredSizesByClientKey, item))
}, { immediate: true })

// 卡片和关系共用同一个缓冲视口，避免各自重新计算一套 window geometry。
const WINDOW_BUFFER_PX = 420
const bufferedWorldViewport = computed(() => {
  if (!viewportSize.width || !viewportSize.height) return null
  return worldViewport({ ...camera, ...viewportSize }, WINDOW_BUFFER_PX)
})
const itemByNodeId = computed(() => new Map(props.items.map(item => [item.nodeId, item])))
const visibleItems = computed(() => {
  const viewport = bufferedWorldViewport.value
  if (!viewport) return props.items
  return props.items.filter(item => {
    const { w, h } = measuredSizes.get(item.nodeId) ?? itemSize(item)
    return overlapsWorldRect({ x: item.x, y: item.y, w, h }, viewport)
  })
})
const visibleRelations = computed(() => {
  const viewport = bufferedWorldViewport.value
  if (!viewport) return props.relations
  return props.relations.filter(relation => {
    const src = itemByNodeId.value.get(relation.srcNodeId)
    const dst = itemByNodeId.value.get(relation.dstNodeId)
    if (!src || !dst) return false
    const srcSize = measuredSizes.get(src.nodeId) ?? itemSize(src)
    const dstSize = measuredSizes.get(dst.nodeId) ?? itemSize(dst)
    const envelope = relationEnvelope(
      { x: src.x, y: src.y, w: srcSize.w, h: srcSize.h },
      { x: dst.x, y: dst.y, w: dstSize.w, h: dstSize.h },
    )
    return overlapsWorldRect(envelope, viewport)
  })
})
const relationItems = computed(() => {
  const neededNodeIds = new Set(visibleItems.value.map(item => item.nodeId))
  for (const relation of visibleRelations.value) {
    neededNodeIds.add(relation.srcNodeId)
    neededNodeIds.add(relation.dstNodeId)
  }
  return props.items.filter(item => neededNodeIds.has(item.nodeId))
})

const bgStyle = computed(() => {
  const size = 28 * camera.scale
  return {
    backgroundPosition: `${camera.x}px ${camera.y}px`,
    backgroundSize: `${size}px ${size}px`,
  }
})

function onViewportPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  startPan(event)
}

function onItemMoved(item: MindCanvasItem, x: number, y: number) {
  item.x = x
  item.y = y
  emit('itemMoved', item)
}

function finishRuntimeMoveProbe(probe: ReturnType<typeof beginRuntimeCanvasProbe>) {
  if (!probe) return
  markRuntimeCanvasProbe(probe, 'business-end')
  measureRuntimeCanvasProbe(probe, 'business-callback', 'start', 'business-end')
  void nextTick(() => {
    markRuntimeCanvasProbe(probe, 'vue-flush-end')
    measureRuntimeCanvasProbe(probe, 'vue-flush', 'business-end', 'vue-flush-end')
  })
}

function renderedItemSize(item: MindCanvasItem): { w: number; h: number } | null {
  const element = document.querySelector<HTMLElement>(`[data-canvas-item-id="${item.id}"]`)
  if (!element || !element.isConnected) return null
  const width = element.offsetWidth
  const height = element.offsetHeight
  if (width > 0 && height > 0) return { w: width, h: height }
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || camera.scale <= 0) return null
  return { w: rect.width / camera.scale, h: rect.height / camera.scale }
}

function onRuntimeMove(action: MoveAction) {
  if (!action.objectId.startsWith('mind:')) return
  logRuntimeCanvasProbe('business-move-enter', {
    objectId: action.objectId,
    toSurfaceId: action.toSurfaceId,
    hasPoint: Boolean(action.point),
  })
  const probe = beginRuntimeCanvasProbe('pointerup')
  const item = props.items.find(current => mindCanvasObjectId(current) === action.objectId)
  if (!item) {
    finishRuntimeMoveProbe(probe)
    return
  }
  if (action.toSurfaceId === MIND_PROJECT_DRAWER_SURFACE_ID) {
    if (item.node.refType === 'project') {
      const projectId = item.node.refId
      if (projectId != null) {
        const objectId = action.objectId
        let stopResolver: (() => void) | null = null
        stopResolver = registerMindLandingTargetResolver(objectId, destination => {
          if (!destination || typeof destination !== 'object') return null
          const destinationSurface = (destination as { toSurfaceId?: unknown; columnId?: unknown }).toSurfaceId
            ?? (destination as { toSurfaceId?: unknown; columnId?: unknown }).columnId
          if (destinationSurface !== MIND_PROJECT_DRAWER_SURFACE_ID) return null
          const target = document.querySelector<HTMLElement>(`[data-project-drawer-dropzone] [data-project-id="${projectId}"]`)
          if (target) stopResolver?.()
          return target
        })
      }
      emit('returnToDrawer', item)
    }
    finishRuntimeMoveProbe(probe)
    return
  }
  if (action.toSurfaceId !== MIND_CANVAS_SURFACE_ID || !action.point) {
    finishRuntimeMoveProbe(probe)
    return
  }
  const velocity = action.releaseVelocity
  const coastX = velocity ? Math.max(-260, Math.min(260, velocity.x * 0.12)) : 0
  const coastY = velocity ? Math.max(-260, Math.min(260, velocity.y * 0.12)) : 0
  const center = screenToWorld(action.point.x + coastX, action.point.y + coastY)
  const { w, h } = renderedItemSize(item)
    ?? measuredCanvasItemSize(measuredSizes, measuredSizesByClientKey, item)
    ?? itemSize(item)
  onItemMoved(item, center.x - w / 2, center.y - h / 2)
  finishRuntimeMoveProbe(probe)
}

function onItemMeasured(item: MindCanvasItem, size: { w: number; h: number }) {
  cacheCanvasItemSize(measuredSizes, measuredSizesByClientKey, item, size)
}

let viewportResizeObserver: ResizeObserver | null = null
let stopRuntimeActions: (() => void) | null = null
let stopRuntimeVisual: (() => void) | null = null
function updateViewportSize() {
  const viewport = viewportRef.value
  if (!viewport) return
  viewportSize.width = viewport.clientWidth
  viewportSize.height = viewport.clientHeight
}
function updateViewportSizeAndEmit() {
  updateViewportSize()
  emitViewChange()
}

const hoveredNodeId = ref<number | null>(null)
function onItemHover(item: MindCanvasItem, hovering: boolean) {
  if (landingNodeIds.has(item.nodeId)) return
  if (hovering) hoveredNodeId.value = item.nodeId
  else if (hoveredNodeId.value === item.nodeId) hoveredNodeId.value = null
}

const landingPositions = reactive(new Map<number, { x: number; y: number }>())
const landingObjectNodeIds = new Map<string, number>()
const runtimeVisualFrame = ref(0)
const activeVisualNodeId = ref<number | null>(null)
const landingNodeIds = reactive(new Set<number>())
const landingProbeObjects = new Set<string>()
function onRuntimeVisual(event: RuntimeEvent) {
  if (event.type === 'move-visual-end') {
    const item = props.items.find(current => mindCanvasObjectId(current) === event.objectId)
    const nodeId = landingObjectNodeIds.get(event.objectId) ?? item?.nodeId
    landingObjectNodeIds.delete(event.objectId)
    landingProbeObjects.delete(event.objectId)
    if (activeVisualNodeId.value === nodeId) activeVisualNodeId.value = null
    if (nodeId == null) return
    landingPositions.delete(nodeId)
    landingNodeIds.delete(nodeId)
    const hovered = [...document.querySelectorAll<HTMLElement>(`[data-node-id="${nodeId}"]`)]
      .some(element => element.matches(':hover'))
    if (hovered) hoveredNodeId.value = nodeId
    return
  }
  if (event.type !== 'move-visual-update' || !event.objectId.startsWith('mind:')) return
  runtimeVisualFrame.value++
  const item = props.items.find(current => mindCanvasObjectId(current) === event.objectId)
  if (!item) return
  const nodeId = item.nodeId
  landingObjectNodeIds.set(event.objectId, nodeId)
  if (event.phase === 'active') activeVisualNodeId.value = nodeId
  const center = screenToWorld(event.rect.x + event.rect.width / 2, event.rect.y + event.rect.height / 2)
  const { w, h } = measuredSizes.get(nodeId) ?? itemSize(item)
  if (event.phase === 'landing') {
    if (!landingProbeObjects.has(event.objectId)) {
      logRuntimeCanvasProbe('landing-position-first-update', { objectId: event.objectId, nodeId })
      const probe = beginRuntimeCanvasProbe('landing-position')
      markRuntimeCanvasProbe(probe, 'position-update')
      measureRuntimeCanvasProbe(probe, 'first-position-update', 'start', 'position-update')
      landingProbeObjects.add(event.objectId)
    }
    landingPositions.set(nodeId, { x: center.x - w / 2, y: center.y - h / 2 })
    landingNodeIds.add(nodeId)
    if (hoveredNodeId.value === nodeId) hoveredNodeId.value = null
  } else {
    landingPositions.delete(nodeId)
  }
}

// ── 建立关联 ────────────────────────────────────────────────────────────────
const connectionDrag = reactive({
  active: false,
  originNodeId: null as number | null,
  originSide: 'left' as 'left' | 'right',
  targetNodeId: null as number | null,
  targetSide: null as ('left' | 'right' | null),
  from: { x: 0, y: 0 },
  to: { x: 0, y: 0 },
})
let connSpringTarget = { x: 0, y: 0 }
let connSpringVel = { x: 0, y: 0 }
let connSpringRaf = 0
let connSpringLastT: number | null = null
const CONN_SPRING = 900
const CONN_DAMP = 2 * 0.7 * Math.sqrt(CONN_SPRING)
function connSpringFrame(now: number) {
  let dt = connSpringLastT === null ? 1 / 60 : (now - connSpringLastT) / 1000
  connSpringLastT = now
  if (dt > 1 / 20) dt = 1 / 20
  let rem = dt
  while (rem > 1e-4) {
    const h = Math.min(rem, 1 / 120)
    rem -= h
    const ax = CONN_SPRING * (connSpringTarget.x - connectionDrag.to.x) - CONN_DAMP * connSpringVel.x
    const ay = CONN_SPRING * (connSpringTarget.y - connectionDrag.to.y) - CONN_DAMP * connSpringVel.y
    connSpringVel.x += ax * h
    connSpringVel.y += ay * h
    connectionDrag.to = {
      x: connectionDrag.to.x + connSpringVel.x * h,
      y: connectionDrag.to.y + connSpringVel.y * h,
    }
  }
  const origin = props.items.find(current => current.nodeId === connectionDrag.originNodeId)
  if (origin) connectionDrag.from = connectionAnchor(origin, connectionDrag.originSide)
  if (connectionDrag.active) connSpringRaf = requestAnimationFrame(connSpringFrame)
}
function connectionAnchor(item: MindCanvasItem, side: 'left' | 'right') {
  const { w, h } = measuredSizes.get(item.nodeId) ?? itemSize(item)
  const card = document.querySelector<HTMLElement>(`[data-node-id="${item.nodeId}"]`)
  const dot = document.querySelector<HTMLElement>(
    `.phys-conn-dot-manager[data-node-id="${item.nodeId}"] .conn-dot-${side}, [data-node-id="${item.nodeId}"] .card-conn-dots .conn-dot-${side}`,
  )
  const cardRect = card?.isConnected ? card.getBoundingClientRect() : null
  const dotRect = dot?.isConnected ? dot.getBoundingClientRect() : null
  const measured = cardRect && cardRect.width > 0 && cardRect.height > 0
    ? { w: cardRect.width / camera.scale, h: cardRect.height / camera.scale }
    : null
  if (measured) measuredSizes.set(item.nodeId, measured)
  return dotRect && dotRect.width > 0 && dotRect.height > 0
    ? screenToWorld(dotRect.left + dotRect.width / 2, dotRect.top + dotRect.height / 2)
    : {
        x: item.x + (side === 'right' ? (measured?.w ?? w) : 0),
        y: item.y + (measured?.h ?? h) / 2,
      }
}
function connectionTargetSide(nodeId: number) {
  return connectionDrag.targetNodeId === nodeId ? connectionDrag.targetSide : null
}

type ClientPoint = Pick<PointerEvent, 'clientX' | 'clientY'>
function targetAt(event: ClientPoint, originNodeId: number) {
  const port = runtime.hitNodePort(
    { x: event.clientX, y: event.clientY },
    { objectType: MIND_CANVAS_OBJECT_TYPE, snapToObject: true },
  )
  const item = port?.objectId.startsWith('mind:')
    ? props.items.find(current => mindCanvasObjectId(current) === port.objectId)
    : undefined
  if (!item) return null
  const nodeId = item.nodeId
  if (nodeId === originNodeId || landingNodeIds.has(nodeId)) return null
  return { item, side: port!.side }
}
function updateConnectionTarget(event: ClientPoint) {
  const originNodeId = connectionDrag.originNodeId
  if (originNodeId == null) return
  const target = targetAt(event, originNodeId)
  connectionDrag.targetNodeId = target?.item.nodeId ?? null
  connectionDrag.targetSide = target?.side ?? null
  connSpringTarget = target
    ? connectionAnchor(target.item, target.side)
    : screenToWorld(event.clientX, event.clientY)
}

// 鼠标在按住左键拉关系时仍可按住中键平移。MouseEvent 会为第二个按键继续发 mousedown，
// PointerEvent 的 pointerdown 则不会，所以这里专门监听 mousedown，但 camera 差值算法仍复用
// useMindCanvas 的 startPan/panMove/panEnd，不维护第二套相机状态机。
const CONNECTION_MIDDLE_PAN_ID = -1
let connectionMiddlePanActive = false
function onConnectionMiddleMouseDown(event: MouseEvent) {
  if (!connectionDrag.active || event.button !== 1 || connectionMiddlePanActive) return
  event.preventDefault()
  connectionMiddlePanActive = true
  startPan({
    pointerId: CONNECTION_MIDDLE_PAN_ID,
    clientX: event.clientX,
    clientY: event.clientY,
  }, false)
  window.addEventListener('mousemove', onConnectionMiddleMouseMove, true)
  window.addEventListener('mouseup', onConnectionMiddleMouseUp, true)
}
function onConnectionMiddleMouseMove(event: MouseEvent) {
  if (!connectionMiddlePanActive) return
  if ((event.buttons & 4) === 0) {
    endConnectionMiddlePan(event)
    return
  }
  if (panMove({
    pointerId: CONNECTION_MIDDLE_PAN_ID,
    clientX: event.clientX,
    clientY: event.clientY,
  })) {
    // 相机移动后同一屏幕指针对应的世界坐标已经变化，立即重算 draft 目标，不等下一帧。
    updateConnectionTarget(event)
  }
}
function onConnectionMiddleMouseUp(event: MouseEvent) {
  if (event.button !== 1) return
  event.preventDefault()
  endConnectionMiddlePan(event)
}
function endConnectionMiddlePan(point?: ClientPoint) {
  if (!connectionMiddlePanActive) return
  connectionMiddlePanActive = false
  panEnd({
    pointerId: CONNECTION_MIDDLE_PAN_ID,
    clientX: point?.clientX ?? 0,
    clientY: point?.clientY ?? 0,
  })
  window.removeEventListener('mousemove', onConnectionMiddleMouseMove, true)
  window.removeEventListener('mouseup', onConnectionMiddleMouseUp, true)
  emitViewChange()
  if (point && connectionDrag.active) updateConnectionTarget(point)
}

function onConnectDragStart(event: PointerEvent, nodeId: number, side: 'left' | 'right') {
  const origin = props.items.find(current => current.nodeId === nodeId)
  if (!origin) return
  if (!runtime.beginNodeConnection(mindCanvasObjectId(origin), side)) return
  connectionDrag.active = true
  connectionDrag.originNodeId = nodeId
  connectionDrag.originSide = side
  connectionDrag.targetNodeId = null
  connectionDrag.targetSide = null
  connSpringTarget = screenToWorld(event.clientX, event.clientY)
  connectionDrag.to = { ...connSpringTarget }
  connSpringVel = { x: 0, y: 0 }
  connSpringLastT = null
  connectionDrag.from = connectionAnchor(origin, side)
  window.addEventListener('pointermove', onConnectionDragMove)
  window.addEventListener('pointerup', onConnectionDragEnd)
  window.addEventListener('mousedown', onConnectionMiddleMouseDown, true)
  connSpringRaf = requestAnimationFrame(connSpringFrame)
}
function onConnectionDragMove(event: PointerEvent) {
  runtime.updateNodeConnection({ x: event.clientX, y: event.clientY })
  updateConnectionTarget(event)
}
function onConnectionDragEnd(event: PointerEvent) {
  window.removeEventListener('pointermove', onConnectionDragMove)
  window.removeEventListener('pointerup', onConnectionDragEnd)
  window.removeEventListener('mousedown', onConnectionMiddleMouseDown, true)
  endConnectionMiddlePan(event)
  cancelAnimationFrame(connSpringRaf)
  const originNodeId = connectionDrag.originNodeId
  const target = originNodeId == null ? null : targetAt(event, originNodeId)
  connectionDrag.active = false
  connectionDrag.originNodeId = null
  connectionDrag.targetNodeId = null
  connectionDrag.targetSide = null
  if (originNodeId == null || !target) {
    runtime.cancelNodeConnection()
    return
  }
  const source = props.items.find(item => item.nodeId === originNodeId)
  if (!source) {
    runtime.cancelNodeConnection()
    return
  }
  const runtimeConnection: NodeConnectionEndpoint = {
    sourceObjectId: mindCanvasObjectId(source),
    sourcePortId: connectionDrag.originSide,
    targetObjectId: mindCanvasObjectId(target.item),
    targetPortId: target.side,
  }
  if (!runtime.finishNodeConnection(runtimeConnection.targetObjectId, runtimeConnection.targetPortId)) return
  emit('linkNodes', originNodeId, target.item.nodeId, {
    srcSide: connectionDrag.originSide,
    dstSide: target.side,
  }, runtimeConnection)
}

function onPointerMove(event: PointerEvent) {
  panMove(event)
}
function onPointerUp(event: PointerEvent) {
  if (panEnd(event)) emitViewChange()
}
function onWheelZoom(event: WheelEvent) {
  onWheel(event)
  emitViewChange()
}
function emitViewChange() {
  emit('viewChange', {
    x: camera.x, y: camera.y, scale: camera.scale,
    ...(viewportSize.width > 0 && viewportSize.height > 0
      ? { viewport: { width: viewportSize.width, height: viewportSize.height } }
      : {}),
  })
}
function zoomAtCenterAndEmit(delta: number) {
  zoomAtCenter(delta)
  emitViewChange()
}
function resetScaleAtCenterAndEmit() {
  const center = workspaceCenter()
  zoomAt(center.x, center.y, 1)
  emitViewChange()
}
function centerViewAndEmit() {
  centerView()
  emitViewChange()
}
function centerOn(worldX: number, worldY: number) {
  const viewport = viewportRef.value
  if (!viewport) return
  camera.scale = 1
  camera.x = viewport.clientWidth / 2 - worldX
  camera.y = viewport.clientHeight / 2 - worldY
  emitViewChange()
}
function viewportCenter() {
  const rect = viewportRef.value?.getBoundingClientRect()
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 }
}

defineExpose({ camera, centerView: centerViewAndEmit, centerOn, screenToWorld, zoomAt, zoomAtCenter: zoomAtCenterAndEmit, resetScaleAtCenter: resetScaleAtCenterAndEmit, viewportCenter })

onMounted(() => {
  runtime.surfaces.register({
    id: MIND_CANVAS_SURFACE_ID,
    type: 'canvas-free',
    element: viewportRef.value,
    viewport: () => viewportRef.value,
    accepts: [...MIND_CANVAS_OBJECT_TYPES],
    layout: 'free',
    camera: {
      scale: () => camera.scale,
      origin: () => ({ left: camera.x, top: camera.y }),
    },
  })
  logRuntimeCanvasProbe('runtime-action-bound')
  stopRuntimeActions = runtime.onAction(action => {
    if (action.type === 'move') {
      logRuntimeCanvasProbe('runtime-move-received', { objectId: action.objectId, toSurfaceId: action.toSurfaceId })
      onRuntimeMove(action as MoveAction)
    }
  })
  stopRuntimeVisual = runtime.subscribe(onRuntimeVisual)
  updateViewportSizeAndEmit()
  viewportResizeObserver = new ResizeObserver(updateViewportSizeAndEmit)
  if (viewportRef.value) viewportResizeObserver.observe(viewportRef.value)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
})
onBeforeUnmount(() => {
  runtime.cancelNodeConnection()
  stopRuntimeActions?.()
  stopRuntimeActions = null
  stopRuntimeVisual?.()
  stopRuntimeVisual = null
  runtime.surfaces.unregister(MIND_CANVAS_SURFACE_ID)
  viewportResizeObserver?.disconnect()
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointermove', onConnectionDragMove)
  window.removeEventListener('pointerup', onConnectionDragEnd)
  window.removeEventListener('mousedown', onConnectionMiddleMouseDown, true)
  window.removeEventListener('mousemove', onConnectionMiddleMouseMove, true)
  window.removeEventListener('mouseup', onConnectionMiddleMouseUp, true)
  if (connectionMiddlePanActive) {
    connectionMiddlePanActive = false
    panEnd({ pointerId: CONNECTION_MIDDLE_PAN_ID, clientX: 0, clientY: 0 })
  }
  cancelAnimationFrame(connSpringRaf)
  landingObjectNodeIds.clear()
})
</script>

<style scoped>
.mind-canvas {
  position: fixed; inset: 0; z-index: 0; overflow: hidden; cursor: grab; user-select: none;
  background-color: #e8ebf3;
  background-image: radial-gradient(circle, rgba(108, 116, 153, .34) 6.5%, transparent 7%);
}
.mind-canvas:active { cursor: grabbing; }
.canvas-world { position: absolute; width: 0; height: 0; transform-origin: 0 0; }
</style>
