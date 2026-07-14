<template>
  <FileCard
    v-if="file"
    ref="fileCardRef"
    class="fr-card"
    :class="{ connecting, 'connection-target': !!connectionTargetSide }"
    :style="cardStyle"
    :data-node-id="item.nodeId"
    :ext="file.ext"
    :display-name="file.displayName"
    :has-thumb="isImageExt(file.ext)"
    :canvas-mode="true"
    @pointerdown.stop="onPointerDown"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <template v-if="isImageExt(file.ext)" #thumb>
      <img :src="thumbTiny ?? undefined" class="fc-thumb-tiny" decoding="async" draggable="false" alt="" />
      <img :src="thumbCard ?? undefined" class="fc-thumb-full" :class="{ 'fc-loaded': cardBlobReadyIds.has(file.id) }"
        decoding="async" draggable="false" alt=""
        @load="cardBlobReadyIds.add(file.id)"
        @error="($event.target as HTMLElement).style.display = 'none'" />
    </template>
    <template #meta>{{ file.projectName || '未分类' }} · {{ file.size }}</template>
    <CardActions :hovering="isHovering">
      <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
    </CardActions>
    <CardConnDot
      :node-id="props.item.nodeId" :hovering="isHovering" :connecting="connecting" :target-side="connectionTargetSide"
      @drag-start="(e, side) => emit('connectDragStart', e, side)"
    />
  </FileCard>
  <!-- filesCache 还没加载完（画布常常是用户没先逛过文件库/Dashboard 就直接进来的入口，
       全局缓存这时是空的）跟"文件真的被删了"是两回事，但两者都会让 file 算出来是
       undefined。之前统一走下面 .fr-missing 那套扁平墓碑布局，摆过一次手算的灰色骨架去
       占位模仿缩略图区的高度，但手算怎么都跟真卡片对不上（试过固定高度、试过 flex:1 吃
       剩余空间，兜来兜去总有几像素差，卡片时高时低）——根源是想拿"照抄的近似值"硬凑"真实
       组件量出来的自然高度"，两者永远不可能精确相等。真正稳妥的做法是干脆直接用同一个
       FileCard 组件渲染这段过渡态：ext 传空、hasThumb 恒为 false（图标区兜底），文件名用
       节点快照——缩略图区和图标区共用同一个 --fc-area-h，加载完 hasThumb 一旦翻成 true，
       只是图标区换成缩略图区的内容，两者本来就同高，总高度天然分毫不差，不需要再猜一个
       数字出来跟它对齐。 -->
  <FileCard
    v-else-if="!filesCache.loaded"
    ref="fileCardRef"
    class="fr-card"
    :class="{ connecting, 'connection-target': !!connectionTargetSide }"
    :style="cardStyle"
    :data-node-id="item.nodeId"
    ext=""
    :display-name="item.node.title || '未命名文件'"
    :has-thumb="false"
    :canvas-mode="true"
    @pointerdown.stop="onPointerDown"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <template #meta>加载中…</template>
    <CardActions :hovering="isHovering">
      <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
    </CardActions>
    <CardConnDot
      :node-id="props.item.nodeId" :hovering="isHovering" :connecting="connecting" :target-side="connectionTargetSide"
      @drag-start="(e, side) => emit('connectDragStart', e, side)"
    />
  </FileCard>
  <!-- 缓存已经加载完、确实找不到这个文件——这才是真的"已删除"，跟上面"还在等缓存"是两种
       性质完全不同的状态，继续走独立的扁平墓碑布局（没有缩略图/图标区，本来也不会再变身
       成真卡片，不需要跟 FileCard 的高度对齐）。 -->
  <div v-else ref="missingRef" class="fr-missing hover-card-fx" :class="{ connecting, 'connection-target': !!connectionTargetSide }" :style="missingStyle" :data-node-id="item.nodeId" @pointerdown.stop="onPointerDown"
    @mouseenter="onEnter" @mouseleave="onLeave">
    <span class="fr-kind">文件</span>
    <div class="fr-name">{{ item.node.title || '未命名文件' }}</div>
    <span class="fr-deleted">已删除，仅保留快照</span>
    <CardActions :hovering="isHovering">
      <button title="从画布移除" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
    </CardActions>
    <CardConnDot
      :node-id="props.item.nodeId" :hovering="isHovering" :connecting="connecting" :target-side="connectionTargetSide"
      @drag-start="(e, side) => emit('connectDragStart', e, side)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { PhTrash } from '@phosphor-icons/vue'
