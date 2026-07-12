<template>
  <div ref="viewportRef" class="mind-canvas" :style="bgStyle" @pointerdown="onViewportPointerDown" @wheel.prevent="onWheelZoom">
    <div class="canvas-world" :style="worldStyle">
      <RelationLayer
        :items="items" :relations="relations" :highlight-node-id="connectionDrag.originNodeId"
        :draft="connectionDrag.active ? { from: connectionDrag.from, to: connectionDrag.to } : null"
        :landing-positions="landingPositions" :measured-sizes="measuredSizes" :relation-anchors="relationAnchors"
        @remove="id => emit('removeRelation', id)"
      />

      <template v-for="item in items" :key="item.id">
        <NoteSticker
          v-if="item.node.kind === 'canvas_note'"
          :item="item" :connecting="connectionDrag.originNodeId === item.nodeId" :screen-to-world="screenToWorld" :scale="camera.scale"
          @remove="item => emit('remove', item)" @dragging="onItemDragging" @landing="onItemLanding" @landing-done="onItemLandingDone"
          @moved="onItemMoved" @save="fields => emit('saveNote', item, fields)"
          @connect-drag-start="(e, side) => onConnectDragStart(e, item.nodeId, side)"
        />
        <ProjectRefCard
          v-else-if="item.node.refType === 'project'"
          :item="item" :connecting="connectionDrag.originNodeId === item.nodeId" :screen-to-world="screenToWorld" :scale="camera.scale"
          @remove="item => emit('remove', item)" @dragging="onItemDragging" @landing="onItemLanding" @landing-done="onItemLandingDone" @measured="onItemMeasured"
          @moved="onItemMoved" @open="item => emit('openRef', item)"
          @connect-drag-start="(e, side) => onConnectDragStart(e, item.nodeId, side)"
        />
        <FileRefCard
          v-else-if="item.node.refType === 'file'"
          :item="item" :connecting="connectionDrag.originNodeId === item.nodeId" :screen-to-world="screenToWorld" :scale="camera.scale"
          @remove="item => emit('remove', item)" @dragging="onItemDragging" @landing="onItemLanding" @landing-done="onItemLandingDone" @measured="onItemMeasured"
          @moved="onItemMoved" @open="item => emit('openRef', item)"
          @connect-drag-start="(e, side) => onConnectDragStart(e, item.nodeId, side)"
        />
        <EntitySticker
          v-else
          :item="item" :connecting="connectionDrag.originNodeId === item.nodeId" :screen-to-world="screenToWorld" :scale="camera.scale"
          @remove="item => emit('remove', item)" @dragging="onItemDragging" @landing="onItemLanding" @landing-done="onItemLandingDone"
          @moved="onItemMoved" @open="item => emit('openRef', item)"
          @connect-drag-start="(e, side) => onConnectDragStart(e, item.nodeId, side)"
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
import type { MindCanvasItem, MindRelation } from '@/services/api'
import { itemSize, pickAnchorSide, useMindCanvas, type RelationAnchorSides } from '@/composables/useMindCanvas'
import EntitySticker from './EntitySticker.vue'
import FileRefCard from './FileRefCard.vue'
import NoteSticker from './NoteSticker.vue'
import ProjectRefCard from './ProjectRefCard.vue'
import RelationLayer from './RelationLayer.vue'

const props = defineProps({
  items: { type: Array as PropType<MindCanvasItem[]>, required: true },
  relations: { type: Array as PropType<MindRelation[]>, required: true },
  relationAnchors: { type: Object as PropType<Record<string, RelationAnchorSides>>, default: () => ({}) },
})
const emit = defineEmits<{
  (e: 'remove', item: MindCanvasItem): void
  (e: 'removeRelation', id: number): void
  (e: 'linkNodes', srcNodeId: number, dstNodeId: number, sides: RelationAnchorSides): void
  (e: 'saveNote', item: MindCanvasItem, fields: { title: string; contentMd: string }): void
  (e: 'openRef', item: MindCanvasItem): void
  (e: 'itemMoved', item: MindCanvasItem): void
  (e: 'viewChange', view: { x: number; y: number; scale: number }): void
}>()

const viewportRef = ref<HTMLElement | null>(null)
const measuredSizes = reactive(new Map<number, { w: number; h: number }>())
const {
  camera, centerView, screenToWorld, zoomAt, zoomAtCenter, onWheel,
  startPan, panMove, panEnd,
  onResize,
} = useMindCanvas(viewportRef)

