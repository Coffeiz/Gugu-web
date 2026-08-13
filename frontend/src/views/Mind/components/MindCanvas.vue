<template>
  <div ref="viewportRef" class="mind-canvas" :style="bgStyle" @pointerdown="onViewportPointerDown" @wheel.prevent="onWheelZoom">
    <div class="canvas-world" :style="worldStyle">
      <RelationLayer
        :key="canvasKey ?? 'none'"
        :items="relationItems" :relations="visibleRelations" :highlight-node-id="connectionDrag.originNodeId"
        :draft="connectionDrag.active ? { from: connectionDrag.from, to: connectionDrag.to, fromSide: connectionDrag.originSide, toSide: connectionDrag.targetSide } : null"
        :landing-positions="landingPositions" :measured-sizes="measuredSizes" :relation-anchors="relationAnchors"
        :hovered-node-id="hoveredNodeId" :screen-to-world="screenToWorld"
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
/** 无限画布：平移/缩放 + 贴纸绝对定位渲染，相机数学委托给 useMindCanvas.ts；贴纸拖拽统一走
 *  全站卡片物理模块（见各贴纸组件里的 useCardDrag.ts），这里只负责相机、建立关联的拖拽手势
 *  编排（贴纸边缘圆点拖到另一张贴纸上，见 onConnectDragStart 一带）。 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, type PropType } from 'vue'
import './canvas-card-effects.css'
import type { MindCanvasItem, MindRelation } from '@/services/api'
import { runtime, type MoveAction, type RuntimeEvent } from '@/interaction/runtime'
import { MIND_CANVAS_OBJECT_TYPES, MIND_CANVAS_OBJECT_TYPE, MIND_CANVAS_SURFACE_ID, MIND_PROJECT_DRAWER_SURFACE_ID, mindCanvasObjectId, registerMindLandingTargetResolver } from '@/interaction/runtime/canvas'
import { itemSize, useMindCanvas, type RelationAnchorSides } from '@/composables/useMindCanvas'
import { overlapsWorldRect, worldViewport } from '@/utils/canvasViewport'
import EntitySticker from './EntitySticker.vue'
import FileRefCard from './FileRefCard.vue'
import NoteSticker from './NoteSticker.vue'
import ProjectRefCard from './ProjectRefCard.vue'
import RelationLayer from './RelationLayer.vue'

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
  (e: 'linkNodes', srcNodeId: number, dstNodeId: number, sides: RelationAnchorSides): void
  (e: 'openRef', item: MindCanvasItem): void
  (e: 'itemMoved', item: MindCanvasItem): void
  (e: 'viewChange', view: { x: number; y: number; scale: number }): void
}>()

const viewportRef = ref<HTMLElement | null>(null)
const measuredSizes = reactive(new Map<number, { w: number; h: number }>())
const viewportSize = reactive({ width: 0, height: 0 })
const {
  camera, centerView, screenToWorld, zoomAt, zoomAtCenter, workspaceCenter, onWheel,
  startPan, panMove, panEnd,
} = useMindCanvas(viewportRef)

const worldStyle = computed(() => ({ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }))
// 贴纸和连线只渲染在视口附近。420px 缓冲给边缘拖拽、连线和快速平移留出余量；缓冲按
// 屏幕像素定义，缩放时换算成世界坐标，因此不会在不同倍率下改变可见范围的体感。
const WINDOW_BUFFER_PX = 420
const visibleItems = computed(() => {
  // 首次挂载前还没有 DOM 尺寸，先保守地完整渲染一帧，不能把画布误判为空。
  if (!viewportSize.width || !viewportSize.height) return props.items
  const viewport = worldViewport({ ...camera, ...viewportSize }, WINDOW_BUFFER_PX)
  return props.items.filter(item => {
    const { w, h } = measuredSizes.get(item.nodeId) ?? itemSize(item)
    return overlapsWorldRect({ x: item.x, y: item.y, w, h }, viewport)
  })
})
const visibleRelations = computed(() => {
  const visibleNodeIds = new Set(visibleItems.value.map(item => item.nodeId))
  // 只要一端还在窗口里，线就必须保留并延伸向远处节点；否则用户会看到可见卡片的关联
  // 突然消失。两端都在窗口外的线才不画。远端卡片本身仍不挂载，只把它的几何数据交给 SVG。
  return props.relations.filter(relation =>
    visibleNodeIds.has(relation.srcNodeId) || visibleNodeIds.has(relation.dstNodeId),
  )
})
const relationItems = computed(() => {
  const neededNodeIds = new Set(visibleItems.value.map(item => item.nodeId))
  for (const relation of visibleRelations.value) {
    neededNodeIds.add(relation.srcNodeId)
    neededNodeIds.add(relation.dstNodeId)
  }
  return props.items.filter(item => neededNodeIds.has(item.nodeId))
})
// 点阵背景要跟着世界一起平移/缩放，才能看出"画布真的在动"（而不是贴纸飘在一张静止的纸上）；
// 点阵本身画在 viewport 层（没有 canvas-world 的 scale 会拉伸成椭圆），故背景尺寸也要乘 scale 才能对齐。
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
/** Runtime 在松手时给出最终世界位置，这里只负责更新模型并通知页面持久化。 */
function onItemMoved(item: MindCanvasItem, x: number, y: number) {
  item.x = x
  item.y = y
  emit('itemMoved', item)
}