import type { MindCanvasItem } from '@/services/api'
import FileCard from '@/components/common/FileCard.vue'
import { useCardDrag } from '@/composables/useCardDrag'
import { useFilesCacheStore } from '@/stores/filesCache'
import { getThumb, cardBlobReadyIds } from '@/composables/useThumbCache'
import { isImageExt } from '@/utils/fileTypes'
import { itemSize } from '@/composables/useMindCanvas'
import CardActions from './CardActions.vue'
import CardConnDot from './CardConnDot.vue'

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem>, required: true },
  connecting: { type: Boolean, default: false },
  connectionTargetSide: { type: String as PropType<'left' | 'right' | null>, default: null },
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
  (e: 'connectDragStart', event: PointerEvent, side: 'left' | 'right'): void
  (e: 'measured', item: MindCanvasItem, size: { w: number; h: number }): void
  (e: 'hover', item: MindCanvasItem, hovering: boolean): void
}>()

// CardActions/CardConnDot 用 prop 驱动外观（不是 CSS :hover），两个模板分支（有 file/
// 已删除墓碑）共用同一份悬停状态。
const isHovering = ref(false)
function onEnter() { isHovering.value = true; emit('hover', props.item, true) }
function onLeave() { isHovering.value = false; emit('hover', props.item, false) }

const filesCache = useFilesCacheStore()
onMounted(() => { if (!filesCache.loaded) filesCache.load() })
const file = computed(() => filesCache.getFile(props.item.node.refId ?? -1))
const missingStyle = computed(() => {
  const { w, h } = itemSize(props.item)
  // min-height 不是 height：FileCard.vue 按自己内容自然定高（图标区 + 两行文字），撑出来
  // 通常就贴合这份默认值；写死 height 会在内容比默认值矮时，被 .fc-label 的 flex:1
  // 拉伸垫出一截空白（卡片看着变长、底部空一大块，就是这个坑）。
  return { left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, minHeight: `${h}px`, zIndex: `${props.item.z}` }
})
const cardStyle = computed(() => {
  const { w } = itemSize(props.item)
  return { position: 'absolute', left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, zIndex: `${props.item.z}` }
})

// 图片文件的缩略图：跟 Dashboard/FilePanel.vue 同一套 useThumbCache，画布上一张贴纸最多一张
// 图，不需要它那边的懒加载/批量预取，拿到文件直接各请求一次 tiny/card 两级即可。
const thumbTiny = ref<string | null>(null)
const thumbCard = ref<string | null>(null)
watch(file, (f) => {
  thumbTiny.value = null
  thumbCard.value = null
  if (!f || !isImageExt(f.ext)) return
  getThumb(f.id, 'tiny').then(url => { if (url) thumbTiny.value = url })
  getThumb(f.id, 'card').then(url => { if (url) thumbCard.value = url })
}, { immediate: true })

