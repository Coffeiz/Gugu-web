<template>
  <svg class="relation-layer" viewBox="-5000 -5000 10000 10000" aria-hidden="true">
    <!-- 卡片被拖进抽屉/移出画布时，连着它的关系会从 visibleRelations 里瞬间消失（两端
         必须都还在画布上才算有效关系，摘掉一端立刻被过滤掉）——没有 TransitionGroup 的
         v-for 没法接住这次删除的过渡，SVG 没有布局流，也不需要 FLIP 位置捕获那一套，
         补一层最简单的透明度淡出就够了。 -->
    <g>
      <g v-for="rel in visibleRelations" :key="rel.id" class="rel-group" :style="rel.opacity != null ? { opacity: rel.opacity } : undefined" @pointerdown.stop @click.stop="removeByClick(rel.id)">
        <!-- 可见曲线（默认弱化）叠一条透明加粗路径专门吃点击——细线本身只有 1.6px，直接点很难点中 -->
        <path class="rel-hit" :d="rel.d" fill="none" />
        <path class="rel-visible" :class="{ highlighted: rel.highlighted }" :d="rel.d" fill="none" />
      </g>
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
import { computed, onBeforeUnmount, ref, watch, type PropType } from 'vue'
import type { MindCanvasItem, MindRelation } from '@/services/api'
import { itemSize, pickAnchorSide, type AnchorSide, type RelationAnchorSides } from '@/composables/useMindCanvas'
import { beginRuntimeCanvasProbe, markRuntimeCanvasProbe, measureRuntimeCanvasProbe } from '@/utils/runtimePerformanceProbe'

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
  // CSS transform 抬起 2px（.hover-card-fx）。这个变化本身不需要用来算端点位置（measuredAnchor
  // 直接量真实 DOM，抬起多少不用关心），只用来知道"什么时候该在这 0.25s 过渡窗口里持续
  // 重新量一遍"，见下面 pumpHoverFrames。
  hoveredNodeId: { type: Number as PropType<number | null>, default: null },
  // Runtime 每帧更新拖拽代理的视觉位置；这个计数只负责让连接线重新读取真实连接点，
  // 不把代理的轴对齐矩形当成旋转中的卡片几何。
  visualFrame: { type: Number, default: 0 },
  // Runtime 当前拖拽的本体不一定创建独立的连接点管理层；标记它后允许 measuredAnchor
  // 读取本体里的真实 dot，覆盖卡片的实时位移和 rotateZ。
  activeVisualNodeId: { type: Number as PropType<number | null>, default: null },
  // 拖拽/落地飞行期间用来把「强制绑定」量出的真实屏幕坐标换算回世界坐标（见 anchorFor）。
  screenToWorld: { type: Function as PropType<(clientX: number, clientY: number) => { x: number; y: number }>, default: null },
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
// 悬停抬起（.hover-card-fx，2px CSS transition，0.25s）曾经靠一份手写 rAF 缓出（liftAnim/
// liftFrame）去模拟同一条曲线、算出端点该在哪——measuredAnchor 现在直接量真实 DOM 位置，
// 不用再算了。但 Vue 的 computed 只在响应式依赖变化时才重算，抬起这段 CSS 过渡期间
// item.x/y 等数据本身并没有变化，没人告诉 visibleRelations "该重新量一次了"——所以还留一个
// 轻量 rAF 心跳：hoveredNodeId 变化后的一小段时间内，每帧碰一下 renderTick 强制重新计算，
// 让 measuredAnchor 能在这段窗口里逐帧读到 CSS 过渡途中的真实位置；窗口过了心跳自动停，
// 不会有画布一直闲置也在空转的 rAF。
const renderTick = ref(0)
let hoverRaf = 0
let hoverRafUntil = 0
// 悬停结算期内允许真实测量的节点集合：不能只认「当前悬浮的那张」——鼠标移出的瞬间
// hoveredNodeId 立刻变成别的值/null，但刚失焦的卡片自己的 0.25s 收回过渡才刚开始，这段
// 时间里连接线仍需要跟着它的真实 DOM 位置走，不能一移出就直接跳到静止态终点。所以这里
// 只放「刚失焦的那张」（prev）；「当前悬浮的」由 measuredAnchor 里的
// item.nodeId === props.hoveredNodeId 直接判断，不放进这个集合（否则心跳停止时清空会把
// 还在悬浮的卡也清掉）。窗口一过（收回过渡完成）清空，静止卡片不再为了这两张卡常年多付
// 一次 DOM 测量成本（回到"只有真在拖/真在悬浮才测量"的开销模型）。
const hoverSettleIds = ref<Set<number>>(new Set())
function pumpHoverFrames() {
  renderTick.value++
  const now = performance.now()
  // 刚失焦的卡收回过渡窗口（300ms）到期后清空 hoverSettleIds，无论心跳是否还在跑。
  if (now >= hoverRafUntil) hoverSettleIds.value = new Set()
  // 心跳持续条件：只要还有卡在悬浮（抬起是稳态，不是一次性动画，鼠标停留多久就测多久），
  // 或还有刚失焦的卡在收回过渡（hoverSettleIds 非空），心跳就一直跑；两者都空才停。
  // 之前用固定 300ms 截断，鼠标停留超过 300ms 后心跳停了，线会瞬间掉回静止公式、而卡片
  // 本体还抬着 2px，造成对不齐闪烁（devlog 2026-08-06）。
  const stillActive = props.hoveredNodeId != null || hoverSettleIds.value.size > 0
  if (stillActive) {
    hoverRaf = requestAnimationFrame(pumpHoverFrames)
  } else {
    hoverRaf = 0
  }
}
watch(() => props.hoveredNodeId, (next, prev) => {
  // 刚失焦的卡（prev）需要 300ms 收回过渡窗口；当前悬浮的卡（next）由 hoveredNodeId 持续
  // 判断，不放进 hoverSettleIds。
  hoverRafUntil = performance.now() + 300   // 略盖过 0.25s 的过渡时长
  hoverSettleIds.value = new Set(prev != null ? [prev] : [])
  if (!hoverRaf) hoverRaf = requestAnimationFrame(pumpHoverFrames)
})
onBeforeUnmount(() => { if (hoverRaf) cancelAnimationFrame(hoverRaf) })
function centerFor(item: MindCanvasItem) {
  const { w, h } = geometry(item)
  return { x: item.x + w / 2, y: item.y + h / 2 }
}
// 强制绑定：卡片拖拽/落地飞行途中会带一点 rotateZ 摆动，
// 但 onFollow 吐出来的只是不含旋转的纯几何中心，下面按轴对齐算出来的锚点在摆动瞬间会跟连接点
// 实际渲染的位置错开（卡片越大、摆动角度越大，错得越明显）。宁可每帧多测一次量，也不去重建
// 一份旋转矩阵——直接量拖拽系统唯一的连接点管理层（.phys-conn-dot-manager，
// 全程跟着克隆体走同一条物理轨迹，摆动也套在它身上）的真实屏幕位置，命中就是绝对准的。
// 不能拿 landingPositions 的 pos 判断"是否在拖"——那份表只在松手后的惯性插值阶段才有条目，
// 主动拖拽期间全程是 undefined（见 anchorFor 调用处注释），所以这里无条件尝试测量，量不到
// （没有连接点覆盖层，即这张卡当下确实没有物理模块在拖它）才退回按轴对齐估算的旧算法。
function measuredAnchor(item: MindCanvasItem, side: AnchorSide): { x: number; y: number } | null {
  if (side !== 'left' && side !== 'right') return null
  if (!props.screenToWorld) return null
  // 先找拖拽/落地飞行专用的那份连接点覆盖层——这个查询无条件放行：覆盖层只在真的有物理
  // 模块在拖这张卡时才存在，静止的卡查不到，成本可以忽略。
  const visibleDot = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(candidate => {
    if (!candidate.isConnected) return false
    const style = getComputedStyle(candidate)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = candidate.getBoundingClientRect()
    return rect.width >= 1 && rect.height >= 1
  }) ?? null
  let dot = visibleDot(`.phys-conn-dot-manager[data-node-id="${item.nodeId}"] .conn-dot-${side}`)
  // 卡片本体真实渲染的连接点这条回退分支，两种情况才查：①「当前正在悬浮的」——持续条件，
  // 不设时限，鼠标停留多久就测多久，抬起态是 :hover 的稳态而不是一次性动画，只测 300ms
  // 会在悬停时长超过这个窗口后把还在抬着的卡误判成"已经落地"，线跟着瞬间掉回静止公式，
  // 卡片本体却还真的抬着；②「结算窗口内刚失焦的」（见 hoverSettleIds）——鼠标移出瞬间
  // hoveredNodeId 立刻变了，但刚失焦那张卡自己的 0.25s 收回过渡才刚开始，线也不能跟着立刻
  // 跳到终点。两者缺一都会导致某个阶段线跟卡片对不上。
  // 不加限制、对所有静止卡都测的话，画布纯平移时 visibleRelations 会被虚拟化窗口
  // （MindCanvas.vue 的 visibleItems 依赖 camera）拉着每帧重算，测量时机和 .canvas-world
  // 的 transform 提交之间没有强制排序，读到上一帧的屏幕坐标就会让连线看起来"慢半拍"，这是
  // 画布平移时连线肉眼可见滞后的根因（devlog 2026-07-14）。两种情况都不占的静止卡片直接
  // 退到下面按 item.x/y 算的几何兜底——纯世界坐标，平移画布时天然跟手，不需要量真实 DOM。
  if (!dot && (item.nodeId === props.activeVisualNodeId || item.nodeId === props.hoveredNodeId || hoverSettleIds.value.has(item.nodeId))) {
    dot = visibleDot(`.card-conn-dots[data-node-id="${item.nodeId}"] .conn-dot-${side}`)
  }
  if (!dot) return null
  const rect = dot.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  return props.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
}
function anchorFor(item: MindCanvasItem, side: AnchorSide, pos?: { x: number; y: number }) {
  // 落地期间本体会先切到最终位置并保持隐藏，连接点 DOM 也可能已经出现在目标位置；
  // 此时必须优先使用 runtime 每帧提供的代理坐标，否则连接线会提前跳到目标卡片，
  // 而代理仍在飞行。主动拖拽期间没有 pos，仍走真实连接点测量。
  if (pos) {
    const measured = measuredAnchor(item, side)
    if (measured) return measured
    const { w, h } = geometry(item)
    const x = pos.x
    const y = pos.y
    if (side === 'left') return { x, y: y + h / 2 }
    if (side === 'right') return { x: x + w, y: y + h / 2 }
    if (side === 'top') return { x: x + w / 2, y }
    return { x: x + w / 2, y: y + h }
  }
  // 没有落地坐标时，优先测量主动拖拽/悬浮连接点；量不到再按世界坐标兜底。
  const measured = measuredAnchor(item, side)
  if (measured) return measured
  const { w, h } = geometry(item)
  const x = pos?.x ?? item.x
  const y = pos?.y ?? item.y
  if (side === 'left') return { x, y: y + h / 2 }
  if (side === 'right') return { x: x + w, y: y + h / 2 }
  if (side === 'top') return { x: x + w / 2, y }
  return { x: x + w / 2, y: y + h }
}
function resolveSides(relation: MindRelation, src: MindCanvasItem, dst: MindCanvasItem) {
  const explicit = props.relationAnchors[String(relation.id)]
  if (explicit) anchorSideCache.set(relation.id, explicit)
  let sides = explicit ?? anchorSideCache.get(relation.id)
  if (!sides) {
    const srcCenter = centerFor(src), dstCenter = centerFor(dst)
    sides = { srcSide: pickAnchorSide(srcCenter, dstCenter), dstSide: pickAnchorSide(dstCenter, srcCenter) }
    anchorSideCache.set(relation.id, sides)
  }
  return sides
}

