<template>
  <svg class="relation-layer" viewBox="-5000 -5000 10000 10000" aria-hidden="true">
    <g v-for="rel in visibleRelations" :key="rel.id" class="rel-group" @pointerdown.stop @click.stop="emit('remove', rel.id)">
      <!-- 可见曲线（默认弱化）叠一条透明加粗路径专门吃点击——细线本身只有 1.6px，直接点很难点中 -->
      <path class="rel-hit" :d="rel.d" fill="none" />
      <path class="rel-visible" :class="{ highlighted: rel.highlighted }" :d="rel.d" fill="none" />
    </g>
    <!-- 正在从贴纸边缘的连接点拖一条新关系出来时的跟手预览线，不吃点击、不参与已有关系列表 -->
    <path v-if="draft" class="rel-draft" :d="draftPath" fill="none" />
  </svg>
</template>

<script setup lang="ts">
/**
 * 关系连线渲染层：只从贴纸边缘的连接点连到连接点（不穿过卡片中间），走贝塞尔曲线，多条
 * 关系汇到同一张贴纸时才有"树状图"的观感，不是直来直去的折线。默认细而浅（灰紫色），
 * 不遮挡贴纸内容；选中/连接某节点时才高亮与它相关的连线（设计草案「语义关系」）。
 * 点连线可以取消这条关系——建立关联走贴纸边缘的连接点拖拽（见 MindCanvas.vue），
 * 没有别的撤销入口，总得有个地方能删。
 */
import { computed, onBeforeUnmount, reactive, watch, type PropType } from 'vue'
import type { MindCanvasItem, MindRelation } from '@/services/api'
import { itemSize, pickAnchorSide, type AnchorSide, type RelationAnchorSides } from '@/composables/useMindCanvas'

const props = defineProps({
  items: { type: Array as PropType<MindCanvasItem[]>, required: true },
  relations: { type: Array as PropType<MindRelation[]>, required: true },
  highlightNodeId: { type: Number as PropType<number | null>, default: null },
  // fromSide 是按住的那颗连接点本来就知道的（拖出连线前用户点的哪一侧，不会中途换）；
  // toSide 只有指针已经吸附到某张目标卡时才有值（见 MindCanvas.vue 的 connectionDrag.targetSide，
  // 磁吸动效用的同一份判定）——还没吸附到任何卡时为 null，draftPath 会退而求其次估一个。
  draft: {
    type: Object as PropType<{ from: { x: number; y: number }; to: { x: number; y: number }; fromSide: AnchorSide; toSide: AnchorSide | null } | null>,
    default: null,
  },
  // 卡片松手惯性落地动画期间（见 MindCanvas.vue 的 onItemLanding），按 nodeId 覆盖掉下面
  // itemAnchorSide/itemCenter 该读的坐标——item.x/y 这时已经同步跳到最终落点了（物理模块
  // 需要这份真实位置去算克隆体飞行目标，不能等），线不能跟着瞬间跳过去，得靠这份还没到
  // 终点的插值坐标画出"跟着飞"的效果，动画播完这张卡的 key 就会从表里被删掉。
  landingPositions: { type: Object as PropType<Map<number, { x: number; y: number }>>, default: () => new Map() },
  // 项目/文件卡的实际高度可能和持久化视图尺寸不同；嵌套卡体在自身 ResizeObserver 中上报，
  // 连线只用这份临时几何值定位端点，不把渲染细节反写进画布数据。
  measuredSizes: { type: Object as PropType<Map<number, { w: number; h: number }>>, default: () => new Map() },
  // 左右锚点是画布视图状态：卡片之后可以自由换位，已建立的关系也不该悄悄换到另一侧。
  relationAnchors: { type: Object as PropType<Record<string, RelationAnchorSides>>, default: () => ({}) },
  // 当前鼠标悬浮的贴纸 nodeId（见 MindCanvas.vue 的 onItemHover）——四种贴纸悬浮时都会用
  // CSS transform 抬起 2px（.hover-card-fx），这是纯视觉层面的位移，SVG 连线不会自动知道，
  // 得靠这个 prop 手动补偿对应端点，否则抬起来的卡片和还锚在旧位置的连线端点会错位一截。
  hoveredNodeId: { type: Number as PropType<number | null>, default: null },
  // 抬起量是屏幕像素（CSS translateY(-2px)），换算成世界坐标要除以画布当前缩放——.canvas-world
  // 套了 scale(camera.scale)，1 个世界单位在屏幕上就是 camera.scale 个像素。
  scale: { type: Number, default: 1 },
})
const emit = defineEmits<{ (e: 'remove', id: number): void }>()

