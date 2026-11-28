<template>
  <FileCard
    ref="fileCardRef"
    class="fr-card"
    :class="{ connecting, 'connection-target': !!connectionTargetSide }"
    :style="cardStyle"
    :data-node-id="item.nodeId"
    :ext="pathName.ext"
    :display-name="pathName.base"
    :has-thumb="!!thumbnail"
    :canvas-mode="true"
    @pointerdown.stop="onPointerDown"
    @click.stop="onOpen"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <template v-if="thumbnail" #thumb>
      <img :key="thumbnail" :src="thumbnail" decoding="async" draggable="false" alt="" @error="onThumbnailError" />
    </template>
    <template v-if="!pathReference" #meta>{{ t('mindUi.referenceMissing') }}</template>
    <CardAffordances :hovering="isHovering" :node-id="props.item.nodeId" :connecting="connecting" :target-side="connectionTargetSide" @connect-drag-start="(e, side) => emit('connectDragStart', e, side)">
      <template #actions>
      <button class="del" :title="t('filesUi.removeFromCanvas')" @pointerdown.stop @click.stop="emit('remove', item)"><PhTrash :size="12" weight="bold" /></button>
      </template>
    </CardAffordances>
  </FileCard>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhTrash } from '@phosphor-icons/vue'
import { type MindCanvasItem } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'
import FileCard from '@/components/common/file-browser/FileCard.vue'
import { isImageExt } from '@/utils/fileTypes'
import { decodeMindFileReference, isMindFileReference } from '@/composables/mind/fileReference'
import { splitName } from '@/utils/fileParse'
import { itemSize } from '@/composables/mind/useMindCanvas'
import CardAffordances from '@/components/common/mind/CardAffordances.vue'
import { useMindRuntimeObject } from '@/composables/mind/useMindRuntimeObject'
const { t } = useI18n()
import { mindCanvasObjectId } from '@/interaction/runtime/canvas'

const pathFilesApi = usePathFileAccess()

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem>, required: true },
  connecting: { type: Boolean, default: false },
  connectionTargetSide: { type: String as PropType<'left' | 'right' | null>, default: null },
  screenToWorld: { type: Function as PropType<(clientX: number, clientY: number) => { x: number; y: number }>, required: true },
  scale: { type: Number, default: 1 },
})
const emit = defineEmits<{
  (e: 'remove', item: MindCanvasItem): void
  (e: 'open', item: MindCanvasItem): void
  (e: 'connectDragStart', event: PointerEvent, side: 'left' | 'right'): void
  (e: 'measured', item: MindCanvasItem, size: { w: number; h: number }): void
  (e: 'hover', item: MindCanvasItem, hovering: boolean): void
}>()

const isHovering = ref(false)
function onEnter() {
  isHovering.value = true
  emit('hover', props.item, true)
}
function onLeave() { isHovering.value = false; emit('hover', props.item, false) }

const referenceId = computed(() => props.item.node.refSnapshot?.fileReferenceId)
const pathReference = computed(() => isMindFileReference(referenceId.value))
const pathName = computed(() => {
  const name = props.item.node.title || t('mindUi.unnamedObject')
  const parsed = splitName(name)
  return parsed.base ? parsed : { base: name, ext: '' }
})
const thumbnailUrl = computed(() => {
  const id = referenceId.value
  if (!isMindFileReference(id) || !isImageExt(pathName.value.ext)) return null
  if (id.startsWith('drop-')) return pathFilesApi.systemReferenceUrl?.(id, true) ?? null
  const file = decodeMindFileReference(id)
  return file ? pathFilesApi.thumbnailUrl(file) : null
})
const thumbnailFailed = ref(false)
watch(thumbnailUrl, () => { thumbnailFailed.value = false }, { flush: 'sync' })
const thumbnail = computed(() => thumbnailFailed.value ? null : thumbnailUrl.value)
function onThumbnailError(event: Event) {
  if ((event.currentTarget as HTMLImageElement).getAttribute('src') === thumbnailUrl.value)
    thumbnailFailed.value = true
}
const cardStyle = computed(() => {
  const { w } = itemSize(props.item)
  return { position: 'absolute', left: `${props.item.x}px`, top: `${props.item.y}px`, width: `${w}px`, zIndex: `${props.item.z}` }
})

const fileCardRef = ref<InstanceType<typeof FileCard> | null>(null)
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
watch(fileCardRef, () => nextTick(observeCard), { immediate: true })
watch(() => props.scale, () => nextTick(emitMeasuredSize))
onBeforeUnmount(() => cardResizeObserver?.disconnect())
const { onPointerDown } = useMindRuntimeObject({
  objectId: () => mindCanvasObjectId(props.item),
  element: () => fileCardRef.value?.rootEl ?? null,
})
function onOpen() {
  if (pathReference.value) emit('open', props.item)
}
</script>

<style scoped>
/* position 必须是 absolute（世界坐标 left/top 靠它定位）——写成 relative 会留在文档流里，
   left/top 变成相对正常流位置的偏移量，贴纸本体、连接点跟着一起偏出真实世界坐标，画出来
   的关系线（用的是数据里的 x/y，不受这个 bug 影响）就会跟贴纸实际渲染的位置对不上。 */
.fr-card { position: absolute; box-sizing: border-box; cursor: pointer; user-select: none; touch-action: none; border-radius: 14px; corner-shape: round; }
/* 只锁宽度，不锁高度——FileCard.vue 自己按内容自然定高（.fc-card 的 min-height:122px +
   图标区/文字），撑出来的高度基本贴合 defaultItemSize 给文件类型定的默认值；锁 height:100%
   等于强迫它填满 .fr-wrap 的 min-height，内容矮于这个值时 .fc-label 的 flex:1 会把空白
   拉伸垫在卡片下方（文件卡显得比其它页面同款卡片长的根因）。 */
/* .fc-card 全局有 overflow:hidden。连接点走它的插槽后是它的子节点（跟着拖拽克隆一起飞，见
   上面模板注释），但圆点的判定区摆在卡片边缘外侧（见 CardAffordances.vue 的 .conn-dot-left/
   right），会被这份 overflow:hidden 整个裁掉一半——看着像"文件节点被裁在容器里"。
   .fc-thumb-area 自己另有一份 overflow:hidden 专门裁缩略图，改这里成 visible 不影响缩略图
   圆角。"正在建立关联"的虚线描边走 global.css 共用的 .connecting 规则，不再各卡自己声明。 */
:deep(.fc-card.fr-card) { overflow: visible; }

/* 操作按钮（.card-actions）和连接点（.conn-dot）都由 CardAffordances.vue 提供，
   外观/悬停显形逻辑不再各卡自己抄一份。 */

</style>
