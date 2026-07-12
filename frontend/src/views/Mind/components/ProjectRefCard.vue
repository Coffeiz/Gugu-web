<template>
  <ProjectCard
    v-if="project"
    ref="cardRef"
    class="pr-card"
    :class="{ connecting }"
    :style="cardStyle"
    :data-node-id="item.nodeId"
    :project="project"
    :drag-enabled="false"
    :canvas-mode="true"
    @pointerdown.stop="onPointerDown"
  >
    <div class="pr-actions">
      <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
    </div>
    <button class="conn-dot conn-dot-left" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e)"></button>
    <button class="conn-dot conn-dot-right" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e)"></button>
  </ProjectCard>
  <div v-else ref="missingRef" class="pr-missing" :class="{ connecting }" :style="missingStyle" :data-node-id="item.nodeId" @pointerdown.stop="onPointerDown">
    <span class="pr-kind">项目</span>
    <div class="pr-name">{{ item.node.title || '未命名项目' }}</div>
    <span class="pr-deleted">已删除，仅保留快照</span>
    <div class="pr-actions">
      <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
    </div>
    <button class="conn-dot conn-dot-left" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e)"></button>
    <button class="conn-dot conn-dot-right" title="拖出连线建立关联" @pointerdown.stop="e => emit('connectDragStart', e)"></button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { PhTrash } from '@phosphor-icons/vue'
import type { MindCanvasItem } from '@/services/api'
import ProjectCard from '@/views/Projects/components/ProjectCard.vue'
import { useCardDrag } from '@/composables/useCardDrag'
import { itemSize } from '@/composables/useMindCanvas'
import { useProjectStore } from '@/stores/projects'

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem>, required: true },
  connecting: { type: Boolean, default: false },
  screenToWorld: { type: Function as PropType<(clientX: number, clientY: number) => { x: number; y: number }>, required: true },
  scale: { type: Number, default: 1 },
})
const emit = defineEmits<{
  (e: 'remove', item: MindCanvasItem): void
  (e: 'dragging', item: MindCanvasItem, x: number, y: number): void
  (e: 'landing', item: MindCanvasItem, x: number, y: number): void
  (e: 'landingDone', item: MindCanvasItem): void
  (e: 'moved', item: MindCanvasItem, x: number, y: number): void
  (e: 'open', item: MindCanvasItem): void
  (e: 'connectDragStart', event: PointerEvent): void
  (e: 'measured', item: MindCanvasItem, size: { w: number; h: number }): void
}>()

const projectStore = useProjectStore()
const project = computed(() => projectStore.projects.find(p => p.id === props.item.node.refId) || null)
const missingStyle = computed(() => {
  const { w, h } = itemSize(props.item)
  return { left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, minHeight: `${h}px`, zIndex: `${props.item.z}` }
})
const cardStyle = computed(() => {
  const { w } = itemSize(props.item)
  return { position: 'absolute', left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, zIndex: `${props.item.z}` }
})

// 项目卡高度随内容自然变化。关系线不再借持久化的 item.h 猜它多高，而是直接消费这张卡
// 上报的实际世界尺寸，避免视图模型和内层卡体两套高度彼此拉扯。
const cardRef = ref<InstanceType<typeof ProjectCard> | null>(null)
const missingRef = ref<HTMLElement | null>(null)
let cardResizeObserver: ResizeObserver | null = null
function projectCardEl() {
  return cardRef.value?.rootEl ?? null
}
function emitMeasuredSize() {
  const card = projectCardEl()
  if (!card || !card.isConnected) return
  const rect = card.getBoundingClientRect()
  if (rect.width < 10 || rect.height < 10) return
  const scale = props.scale || 1
  emit('measured', props.item, { w: rect.width / scale, h: rect.height / scale })
}
function observeCard() {
  cardResizeObserver?.disconnect()
  const card = projectCardEl()
  if (!card) return
  cardResizeObserver = new ResizeObserver(emitMeasuredSize)
  cardResizeObserver.observe(card)
  emitMeasuredSize()
}
onMounted(() => {
  nextTick(observeCard)
})
watch(project, () => nextTick(observeCard))
watch(() => props.scale, () => nextTick(emitMeasuredSize))
onBeforeUnmount(() => cardResizeObserver?.disconnect())