// 卡片被吸入抽屉时，store 会在同一刻把这张卡和它牵着的关系一并从 canvasItems/canvasRelations
// 摘掉（见 stores/mind.ts 的 returnCanvasItemToDrawer）——关系一旦从 props.relations 消失，
// visibleRelations 就再也没有机会重新算它的端点位置，只能拿"被摘掉前最后一次算出来的坐标"
// 播 leave 淡出，看着像是"线在原地不跟着卡片飞、径自淡出了"。这张卡这时其实还在物理模块的
// 落地飞行里（clone2 正飞向抽屉），真实位置全程都能测——只是 items/relations 这两份数据已经
// 不认这条关系了。这里在关系/卡片真正从数据里消失前一瞬，抓一份快照单独续养一段时间，
// 沿用同一套 measuredAnchor 逻辑继续跟着飞行克隆量真实位置，直到飞行克隆自己也从 DOM 里
// 消失（真正落地）才让它退出，播真正的淡出——而不是数据一摘就武断掐断。
const departingRelations = ref<{ relation: MindRelation; src: MindCanvasItem; dst: MindCanvasItem; since: number }[]>([])
const immediateDepartures = new Set<number>()
let departingRaf = 0
let relationProbeNodeId: number | null = null
let relationProbeCount = 0
function pruneAnchorSideCache() {
  const retained = new Set([
    ...props.relations.map(relation => relation.id),
    ...departingRelations.value.map(entry => entry.relation.id),
  ])
  for (const id of anchorSideCache.keys()) {
    if (!retained.has(id)) anchorSideCache.delete(id)
  }
}
// 松手（卡片从 items/relations 里被摘掉）那一刻就开始淡出，不用等飞行克隆真正落地——
// 跟随和淡出同时进行，视觉上"松手就往下走"而不是"跟完全程才突然开始淡"。比落地飞行本身
// （0.55~0.7s）快很多，线在飞行途中就已经淡没了，不会跟着飞完全程。时间到直接移出列表，
// 不依赖飞行克隆的 DOM 是否还在——用固定时长而不是查 DOM，好处是不管这次飞行走的是哪条
// 分支（成功落地/超时退化/中途转手），淡出这段体验都一致。
const DEPARTING_FADE_MS = 320
function pumpDepartingFrames() {
  renderTick.value++
  const now = performance.now()
  const next = departingRelations.value.filter(({ since }) => now - since < DEPARTING_FADE_MS)
  if (next.length !== departingRelations.value.length) departingRelations.value = next
  pruneAnchorSideCache()
  if (departingRelations.value.length) {
    departingRaf = requestAnimationFrame(pumpDepartingFrames)
  } else {
    departingRaf = 0
  }
}
onBeforeUnmount(() => {
  if (departingRaf) cancelAnimationFrame(departingRaf)
})