/**
 * 读取当前画布卡片的布局尺寸。offset 尺寸不包含画布 camera transform、抓取倾斜和
 * landing 代理的视觉缩放，正好是落点换算需要的世界尺寸。乐观节点换成真实 nodeId
 * 的交接窗口里，measuredSizes 可能还没有迁移完成，因此这里必须优先读活 DOM。
 */
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
  const item = props.items.find(current => mindCanvasObjectId(current) === action.objectId)
  if (!item) return
  const nodeId = item.nodeId
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
    return
  }
  if (action.toSurfaceId !== MIND_CANVAS_SURFACE_ID || !action.point) return
  const velocity = action.releaseVelocity
  const coastX = velocity ? Math.max(-260, Math.min(260, velocity.x * 0.12)) : 0
  const coastY = velocity ? Math.max(-260, Math.min(260, velocity.y * 0.12)) : 0
  const center = screenToWorld(action.point.x + coastX, action.point.y + coastY)
  const { w, h } = renderedItemSize(item) ?? measuredSizes.get(nodeId) ?? itemSize(item)
  onItemMoved(item, center.x - w / 2, center.y - h / 2)
}

/** 卡片尺寸变化时同步给 RelationLayer；拖动中的位置由 Runtime 代理事件提供。 */
function onItemMeasured(item: MindCanvasItem, size: { w: number; h: number }) {
  measuredSizes.set(item.nodeId, size)
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

// 悬浮抬起（见各贴纸组件的 .hover-card-fx）用纯 CSS transform，SVG 连线不知道 DOM 层面的
// :hover 状态，得靠贴纸自己上报——不然抬起来的卡片和还锚在旧位置的连线会错位一截。只记
// 「当前悬浮的是哪一张」（同一时间只有一张会真的抬起，鼠标只会停在一张卡片上），RelationLayer
// 收到 nodeId 后按同一个像素量自己算偏移量（见其 hoverLift）。
const hoveredNodeId = ref<number | null>(null)
function onItemHover(item: MindCanvasItem, hovering: boolean) {
  // 本体在落地阶段已经提前写到最终坐标、但视觉仍由克隆接管。此时浏览器可能对透明本体
  // 继续派发 hover；不能让 RelationLayer 又把端点抬回去，等落地完成后的真实 mouseenter
  // 再恢复即可。
  if (landingNodeIds.has(item.nodeId)) return
  if (hovering) hoveredNodeId.value = item.nodeId
  else if (hoveredNodeId.value === item.nodeId) hoveredNodeId.value = null
}

const landingPositions = reactive(new Map<number, { x: number; y: number }>())
// 有键就代表这张卡还在克隆落地阶段：透明本体已经在最终坐标，但视觉卡片尚未落下，连线拖拽
// 不能把它提前识别成可吸附目标。
const landingNodeIds = reactive(new Set<number>())
/** Runtime 代理的实际屏幕盒是连接线在拖动/落地期间唯一可信的临时几何来源。
 * 这里只覆盖 RelationLayer 的位置，不写回 item.x/y，也不参与卡片动画。 */
function onRuntimeVisual(event: RuntimeEvent) {
  if (event.type === 'move-visual-end') {
    const item = props.items.find(current => mindCanvasObjectId(current) === event.objectId)
    if (!item) return
    const nodeId = item.nodeId
    landingPositions.delete(nodeId)
    landingNodeIds.delete(nodeId)
    const hovered = [...document.querySelectorAll<HTMLElement>(`[data-node-id="${nodeId}"]`)]
      .some(element => element.matches(':hover'))
    if (hovered) hoveredNodeId.value = nodeId
    return
  }
  if (event.type !== 'move-visual-update' || !event.objectId.startsWith('mind:')) return
  const item = props.items.find(current => mindCanvasObjectId(current) === event.objectId)
  if (!item) return
  const nodeId = item.nodeId
  const center = screenToWorld(event.rect.x + event.rect.width / 2, event.rect.y + event.rect.height / 2)
  const { w, h } = measuredSizes.get(nodeId) ?? itemSize(item)
  landingPositions.set(nodeId, { x: center.x - w / 2, y: center.y - h / 2 })
  if (event.phase === 'landing') {
    landingNodeIds.add(nodeId)
    if (hoveredNodeId.value === nodeId) hoveredNodeId.value = null
  }
}

// ── 建立关联：从贴纸边缘的圆点按住拖出一条线，松手落在另一张贴纸上就建立关系 ──────────
// （原来是"点连接按钮进入选目标模式、再点一下目标"的两步点击，现在是一步拖拽，更符合
// 直接操作直觉；起点/终点都用世界坐标画在 RelationLayer 的预览线上，跟真实关系线同一套
// 渲染管线，不用另起一层。）
const connectionDrag = reactive({
  active: false,
  originNodeId: null as number | null,
  originSide: 'left' as 'left' | 'right',
  targetNodeId: null as number | null,
  targetSide: null as ('left' | 'right' | null),
  from: { x: 0, y: 0 },
  to: { x: 0, y: 0 },   // 弹簧跟随后的渲染位置（画出来的线用这个，带一点弹性的"给"）
})
// 预览线不是死板地焊死在指针上——用跟卡片拖拽同一路数的二阶弹簧追指针（见
// usePhysicsDrag.ts 顶部注释同款公式，这里简化成标量各轴独立算），松开圆点或改变方向时
// 能看出线头带一点惯性甩动，像真牵了一根有弹性的线，不是几何上精确却毫无生气的跟手直线。
let connSpringTarget = { x: 0, y: 0 }   // 指针当前的原始世界坐标（弹簧追的目标）
let connSpringVel = { x: 0, y: 0 }
let connSpringRaf = 0
let connSpringLastT: number | null = null
const CONN_SPRING = 900   // 比卡片拖拽的弹簧硬得多——终究是根线，不该像卡片一样肉呼呼地拖沓
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
    connSpringVel.x += ax * h; connSpringVel.y += ay * h
    connectionDrag.to = { x: connectionDrag.to.x + connSpringVel.x * h, y: connectionDrag.to.y + connSpringVel.y * h }
  }
  const origin = props.items.find(current => current.nodeId === connectionDrag.originNodeId)
  if (origin) connectionDrag.from = connectionAnchor(origin, connectionDrag.originSide)
  if (connectionDrag.active) connSpringRaf = requestAnimationFrame(connSpringFrame)
}
function connectionAnchor(item: MindCanvasItem, side: 'left' | 'right') {
  const { w, h } = measuredSizes.get(item.nodeId) ?? itemSize(item)
  return { x: item.x + (side === 'right' ? w : 0), y: item.y + h / 2 }
}
function connectionTargetSide(nodeId: number) {
  return connectionDrag.targetNodeId === nodeId ? connectionDrag.targetSide : null
}
function targetAt(event: PointerEvent, originNodeId: number) {
  const port = runtime.hitNodePort({ x: event.clientX, y: event.clientY }, { objectType: MIND_CANVAS_OBJECT_TYPE })
  const item = port?.objectId.startsWith('mind:')
    ? props.items.find(current => mindCanvasObjectId(current) === port.objectId)
    : undefined
  if (!item) return null
  const nodeId = item.nodeId
  if (nodeId === originNodeId || landingNodeIds.has(nodeId)) return null
  return { item, side: port!.side }
}
function updateConnectionTarget(event: PointerEvent) {
  const originNodeId = connectionDrag.originNodeId
  if (originNodeId == null) return
  const target = targetAt(event, originNodeId)
  connectionDrag.targetNodeId = target?.item.nodeId ?? null
  connectionDrag.targetSide = target?.side ?? null
  // 命中目标卡后，视觉线端弹簧吸到该侧连接点；命中/左右判定仍按原始鼠标位置。
  connSpringTarget = target ? connectionAnchor(target.item, target.side) : screenToWorld(event.clientX, event.clientY)
}
function onConnectDragStart(event: PointerEvent, nodeId: number, side: 'left' | 'right') {
  const origin = props.items.find(current => current.nodeId === nodeId)
  if (!origin) return
  if (!runtime.beginNodeConnection(`mind:${nodeId}`, side)) return
  connectionDrag.active = true
  connectionDrag.originNodeId = nodeId
  connectionDrag.originSide = side
  connectionDrag.targetNodeId = null
  connectionDrag.targetSide = null
  connSpringTarget = screenToWorld(event.clientX, event.clientY)
  connectionDrag.to = { ...connSpringTarget }
  connSpringVel = { x: 0, y: 0 }
  connSpringLastT = null
  // 用户按下哪一个圆点，预览线就固定从那一侧出发；不能因为鼠标划过卡片中线而悄悄换边。
  connectionDrag.from = connectionAnchor(origin, side)
  window.addEventListener('pointermove', onConnectionDragMove)
  window.addEventListener('pointerup', onConnectionDragEnd)
  connSpringRaf = requestAnimationFrame(connSpringFrame)
}
function onConnectionDragMove(event: PointerEvent) {
  runtime.updateNodeConnection(screenToWorld(event.clientX, event.clientY))
  updateConnectionTarget(event)
}
function onConnectionDragEnd(event: PointerEvent) {
  window.removeEventListener('pointermove', onConnectionDragMove)
  window.removeEventListener('pointerup', onConnectionDragEnd)
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
  // 落点判定用真实指针位置（event.clientX/Y），不用还在弹簧里追赶的渲染位置——手感上的
  // "弹性"只体现在线怎么画，砸没砸中目标贴纸得看指针实际在哪，不能让视觉延迟改变判定。
  const source = props.items.find(item => item.nodeId === originNodeId)
  if (!source) return
  if (!runtime.finishNodeConnection(`mind:${target.item.nodeId}`, target.side)) return
  emit('linkNodes', originNodeId, target.item.nodeId, {
    srcSide: connectionDrag.originSide,
    dstSide: target.side,
  })
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
  emit('viewChange', { x: camera.x, y: camera.y, scale: camera.scale })
}
function zoomAtCenterAndEmit(delta: number) {
  zoomAtCenter(delta)
  emitViewChange()
}
function resetScaleAtCenterAndEmit() {
  const center = workspaceCenter()
  // 只把倍率回到 1x：通过可见工作区中心缩放，那里对应的世界坐标不会移动。
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
// 画布现在贴着侧栏/顶部胶囊摆放，不再铺满整个浏览器窗口（见 .mind-canvas 定位注释）——
// "视口正中心"不能再拿 window.innerWidth/innerHeight 算，得读画布自己的实际可见区域。
// CanvasView.vue 新建便签/引用卡片时用这个定初始落点。
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
  stopRuntimeActions = runtime.onAction(action => {
    if (action.type === 'move') onRuntimeMove(action as MoveAction)
  })
  stopRuntimeVisual = runtime.subscribe(onRuntimeVisual)
  updateViewportSize()
  viewportResizeObserver = new ResizeObserver(updateViewportSize)
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
  cancelAnimationFrame(connSpringRaf)
})
</script>

