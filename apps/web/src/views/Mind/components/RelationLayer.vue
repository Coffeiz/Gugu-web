<template>
  <svg class="relation-layer" viewBox="-5000 -5000 10000 10000" aria-hidden="true">
    <g>
      <g
        v-for="rel in visibleRelations"
        :key="rel.id"
        class="rel-group"
        :style="rel.opacity != null ? { opacity: rel.opacity } : undefined"
        @pointerdown.stop
        @click.stop="removeByClick(rel.id)"
      >
        <path class="rel-hit" :d="rel.d" fill="none" />
        <path class="rel-visible" :d="rel.d" fill="none" />
      </g>
    </g>
    <path v-if="draft" class="rel-draft" :d="draftPath" fill="none" />
  </svg>
</template>

<script setup lang="ts">
/**
 * 关系线只负责几何、实时端点和删除交互。新建关系时仅 draft line 强调；已有关系不再因为
 * origin node 进入额外 highlighted 状态，避免 Light/Dark 两套补偿和“像叠了一根线”的错觉。
 */
import { computed, onBeforeUnmount, ref, watch, type PropType } from 'vue'
import type { MindCanvasItem, MindRelation } from '@/services/api'
import { itemSize, pickAnchorSide, pickRelationAnchorSides, type AnchorSide, type RelationAnchorSides } from '@/composables/mind/useMindCanvas'
import { relationCurvePath } from '@/utils/canvasRelationGeometry'

const props = defineProps({
  items: { type: Array as PropType<MindCanvasItem[]>, required: true },
  relations: { type: Array as PropType<MindRelation[]>, required: true },
  draft: {
    type: Object as PropType<{
      from: { x: number; y: number }
      to: { x: number; y: number }
      fromSide: AnchorSide
      toSide: AnchorSide | null
    } | null>,
    default: null,
  },
  landingPositions: { type: Object as PropType<Map<number, { x: number; y: number }>>, default: () => new Map() },
  measuredSizes: { type: Object as PropType<Map<number, { w: number; h: number }>>, default: () => new Map() },
  relationAnchors: { type: Object as PropType<Record<string, RelationAnchorSides>>, default: () => ({}) },
  hoveredNodeId: { type: Number as PropType<number | null>, default: null },
  visualFrame: { type: Number, default: 0 },
  activeVisualNodeId: { type: Number as PropType<number | null>, default: null },
  screenToWorld: { type: Function as PropType<(clientX: number, clientY: number) => { x: number; y: number }>, default: null },
})
const emit = defineEmits<{ (e: 'remove', id: number): void }>()

const itemByNodeId = computed(() => new Map(props.items.map(item => [item.nodeId, item])))
const anchorSideCache = new Map<number, { srcSide: AnchorSide; dstSide: AnchorSide }>()
function geometry(item: MindCanvasItem) {
  return props.measuredSizes.get(item.nodeId) ?? itemSize(item)
}

// 悬浮上浮由 CSS transform 完成；这段 rAF 只在 transform 过渡期间推动真实连接点重新测量。
const renderTick = ref(0)
let hoverRaf = 0
let hoverRafUntil = 0
const hoverSettleIds = ref<Set<number>>(new Set())
function pumpHoverFrames() {
  renderTick.value++
  const now = performance.now()
  if (now >= hoverRafUntil) hoverSettleIds.value = new Set()
  const stillActive = props.hoveredNodeId != null || hoverSettleIds.value.size > 0
  if (stillActive) hoverRaf = requestAnimationFrame(pumpHoverFrames)
  else hoverRaf = 0
}
watch(() => props.hoveredNodeId, (_next, prev) => {
  hoverRafUntil = performance.now() + 300
  hoverSettleIds.value = new Set(prev != null ? [prev] : [])
  if (!hoverRaf) hoverRaf = requestAnimationFrame(pumpHoverFrames)
})
onBeforeUnmount(() => { if (hoverRaf) cancelAnimationFrame(hoverRaf) })

/**
 * 拖拽/落地时优先量 Runtime 代理上的真实连接点，覆盖 rotateZ 后的真实端点；静止卡只在
 * hover/settle 窗口量 DOM，避免画布平移时 DOM measurement 比 camera transform 慢一帧。
 */
function measuredAnchor(item: MindCanvasItem, side: AnchorSide): { x: number; y: number } | null {
  if (side !== 'left' && side !== 'right') return null
  if (!props.screenToWorld) return null

  const visibleDot = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(candidate => {
    if (!candidate.isConnected) return false
    const style = getComputedStyle(candidate)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = candidate.getBoundingClientRect()
    return rect.width >= 1 && rect.height >= 1
  }) ?? null

  let dot = visibleDot(`.phys-conn-dot-manager[data-node-id="${item.nodeId}"] .conn-dot-${side}`)
  if (!dot && (
    item.nodeId === props.activeVisualNodeId
    || item.nodeId === props.hoveredNodeId
    || hoverSettleIds.value.has(item.nodeId)
  )) {
    dot = visibleDot(`.card-conn-dots[data-node-id="${item.nodeId}"] .conn-dot-${side}`)
  }
  if (!dot) return null
  const rect = dot.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  return props.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function anchorFor(item: MindCanvasItem, side: AnchorSide, pos?: { x: number; y: number }) {
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

  const measured = measuredAnchor(item, side)
  if (measured) return measured
  const { w, h } = geometry(item)
  const x = item.x
  const y = item.y
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
    const srcSize = geometry(src)
    const dstSize = geometry(dst)
    sides = pickRelationAnchorSides(
      { ...src, ...srcSize },
      { ...dst, ...dstSize },
    )
    anchorSideCache.set(relation.id, sides)
  }
  return sides
}