// 项目和文件贴纸共用同一套物理入口、真实根节点和坐标回调。
const { onPointerDown } = useCardDrag({
  screenToWorld: props.screenToWorld,
  contentScale: () => props.scale,
  getDragEl: () => {
    return projectCardEl() ?? missingRef.value
  },
  exclude: target => !!(target as HTMLElement)?.closest?.('.stars, .proj-stage, .seg-bar-wrap, .card-advance, .pr-actions, .conn-dot'),
  onClick: onOpen,
  onDragMove: (worldX, worldY) => {
    emit('dragging', props.item, worldX, worldY)
  },
  onLanding: (worldX, worldY) => {
    emit('landing', props.item, worldX, worldY)
  },
  onLandingDone: () => emit('landingDone', props.item),
  onDropAt: (worldX, worldY) => {
    emit('moved', props.item, worldX, worldY)
  },
})
function onOpen() {
  emit('open', props.item)
}
</script>

<style scoped>
/* position:absolute（不是 relative）——跟便签/文件/活动贴纸的根节点一致（.note-sticker/
   .entity-sticker/.fr-wrap 都是 absolute），stickerStyle 给的 left/top 是世界坐标系的绝对
   位置。写成 relative 时 left/top 是"从正常文档流位置再偏移"，而 .canvas-world 宽高都是 0，
   块级元素在正常流里会跟其它同样 position:relative 的兄弟节点垂直堆叠——这份「正常流基准
   位置」会随画布上其它项目卡片的数量/高度变化，item.y 的偏移量就是加在一个不固定的基准上，
   越往后建的项目卡片、前面项目卡片越多/越高，累积偏差就越大（"检查其他层级"排查出来的
   真实根因，不是内容高度估算不准这一类问题）。 */
.pr-card, .pr-missing { position: absolute; box-sizing: border-box; user-select: none; }
.pr-card.connecting { outline: 2px dashed rgba(123,127,178,0.6); outline-offset: 2px; }
/* .proj-card 全局有 overflow:hidden（裁掉溢出圆角的杂边）。连接点/移除按钮走它的插槽后
   变成它的子节点才能跟着拖拽克隆一起飞（见上面模板注释），但圆点摆在卡片边缘外侧
   （见下方 .conn-dot 的 left:-6px/right:-6px），会被这份 overflow:hidden 整个裁掉一半——
   看着像"连接点被裁在卡片容器里"。卡片内部会溢出圆角的内容早已各自有自己的
   border-radius/overflow（::before/::after 用 inset:0+border-radius:inherit 自成一体，
   缩略图区也有独立的 overflow:hidden），改成 visible 不会露出裁切前要挡住的东西。
   项目卡保留自然高度，连接线通过上面的 ResizeObserver 同步这份实际高度，不把空白塞进卡片。 */
:deep(.proj-card.pr-card) { overflow: visible; }

.pr-missing {
  position: relative; height: 100%; box-sizing: border-box; padding: 13px 13px 11px;
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-md); corner-shape: squircle;
  box-shadow: 0 2px 8px rgba(80,90,110,0.07);
  display: flex; flex-direction: column; gap: 8px; cursor: grab; touch-action: none;
}
.pr-kind { align-self: flex-start; padding: 1px 6px; border-radius: 4px; background: rgba(123,127,178,.12); color: var(--color-primary); font-size: 10px; font-weight: 700; }
.pr-name { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.pr-deleted { font-size: 10.5px; color: var(--text-secondary); opacity: .7; }

.pr-actions { position: absolute; top: 8px; right: 8px; z-index: 5; display: flex; gap: 3px; opacity: 0; transition: opacity 0.15s; }
.pr-card:hover .pr-actions, .pr-missing:hover .pr-actions { opacity: 1; }
.pr-actions button { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: 0; border-radius: 5px; background: rgba(255,255,255,0.7); color: var(--text-secondary); cursor: pointer; }
.pr-actions button:hover { background: rgba(123,127,178,.16); color: var(--color-primary); }

.conn-dot {
  position: absolute; top: 50%; width: 12px; height: 12px; margin-top: -6px;
  border: 2px solid #fff; border-radius: 50%; padding: 0;
  background: var(--color-primary); box-shadow: 0 1px 4px rgba(80,90,110,.35);
  opacity: 0; transition: opacity 0.15s, transform 0.15s; cursor: crosshair; z-index: 6;
}
.pr-card:hover .conn-dot, .pr-missing:hover .conn-dot { opacity: 1; }
.conn-dot:hover { transform: scale(1.3); }
.conn-dot-left { left: -6px; }
.conn-dot-right { right: -6px; }
</style>