const worldStyle = computed(() => ({ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})` }))
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
/** 贴纸自己算好了新的世界坐标（卡片中心落在松手时的鼠标位置，见 useCardDrag.ts 的
 *  onDropAt），这里只管落库持久化。 */
function onItemMoved(item: MindCanvasItem, x: number, y: number) {
  item.x = x
  item.y = y
  emit('itemMoved', item)
}
/** 拖拽进行中每帧调用（见 useCardDrag.ts 的 onDragMove）：只改本地状态，不 emit 往上落库——
 *  贴纸本体此刻被 startPhysicsDrag 的克隆接管显示（源贴纸 display:none），这里改 item.x/y
 *  不会造成本体视觉跳变，只会让 RelationLayer 依据同一份响应式数据重绘，连着这张贴纸的
 *  关系线就能跟手实时移动——这才是"实时运动"，不是给线本身加动画。松手时 onItemMoved
 *  才会真正落库，中途每帧都打接口既没必要也会把后端打爆。 */
function onItemDragging(item: MindCanvasItem, x: number, y: number) {
  item.x = x
  item.y = y
}
function onItemMeasured(item: MindCanvasItem, size: { w: number; h: number }) {
  measuredSizes.set(item.nodeId, size)
}

/** 松手后惯性落地动画期间（见 useCardDrag.ts 的 onLanding）每帧调用一次——跟 onItemDragging
 *  的关键区别：这里*不*写 item.x/y。onItemMoved 在落地动画开始前就已经把 item.x/y 同步改成
 *  了最终落点（物理模块紧接着要读它算克隆体飞行目标，不能等），如果这里再往 item.x/y 里写
 *  "还没到终点"的插值，会先让关系线闪一下终点、再跳回起点重新播这段惯性动画——很难看。这里
 *  改用一份独立的 landingPositions 表只覆盖 RelationLayer 的取点，不影响贴纸自己的真实位置
 *  （贴纸这时还隐藏着，item.x/y 提前到位对它没有视觉影响）。 */
const landingPositions = reactive(new Map<number, { x: number; y: number }>())
function onItemLanding(item: MindCanvasItem, x: number, y: number) {
  landingPositions.set(item.nodeId, { x, y })
}
/** 落地插值播完（正好停在 item.x/y 的真实落库值上）——摘掉覆盖，RelationLayer 改读 item.x/y
 *  不会有任何跳变。 */
function onItemLandingDone(item: MindCanvasItem) {
  landingPositions.delete(item.nodeId)
}

// ── 建立关联：从贴纸边缘的圆点按住拖出一条线，松手落在另一张贴纸上就建立关系 ──────────
// （原来是"点连接按钮进入选目标模式、再点一下目标"的两步点击，现在是一步拖拽，更符合
// 直接操作直觉；起点/终点都用世界坐标画在 RelationLayer 的预览线上，跟真实关系线同一套
// 渲染管线，不用另起一层。）
const connectionDrag = reactive({
  active: false,
  originNodeId: null as number | null,
  originSide: 'left' as 'left' | 'right',
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
function onConnectDragStart(event: PointerEvent, nodeId: number, side: 'left' | 'right') {
  const origin = props.items.find(current => current.nodeId === nodeId)
  if (!origin) return
  connectionDrag.active = true
  connectionDrag.originNodeId = nodeId
  connectionDrag.originSide = side
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
  connSpringTarget = screenToWorld(event.clientX, event.clientY)
}
function onConnectionDragEnd(event: PointerEvent) {
  window.removeEventListener('pointermove', onConnectionDragMove)
  window.removeEventListener('pointerup', onConnectionDragEnd)
  cancelAnimationFrame(connSpringRaf)
  const originNodeId = connectionDrag.originNodeId
  connectionDrag.active = false
  connectionDrag.originNodeId = null
  if (originNodeId == null) return
  // 落点判定用真实指针位置（event.clientX/Y），不用还在弹簧里追赶的渲染位置——手感上的
  // "弹性"只体现在线怎么画，砸没砸中目标贴纸得看指针实际在哪，不能让视觉延迟改变判定。
  const targetEl = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node-id]')
  const targetNodeId = targetEl ? Number(targetEl.dataset.nodeId) : NaN
  if (!Number.isFinite(targetNodeId) || targetNodeId === originNodeId) return
  const source = props.items.find(item => item.nodeId === originNodeId)
  const target = props.items.find(item => item.nodeId === targetNodeId)
  if (!source || !target) return
  const sourceSize = measuredSizes.get(source.nodeId) ?? itemSize(source)
  const targetSize = measuredSizes.get(target.nodeId) ?? itemSize(target)
  const sourceCenter = { x: source.x + sourceSize.w / 2, y: source.y + sourceSize.h / 2 }
  const targetCenter = { x: target.x + targetSize.w / 2, y: target.y + targetSize.h / 2 }
  emit('linkNodes', originNodeId, targetNodeId, {
    srcSide: connectionDrag.originSide,
    dstSide: pickAnchorSide(targetCenter, sourceCenter),
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
function centerOn(worldX: number, worldY: number) {
  const viewport = viewportRef.value
  if (!viewport) return
  camera.scale = 1
  camera.x = viewport.clientWidth / 2 - worldX
  camera.y = viewport.clientHeight / 2 - worldY
}
// 画布现在贴着侧栏/顶部胶囊摆放，不再铺满整个浏览器窗口（见 .mind-canvas 定位注释）——
// "视口正中心"不能再拿 window.innerWidth/innerHeight 算，得读画布自己的实际可见区域。
// CanvasView.vue 新建便签/引用卡片时用这个定初始落点。
function viewportCenter() {
  const rect = viewportRef.value?.getBoundingClientRect()
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 }
}

defineExpose({ camera, centerView, centerOn, screenToWorld, zoomAt, zoomAtCenter: zoomAtCenterAndEmit, viewportCenter })

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('resize', onResize)
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