// 拖飞的是 FileCard.vue 自己的根节点（.fc-card），不是这层 .fr-wrap 外壳——否则克隆体的
// 圆角/尺寸是 .fr-wrap 说了算（它自己没有 border-radius、也没有固定高度只有 100% 高度撑
// 一个 auto 高度的父盒子，两层各算各的，撑出来的实际高度会跟 .fc-card 自己的盒模型对不
// 上），拖起来会看到方角边框、卡片被拉长。改成拖 .fc-card 本体后，克隆体的圆角/尺寸/
// 拖拽专属的玻璃模糊样式（global.css 的 .phys-drag-clone.fc-card）才是同一份。
// 确认已删除的墓碑态（.fr-missing）没有 FileCard 可拖，退回 .fr-wrap 本身（它自己的圆角/
// 尺寸就是对的）；缓存还在加载的过渡态也是一张真 FileCard（ext 空、hasThumb 恒 false），
// fileCardRef 同样能拿到，走跟真文件卡完全一样的拖拽路径。
const fileCardRef = ref<InstanceType<typeof FileCard> | null>(null)
const missingRef = ref<HTMLElement | null>(null)
let cardResizeObserver: ResizeObserver | null = null
function emitMeasuredSize() {
  const card = fileCardRef.value?.rootEl
  if (!card || !card.isConnected) return
  const rect = card.getBoundingClientRect()
  if (rect.width < 10 || rect.height < 10) return
  const scale = props.scale || 1
  emit('measured', props.item, { w: rect.width / scale, h: rect.height / scale })
}
function observeCard() {
  cardResizeObserver?.disconnect()
  const card = fileCardRef.value?.rootEl
  if (!card) return
  cardResizeObserver = new ResizeObserver(emitMeasuredSize)
  cardResizeObserver.observe(card)
  emitMeasuredSize()
}
watch(file, () => nextTick(observeCard), { immediate: true })
watch(() => props.scale, () => nextTick(emitMeasuredSize))
onBeforeUnmount(() => cardResizeObserver?.disconnect())
const { onPointerDown } = useCardDrag({
  screenToWorld: props.screenToWorld,
  contentScale: () => props.scale,
  getDragEl: () => fileCardRef.value?.rootEl ?? missingRef.value,
  onClick: () => { if (file.value) emit('open', props.item) },
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
</script>

<style scoped>
/* border-radius 平时不可见（FileCard.vue 自己 100% 铺满、圆角以它为准），只在缺失态没有
   FileCard 可拖、退回克隆 .fr-wrap 本身时兜底——克隆体的方角边框跟里面 14px 圆角的
   .fr-missing 对不上，就是文件卡"圆角没和卡片匹配"的同一类问题，这里先垫一份同值。
   position 必须是 absolute（世界坐标 left/top 靠它定位）——写成 relative 会留在文档流里，
   left/top 变成相对正常流位置的偏移量，贴纸本体、连接点跟着一起偏出真实世界坐标，画出来
   的关系线（用的是数据里的 x/y，不受这个 bug 影响）就会跟贴纸实际渲染的位置对不上。 */
.fr-card, .fr-missing { position: absolute; box-sizing: border-box; cursor: pointer; user-select: none; touch-action: none; border-radius: 14px; }
/* 只锁宽度，不锁高度——FileCard.vue 自己按内容自然定高（.fc-card 的 min-height:122px +
   图标区/文字），撑出来的高度基本贴合 defaultItemSize 给文件类型定的默认值；锁 height:100%
   等于强迫它填满 .fr-wrap 的 min-height，内容矮于这个值时 .fc-label 的 flex:1 会把空白
   拉伸垫在卡片下方（文件卡显得比其它页面同款卡片长的根因）。 */
/* .fc-card 全局有 overflow:hidden。连接点走它的插槽后是它的子节点（跟着拖拽克隆一起飞，见
   上面模板注释），但圆点的判定区摆在卡片边缘外侧（见 CardConnDot.vue 的 .conn-dot-left/
   right），会被这份 overflow:hidden 整个裁掉一半——看着像"文件节点被裁在容器里"。
   .fc-thumb-area 自己另有一份 overflow:hidden 专门裁缩略图，改这里成 visible 不影响缩略图
   圆角。"正在建立关联"的虚线描边走 global.css 共用的 .connecting 规则，不再各卡自己声明。 */
:deep(.fc-card.fr-card) { overflow: visible; }

.fr-missing {
  position: relative; box-sizing: border-box; padding: 13px;
  background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.9); border-radius: 14px;
  display: flex; flex-direction: column; gap: 6px;
}
.fr-kind { align-self: flex-start; padding: 1px 6px; border-radius: 4px; background: rgba(123,127,178,.12); color: var(--color-primary); font-size: 10px; font-weight: 700; }
.fr-name { font-size: 11px; font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
.fr-deleted { font-size: 10.5px; color: var(--text-secondary); opacity: .7; }

/* 操作按钮（.card-actions）和连接点（.conn-dot）都挪进了共用组件 CardActions.vue/
   CardConnDot.vue，外观/悬停显形逻辑不再各卡自己抄一份。 */

/* 缩略图两层（模糊占位 tiny + 淡入 full），跟 Dashboard/FilePanel.vue 同款；基础定位/裁剪
   走 FileCard.vue 的 .fc-thumb-area :deep(img)，这里只管两层各自的差异。 */
.fc-thumb-tiny { filter: blur(10px); }
.fc-thumb-full { opacity: 0; transition: opacity 0.4s ease; }
.fc-thumb-full.fc-loaded { opacity: 1; }
</style>