function removeByClick(id: number) {
  // 点击断开是明确的删除动作，不应被下面“卡片移出画布”的淡出监听接管。
  immediateDepartures.add(id)
  emit('remove', id)
}
// 两份数据一起看：items 和 relations 在 returnCanvasItemToDrawer 里同一刻被改，分开各注册一个
// watch 拿到的「上一轮快照」谁先谁后不保真，合并成一个 watch 才能保证 prevItems/prevRelations
// 是同一时刻的一致快照。
watch(
  [() => props.relations, () => props.items],
  ([nextRelations], [prevRelations, prevItems]) => {
    // 画布切换时 store 会先提交空快照，再提交新画布数据。这个中间态不是“关系被删除”，
    // 不能把旧画布的关系加入 departing，否则新 RelationLayer 仍会把旧线淡出一遍造成残留。
    if (nextRelations.length === 0 && props.items.length === 0) {
      departingRelations.value = []
      immediateDepartures.clear()
      anchorSideCache.clear()
      return
    }
    const nextIds = new Set(nextRelations.map(relation => relation.id))
    const removed = prevRelations.filter(relation => !nextIds.has(relation.id))
    const departing = removed.filter((relation) => {
      const immediate = immediateDepartures.delete(relation.id)
      return !immediate
    })
    if (!departing.length) {
      pruneAnchorSideCache()
      return
    }
    const prevItemByNodeId = new Map(prevItems.map(item => [item.nodeId, item]))
    const additions = departing
      .map((relation) => {
        const src = prevItemByNodeId.get(relation.srcNodeId)
        const dst = prevItemByNodeId.get(relation.dstNodeId)
        return src && dst ? { relation, src, dst, since: performance.now() } : null
      })
      .filter((v): v is { relation: MindRelation; src: MindCanvasItem; dst: MindCanvasItem; since: number } => v != null)
    if (!additions.length) {
      pruneAnchorSideCache()
      return
    }
    departingRelations.value = [...departingRelations.value, ...additions]
    pruneAnchorSideCache()
    if (!departingRaf) departingRaf = requestAnimationFrame(pumpDepartingFrames)
  },
)