<style scoped>
/* 画布本体（点阵背景 + 世界坐标层）就该铺满整个浏览器，包括侧栏（AppSidebar）背后那一段——
   无限画布不该在侧栏那侧凭空截断一块，只是那段被侧栏（z-index:20，比这里的 0 高）盖住看不
   见而已，两者天然按 z 序叠好，不用真的裁切。真正要"限制范围、别落到侧栏底下"的只是画布自己
   悬浮的 UI 控件——画布切换面板（CanvasSidebar.vue）、底部工具条（CanvasToolbar.vue）这些
   z-index 比侧栏低的浮层，它们各自在自己的定位里加了侧栏宽度的偏移量，不靠这里整体收窄
   画布范围来解决。指针坐标换算见 useMindCanvas.ts 的 screenToWorld（这里始终贴视口原点，
   偏移量为 0，那处理依然安全、只是长期是个 no-op）。 */
.mind-canvas {
  position: fixed; inset: 0; z-index: 0; overflow: hidden; cursor: grab; user-select: none;
  background-color: #e8ebf3;
  /* 点大小用百分比（不是绝对 px）：CSS 渐变的坐标解析在它自己的渲染框（=background-size 这块
     tile）内，绝对 px 半径不随 tile 缩放改变——缩小时点距会跟着 bgStyle 变密，但点本身还是那么
     大，反而显得更粗。改百分比后半径直接是 tile 尺寸的比例，background-size 缩小时点也跟着
     等比变小，缩放观感才一致。 */
  background-image: radial-gradient(circle, rgba(108, 116, 153, .34) 6.5%, transparent 7%);
  /* background-size/position 由 bgStyle 按相机实时写入，让点阵随平移/缩放跟世界一起动 */
}
.mind-canvas:active { cursor: grabbing; }
/* 不加 will-change:transform——它会让 Chrome 把这层提前提升成固定分辨率的合成层，缩放时
   只是拉伸已光栅化的位图（贴纸文字/阴影糊成马赛克），而不是按新 scale 重新光栅化。缩放只在
   离散的点击/滚轮时触发，没有逐帧动画的性能压力，去掉它换来任意缩放级别都是矢量级清晰。 */
.canvas-world { position: absolute; width: 0; height: 0; transform-origin: 0 0; }
</style>
