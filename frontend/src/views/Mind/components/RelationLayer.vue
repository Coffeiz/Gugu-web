<template>
  <svg class="relation-layer" viewBox="-5000 -5000 10000 10000" aria-hidden="true">
    <g v-for="rel in visibleRelations" :key="rel.id" class="rel-group" @pointerdown.stop @click.stop="emit('remove', rel.id)">
      <!-- 可见曲线（默认弱化）叠一条透明加粗路径专门吃点击——细线本身只有 1.6px，直接点很难点中 -->
      <path class="rel-hit" :d="rel.d" fill="none" />
      <path class="rel-visible" :class="{ highlighted: rel.highlighted }" :d="rel.d" fill="none" />
    </g>
    <!-- 正在从贴纸边缘的连接点拖一条新关系出来时的跟手预览线，不吃点击、不参与已有关系列表 -->
    <path v-if="draft" class="rel-draft" :d="curvePath(draft.from, draft.to)" fill="none" />
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
import { computed, type PropType } from 'vue'
import type { MindCanvasItem, MindRelation } from '@/services/api'
import { itemAnchorAt, itemCenter, pickAnchorSide, type AnchorSide } from '@/composables/useMindCanvas'

const props = defineProps({
  items: { type: Array as PropType<MindCanvasItem[]>, required: true },
  relations: { type: Array as PropType<MindRelation[]>, required: true },
  highlightNodeId: { type: Number as PropType<number | null>, default: null },
  draft: { type: Object as PropType<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>, default: null },
  // 卡片松手惯性落地动画期间（见 MindCanvas.vue 的 onItemLanding），按 nodeId 覆盖掉下面
  // itemAnchorSide/itemCenter 该读的坐标——item.x/y 这时已经同步跳到最终落点了（物理模块
  // 需要这份真实位置去算克隆体飞行目标，不能等），线不能跟着瞬间跳过去，得靠这份还没到
  // 终点的插值坐标画出"跟着飞"的效果，动画播完这张卡的 key 就会从表里被删掉。
  landingPositions: { type: Object as PropType<Map<number, { x: number; y: number }>>, default: () => new Map() },
})
const emit = defineEmits<{ (e: 'remove', id: number): void }>()

/** 三次贝塞尔：控制点水平外扩，横向距离越远弧度越缓，近距离也留够弧度不显得像折线。
 *  给还没定下具体出边方向的场景用（画拖拽中的预览线，起点是已知的左右连接点，终点只是
 *  跟手的指针位置，见 MindCanvas.vue）。 */
function curvePath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = Math.max(Math.abs(to.x - from.x) * 0.5, 50)
  const sign = to.x >= from.x ? 1 : -1
  const c1x = from.x + dx * sign, c2x = to.x - dx * sign
  return `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`
}

/** 端点顺着各自卡片边的法线方向先探出去一段再拐向对方，像流程图连线那样——不是不管两张
 *  贴纸实际怎么摆都硬挤一条水平方向的弧线。之前 curvePath 只会往左右鼓包，遇到两张贴纸
 *  主要是上下错开、左右只差一点点的排布（比如一张压另一张正上方），控制点照样按左右鼓包，
 *  线会绕一大圈才接上（用户反馈的红笔示意图画的就是这种情形该有的走线）。四个方向各自往
 *  外探的距离按两点间总距离算，越远探得越多、弧度越缓，跟原来的手感是一致的。 */
function sidePath(from: { x: number; y: number }, fromSide: AnchorSide, to: { x: number; y: number }, toSide: AnchorSide) {
  const dist = Math.max(Math.hypot(to.x - from.x, to.y - from.y) * 0.5, 40)
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
function resolveSides(relation: MindRelation, src: MindCanvasItem, dst: MindCanvasItem) {
  let sides = anchorSideCache.get(relation.id)
  if (!sides) {
    const srcCenter = itemCenter(src), dstCenter = itemCenter(dst)
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
  const from = itemAnchorAt(src, sides.srcSide, props.landingPositions.get(src.nodeId))
  const to = itemAnchorAt(dst, sides.dstSide, props.landingPositions.get(dst.nodeId))
  const highlighted = props.highlightNodeId != null
    && (relation.srcNodeId === props.highlightNodeId || relation.dstNodeId === props.highlightNodeId)
  return [{ id: relation.id, d: sidePath(from, sides.srcSide, to, sides.dstSide), highlighted }]
}))
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