// 探出去的距离夹在 [40, 140] 之间——下限保证近距离也有够看的弧度、不显得像折线；上限是这次
// 新加的：两张贴纸隔得很远时，探出距离若继续跟总距离等比例涨，弧线会越拉越夸张（一大截几乎
// 平行于端点连线的弯曲），看着不像"稳定的连接线该有的样子"。曲率不该随距离无限跟着变大，
// 封顶后线在任意距离下鼓包的"手感"是统一的，只是端点之间那段直线部分变长了而已。
const MIN_EXTEND = 40
const MAX_EXTEND = 140

/** 端点顺着各自卡片边的法线方向先探出去一段再拐向对方，像流程图连线那样——不是不管两张
 *  贴纸实际怎么摆都硬挤一条水平方向的弧线。之前 curvePath 只会往左右鼓包，遇到两张贴纸
 *  主要是上下错开、左右只差一点点的排布（比如一张压另一张正上方），控制点照样按左右鼓包，
 *  线会绕一大圈才接上（用户反馈的红笔示意图画的就是这种情形该有的走线）。四个方向各自往
 *  外探的距离按两点间总距离算，越远探得越多、弧度越缓，跟原来的手感是一致的——但探出距离
 *  本身封了顶（见 MAX_EXTEND），不会无限跟着总距离涨。 */