// 卡片被移出画布时，关系数据会和卡片同时摘掉；保留旧关系快照 320ms，跟着代理淡出。
const departingRelations = ref<{
  relation: MindRelation
  src: MindCanvasItem
  dst: MindCanvasItem
  since: number
}[]>([])
const immediateDepartures = new Set<number>()
let departingRaf = 0

function pruneAnchorSideCache() {
  const retained = new Set([
    ...props.relations.map(relation => relation.id),
    ...departingRelations.value.map(entry => entry.relation.id),
  ])
  for (const id of anchorSideCache.keys()) {
    if (!retained.has(id)) anchorSideCache.delete(id)
  }
}

const DEPARTING_FADE_MS = 320
function pumpDepartingFrames() {
  renderTick.value++
  const now = performance.now()
  const next = departingRelations.value.filter(({ since }) => now - since < DEPARTING_FADE_MS)
  if (next.length !== departingRelations.value.length) departingRelations.value = next
  pruneAnchorSideCache()
  if (departingRelations.value.length) departingRaf = requestAnimationFrame(pumpDepartingFrames)
  else departingRaf = 0
}
onBeforeUnmount(() => {
  if (departingRaf) cancelAnimationFrame(departingRaf)
})

function removeByClick(id: number) {
  immediateDepartures.add(id)
  emit('remove', id)
}

watch(
  [() => props.relations, () => props.items],
  ([nextRelations], [prevRelations, prevItems]) => {
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
      .filter((value): value is {
        relation: MindRelation
        src: MindCanvasItem
        dst: MindCanvasItem
        since: number
      } => value != null)
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
  void renderTick.value
  void props.visualFrame

  const liveIds = new Set<number>()
  const live = props.relations.flatMap((relation) => {
    if (liveIds.has(relation.id)) return []
    const src = itemByNodeId.value.get(relation.srcNodeId)
    const dst = itemByNodeId.value.get(relation.dstNodeId)
    if (!src || !dst) return []
    liveIds.add(relation.id)
    const sides = resolveSides(relation, src, dst)
    const from = anchorFor(src, sides.srcSide, props.landingPositions.get(src.nodeId))
    const to = anchorFor(dst, sides.dstSide, props.landingPositions.get(dst.nodeId))
    return [{
      id: relation.id,
      d: relationCurvePath(from, sides.srcSide, to, sides.dstSide),
      opacity: undefined as number | undefined,
    }]
  })

  const now = performance.now()
  const departing = departingRelations.value.flatMap(({ relation, src, dst, since }) => {
    if (liveIds.has(relation.id)) return []
    const sides = resolveSides(relation, src, dst)
    const from = anchorFor(src, sides.srcSide, props.landingPositions.get(src.nodeId))
    const to = anchorFor(dst, sides.dstSide, props.landingPositions.get(dst.nodeId))
    const opacity = Math.max(0, 1 - (now - since) / DEPARTING_FADE_MS)
    return [{
      id: relation.id,
      d: relationCurvePath(from, sides.srcSide, to, sides.dstSide),
      opacity,
    }]
  })

  const result = [...live, ...departing]
  return result
})

// draft 与落定关系共用 relationCurvePath；未吸附目标时只临时估算目标侧。
const draftPath = computed(() => {
  if (!props.draft) return ''
  const { from, to, fromSide, toSide } = props.draft
  return relationCurvePath(from, fromSide, to, toSide ?? pickAnchorSide(to, from))
})
</script>

<style scoped>
.relation-layer {
  position: absolute;
  left: -5000px;
  top: -5000px;
  width: 10000px;
  height: 10000px;
  overflow: visible;
  pointer-events: none;
}
.rel-group { pointer-events: auto; cursor: pointer; }
.rel-hit { stroke: transparent; stroke-width: 21.6; }
.rel-visible {
  stroke: var(--mind-relation-line);
  stroke-width: 1.6;
  transition:
    stroke var(--motion-hover-control) var(--motion-ease-standard),
    stroke-width var(--motion-hover-control) var(--motion-ease-standard);
}
.rel-group:hover .rel-visible {
  stroke: var(--mind-relation-line-danger);
  stroke-width: 2.4;
}
.rel-draft {
  stroke: var(--mind-relation-line-draft);
  stroke-width: 2.2;
  stroke-dasharray: 4 5;
}
</style>