const visibleRelations = computed(() => {
  void renderTick.value   // 悬停抬起过渡期间的心跳依赖，见 pumpHoverFrames
  void props.visualFrame
  if (props.activeVisualNodeId !== relationProbeNodeId) {
    relationProbeNodeId = props.activeVisualNodeId
    relationProbeCount = 0
  }
  const relationProbe = props.activeVisualNodeId != null && relationProbeCount < 8
    ? beginRuntimeCanvasProbe('relation-recompute')
    : null
  if (relationProbe) relationProbeCount++
  const liveIds = new Set<number>()
  const live = props.relations.flatMap((relation) => {
    // API/乐观关系切换期间可能短暂出现重复记录；关系 id 是渲染身份，不能把重复项交给
    // SVG 渲染树，否则会触发重复节点并让离场动画绑定到不确定的关系。
    if (liveIds.has(relation.id)) return []
    const src = itemByNodeId.value.get(relation.srcNodeId)
    const dst = itemByNodeId.value.get(relation.dstNodeId)
    if (!src || !dst) return []
    liveIds.add(relation.id)
    const sides = resolveSides(relation, src, dst)
    const from = anchorFor(src, sides.srcSide, props.landingPositions.get(src.nodeId))
    const to = anchorFor(dst, sides.dstSide, props.landingPositions.get(dst.nodeId))
    const highlighted = props.highlightNodeId != null
      && (relation.srcNodeId === props.highlightNodeId || relation.dstNodeId === props.highlightNodeId)
    return [{ id: relation.id, d: sidePath(from, sides.srcSide, to, sides.dstSide), highlighted, opacity: undefined as number | undefined }]
  })
  const now = performance.now()
  const departing = departingRelations.value.flatMap(({ relation, src, dst, since }) => {
    // relation 在淡出窗口内恢复为 live 时，live 节点优先，避免同一个 key 同时出现两次。
    if (liveIds.has(relation.id)) return []
    const sides = resolveSides(relation, src, dst)
    const from = anchorFor(src, sides.srcSide, props.landingPositions.get(src.nodeId))
    const to = anchorFor(dst, sides.dstSide, props.landingPositions.get(dst.nodeId))
    // 松手即开始线性淡出，全程跟着 anchorFor 量到的实时位置走，不是先原样展示完飞行
    // 全程、落地那一刻才突然开始淡。
    const opacity = Math.max(0, 1 - (now - since) / DEPARTING_FADE_MS)
    return [{ id: relation.id, d: sidePath(from, sides.srcSide, to, sides.dstSide), highlighted: false, opacity }]
  })
  const result = [...live, ...departing]
  if (relationProbe) {
    markRuntimeCanvasProbe(relationProbe, 'end')
    measureRuntimeCanvasProbe(relationProbe, 'computed', 'start', 'end')
  }
  return result
})

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
/* 判定扩展 10px：可见线 1.6px + 两侧各 10px = 21.6px。 */
.rel-hit { stroke: transparent; stroke-width: 21.6; }
/* 实线，不用装饰性的流动虚线动画——"实时运动"是指拖着贴纸走时线会跟手同步移动
   （见 MindCanvas.vue 的 onItemDragging），不是给静止的线本身加动效。 */
.rel-visible { stroke: rgba(104, 111, 164, .35); stroke-width: 1.6; transition: stroke 0.18s ease, stroke-width 0.18s ease; }
.rel-visible.highlighted { stroke: rgba(123, 127, 178, .9); stroke-width: 2.2; }
.rel-group:hover .rel-visible { stroke: rgba(200, 90, 90, .8); stroke-width: 2.4; }
.rel-draft { stroke: rgba(123, 127, 178, .85); stroke-width: 2.2; stroke-dasharray: 4 5; }
</style>