function sidePath(from: { x: number; y: number }, fromSide: AnchorSide, to: { x: number; y: number }, toSide: AnchorSide) {
  const dist = Math.min(Math.max(Math.hypot(to.x - from.x, to.y - from.y) * 0.5, MIN_EXTEND), MAX_EXTEND)
  const c1 = extend(from, fromSide, dist)
  const c2 = extend(to, toSide, dist)
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`
}
function extend(pt: { x: number; y: number }, side: AnchorSide, dist: number) {
  if (side === 'left') return { x: pt.x - dist, y: pt.y }
  if (side === 'right') return { x: pt.x + dist, y: pt.y }
  if (side === 'top') return { x: pt.x, y: pt.y - dist }
  return { x: pt.x, y: pt.y + dist }
}

const itemByNodeId = computed(() => new Map(props.items.map(item => [item.nodeId, item])))

// 每条关系的出边侧（左/右/上/下）只在第一次画出来时按当时两张贴纸的相对位置判一次，存进
// 这个表，之后不管卡片挪到哪儿都直接读缓存、不重判——不是响应式状态，纯粹当记忆用（关系 id
// 稳定，删除重连算新 id，自然清缓存）。后端目前没存"从哪一侧的点拖出去"这份意图，退而求
// 其次：用户拖连线那一刻两张贴纸所在的相对位置，就是这条关系出边侧最初、也是唯一应该被
// 采纳的判据。
const anchorSideCache = new Map<number, { srcSide: AnchorSide; dstSide: AnchorSide }>()
function geometry(item: MindCanvasItem) {
  return props.measuredSizes.get(item.nodeId) ?? itemSize(item)
}
// .hover-card-fx 抬起量固定 2px（见 global.css），世界坐标里的偏移量随缩放变化——缩得越小，
// 同样 2 个屏幕像素对应的世界距离越大，除以 scale 才能让连线端点跟卡片实际抬起的像素量对上。
const HOVER_LIFT_PX = 2
// 卡片那 2px 是靠 CSS transition 缓出的（.hover-card-fx，0.25s cubic-bezier）,连线端点如果
// 直接按 hoveredNodeId 是否等于自己两级跳（0 或 -2px），会在卡片还在慢慢抬升的那 0.25s 里
// 瞬间跳到终点——用户反馈"hover 的时候线条没有动画跟随，而是瞬间变成了悬浮位置"。SVG 的
// path d 属性本身没有能跟 CSS transition 对齐的插值机制，这里用一个轻量 rAF 循环把每个
// nodeId 的抬起量自己缓出到目标值（不追求跟卡片那条 cubic-bezier 曲线数学上完全一致，
// 一个 2px 的小幅度位移，观感"平滑跟随"就够了），命中目标或掉出悬浮状态就把它从表里摘掉、
// 循环自动停，不会有画布一直闲置也在空转的 rAF。
const liftAnim = reactive(new Map<number, number>())
let liftRaf = 0
let liftLastT: number | null = null
function liftTargetFor(nodeId: number) {
  return nodeId === props.hoveredNodeId ? -HOVER_LIFT_PX : 0
}
function liftFrame(now: number) {
  const dt = liftLastT === null ? 1 / 60 : Math.min((now - liftLastT) / 1000, 1 / 20)
  liftLastT = now
  const rate = 1 - Math.exp(-dt / 0.06)   // 时间常数跟 .hover-card-fx 的 0.25s 大致对得上
  let active = false
  for (const [nodeId, cur] of [...liftAnim]) {
    const target = liftTargetFor(nodeId)
    if (Math.abs(target - cur) < 0.02) {
      if (target === 0) liftAnim.delete(nodeId)
      else liftAnim.set(nodeId, target)
      continue
    }
    liftAnim.set(nodeId, cur + (target - cur) * rate)
    active = true
  }
  liftRaf = active ? requestAnimationFrame(liftFrame) : 0
  if (!active) liftLastT = null
}
watch(() => props.hoveredNodeId, (id) => {
  if (id != null && !liftAnim.has(id)) liftAnim.set(id, 0)
  if (!liftRaf) liftRaf = requestAnimationFrame(liftFrame)
})
onBeforeUnmount(() => { if (liftRaf) cancelAnimationFrame(liftRaf) })
function hoverLift(item: MindCanvasItem) {
  const px = liftAnim.get(item.nodeId) ?? (item.nodeId === props.hoveredNodeId ? 0 : 0)
  return px / (props.scale || 1)
}
function centerFor(item: MindCanvasItem) {
  const { w, h } = geometry(item)
  return { x: item.x + w / 2, y: item.y + h / 2 + hoverLift(item) }
}
function anchorFor(item: MindCanvasItem, side: AnchorSide, pos?: { x: number; y: number }) {
  const { w, h } = geometry(item)
  const x = pos?.x ?? item.x
  const y = (pos?.y ?? item.y) + hoverLift(item)
  if (side === 'left') return { x, y: y + h / 2 }
  if (side === 'right') return { x: x + w, y: y + h / 2 }
  if (side === 'top') return { x: x + w / 2, y }
  return { x: x + w / 2, y: y + h }
}
function resolveSides(relation: MindRelation, src: MindCanvasItem, dst: MindCanvasItem) {
  let sides = props.relationAnchors[String(relation.id)] ?? anchorSideCache.get(relation.id)
  if (!sides) {
    const srcCenter = centerFor(src), dstCenter = centerFor(dst)
    sides = { srcSide: pickAnchorSide(srcCenter, dstCenter), dstSide: pickAnchorSide(dstCenter, srcCenter) }
    anchorSideCache.set(relation.id, sides)
  }
  return sides
}

const visibleRelations = computed(() => props.relations.flatMap((relation) => {
  const src = itemByNodeId.value.get(relation.srcNodeId)
  const dst = itemByNodeId.value.get(relation.dstNodeId)
  if (!src || !dst) return []
  const sides = resolveSides(relation, src, dst)
  const from = anchorFor(src, sides.srcSide, props.landingPositions.get(src.nodeId))
  const to = anchorFor(dst, sides.dstSide, props.landingPositions.get(dst.nodeId))
  const highlighted = props.highlightNodeId != null
    && (relation.srcNodeId === props.highlightNodeId || relation.dstNodeId === props.highlightNodeId)
  return [{ id: relation.id, d: sidePath(from, sides.srcSide, to, sides.dstSide), highlighted }]
}))

// 拖出连线时的预览线跟建好之后的实线走同一个 sidePath——之前预览线单独用一套"横向鼓包"的
// 贝塞尔（curvePath，已删），跟落定的关系线（sidePath，端点顺着卡片边的法线方向探出再拐弯）
// 长得不一样，松手前后曲线形状会跳一下（用户反馈"虚线的样式和连接后的实线不太一样"）。
// toSide 只有指针吸附到目标卡时才有（见 MindCanvas.vue），还没吸附上任何卡的自由拖拽阶段，
// 借 pickAnchorSide 估一个「如果这里现在有张卡，它朝原点这侧会是哪边」，形状先跟最终效果
// 长得一样，等真吸附上目标后再换成目标实际的边，全程视觉连续、不会在吸附前后跳变。
const draftPath = computed(() => {
  if (!props.draft) return ''
  const { from, to, fromSide, toSide } = props.draft
  return sidePath(from, fromSide, to, toSide ?? pickAnchorSide(to, from))
})
</script>

<style scoped>
.relation-layer { position: absolute; left: -5000px; top: -5000px; width: 10000px; height: 10000px; overflow: visible; pointer-events: none; }
.rel-group { pointer-events: auto; cursor: pointer; }
.rel-hit { stroke: transparent; stroke-width: 14; }
/* 实线，不用装饰性的流动虚线动画——"实时运动"是指拖着贴纸走时线会跟手同步移动
   （见 MindCanvas.vue 的 onItemDragging），不是给静止的线本身加动效。 */
.rel-visible { stroke: rgba(104, 111, 164, .35); stroke-width: 1.6; transition: stroke 0.18s ease, stroke-width 0.18s ease; }
.rel-visible.highlighted { stroke: rgba(123, 127, 178, .9); stroke-width: 2.2; }
.rel-group:hover .rel-visible { stroke: rgba(200, 90, 90, .8); stroke-width: 2.4; }
.rel-draft { stroke: rgba(123, 127, 178, .85); stroke-width: 2.2; stroke-dasharray: 4 5; }
</style>
