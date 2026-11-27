<template>
  <article
    ref="cardRef"
    class="entity-sticker hover-card-fx"
    :class="{ connecting, 'connection-target': !!connectionTargetSide, tombstone: isTombstone }"
    :style="stickerStyle"
    :data-node-id="item.nodeId"
    @pointerdown.stop="onPointerDown"
    @click.stop="onCardClick"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
  >
    <div class="es-head">
      <component :is="icon" :size="15" weight="bold" />
      <span class="es-kind">{{ label }}</span>
    </div>
    <h3>{{ title }}</h3>
    <template v-if="contactDisplay">
      <ul v-if="contactDetails.length" class="es-contact-details">
        <li v-for="detail in contactDetails" :key="detail.kind">
          <component :is="detail.icon" :size="13" aria-hidden="true" />
          <span :title="detail.value">{{ detail.value }}</span>
        </li>
      </ul>
      <p v-if="contactDisplay.notes?.trim()" class="es-desc es-contact-notes">{{ contactDisplay.notes }}</p>
    </template>
    <span v-if="isTombstone" class="es-deleted">{{ t('mindUi.deletedSnapshot') }}</span>
    <p v-if="eventDisplay?.description" class="es-desc">{{ eventDisplay.description }}</p>
    <span v-if="eventTimeLabel" class="es-time">
      <PhClock :size="11" weight="bold" />{{ eventTimeLabel }}
    </span>
    <CardAffordances
      v-if="!isTombstone"
      :hovering="isHovering"
      :node-id="item.nodeId"
      :connecting="connecting"
      :target-side="connectionTargetSide"
      @connect-drag-start="(e, side) => emit('connectDragStart', e, side)"
    >
      <template #actions>
        <button class="del" :title="t('mindUi.removeFromCanvas')" @pointerdown.stop @click.stop="emit('remove', item)">
          <PhTrash :size="12" weight="bold" />
        </button>
      </template>
    </CardAffordances>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCalendarBlank, PhClock, PhEnvelopeSimple, PhFile, PhMapPin, PhPhone, PhStack, PhTrash, PhUser } from '@phosphor-icons/vue'
import { eventsApi } from '@/api/calendar'
import type { MindCanvasItem } from '@/services/api'
import { useMindRuntimeObject } from '@/composables/mind/useMindRuntimeObject'
import { mindCanvasObjectId } from '@/interaction/runtime/canvas'
import { itemSize } from '@/composables/mind/useMindCanvas'
import CardAffordances from '@/components/common/mind/CardAffordances.vue'

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
  (e: 'hover', item: MindCanvasItem, hovering: boolean): void
  (e: 'measured', item: MindCanvasItem, size: { w: number; h: number }): void
}>()

// 项目/文件已有自己的引用卡，这个组件只承担活动等系统对象贴纸。
const TYPE_ICON = { project: PhStack, file: PhFile, event: PhCalendarBlank, client: PhUser } as const
const { t, locale } = useI18n()
const refType = computed(() => props.item.node.refType || 'event')
const icon = computed(() => TYPE_ICON[refType.value as keyof typeof TYPE_ICON] || PhCalendarBlank)
const label = computed(() => t(`mindEditorUi.referenceTypes.${refType.value}`, t('mindUi.object')))
const contactDisplay = computed(() => {
  const data = props.item.refData
  return refType.value === 'client' && data && 'name' in data ? data : null
})
const contactDetails = computed(() => [
  { kind: 'email', icon: PhEnvelopeSimple, value: contactDisplay.value?.email },
  { kind: 'phone', icon: PhPhone, value: contactDisplay.value?.phone },
  { kind: 'address', icon: PhMapPin, value: contactDisplay.value?.address },
].filter(detail => detail.value?.trim()))
const title = computed(() => contactDisplay.value?.name || props.item.node.title || t('mindUi.unnamedObject'))
const stickerStyle = computed(() => {
  const { w, h } = itemSize(props.item)
  return {
    left: `${props.item.x}px`,
    top: `${props.item.y}px`,
    width: `${w}px`,
    minHeight: `${h}px`,
    zIndex: `${props.item.z}`,
  }
})

// 首屏快照优先，缺快照时才回退活动详情请求；删除后继续用 refSnapshot 展示日期。
const event = ref<Awaited<ReturnType<typeof eventsApi.get>> | null>(null)
const missingEvent = ref(false)
const isTombstone = computed(() => !!props.item.node.deletedAt || missingEvent.value)
const eventRefData = computed(() => {
  const data = props.item.refData
  return refType.value === 'event' && data && !('name' in data) ? data : null
})
const eventDisplay = computed(() => refType.value === 'event'
  ? event.value ?? eventRefData.value ?? props.item.node.refSnapshot ?? null : null)
async function loadEvent() {
  const refId = props.item.node.refId
  missingEvent.value = false
  if (props.item.node.deletedAt || refType.value !== 'event' || refId == null) {
    event.value = null
    return
  }
  if (eventRefData.value?.date) {
    event.value = null
    return
  }
  try {
    event.value = await eventsApi.get(refId)
  } catch (error) {
    event.value = null
    missingEvent.value = (error as { status?: number }).status === 404
  }
}
onMounted(loadEvent)
watch(() => props.item.node.refId, loadEvent)

const eventTimeLabel = computed(() => {
  const value = eventDisplay.value
  if (!value?.date) return ''
  const date = new Date(`${value.date}T00:00:00`)
  const dateLabel = new Intl.DateTimeFormat(locale.value, { month: 'numeric', day: 'numeric' }).format(date)
  if (!value.time) return `${dateLabel} ${t('mindUi.allDay')}`
  return `${dateLabel} ${value.time}${value.endTime ? `–${value.endTime}` : ''}`
})

const isHovering = ref(false)
function onEnter() {
  isHovering.value = true
  emit('hover', props.item, true)
}
function onLeave() {
  isHovering.value = false
  emit('hover', props.item, false)
}

const cardRef = ref<HTMLElement | null>(null)
let cardResizeObserver: ResizeObserver | null = null
function emitMeasuredSize() {
  const card = cardRef.value
  if (!card || !card.isConnected) return
  const rect = card.getBoundingClientRect()
  if (rect.width < 10 || rect.height < 10) return
  const scale = props.scale || 1
  emit('measured', props.item, { w: rect.width / scale, h: rect.height / scale })
}
function observeCard() {
  cardResizeObserver?.disconnect()
  const card = cardRef.value
  if (!card) return
  cardResizeObserver = new ResizeObserver(emitMeasuredSize)
  cardResizeObserver.observe(card)
  emitMeasuredSize()
}
onMounted(() => nextTick(observeCard))
watch(() => props.scale, () => nextTick(emitMeasuredSize))
onBeforeUnmount(() => cardResizeObserver?.disconnect())

const { onPointerDown } = useMindRuntimeObject({
  objectId: () => mindCanvasObjectId(props.item),
  element: () => cardRef.value,
})
function onCardClick() {
  if (!isTombstone.value) emit('open', props.item)
}
</script>

<style scoped>
.entity-sticker {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  cursor: pointer;
  user-select: none;
  touch-action: none;
  border: 1px solid var(--border-strong);
  border-radius: var(--mind-canvas-card-radius);
  corner-shape: round;
  background: var(--surface-card-solid);
  box-shadow: var(--card-shadow);
}
.entity-sticker:hover {
  background: var(--file-card-bg-hover);
  border-color: var(--file-card-border-hover);
}

.es-head { display: flex; align-items: center; gap: 6px; color: var(--color-primary); }
.es-kind { font-size: 10px; font-weight: 700; }
h3 {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.35;
  font-weight: 700;
  overflow-wrap: anywhere;
  color: var(--text-primary);
}
.es-deleted { font-size: 10.5px; color: var(--text-secondary); opacity: .7; }
.es-desc {
  margin: -3px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
}
.es-contact-details { display: grid; gap: var(--space-xs); padding: 0; margin: 0; list-style: none; }
.es-contact-details li { display: flex; align-items: center; min-width: 0; gap: var(--space-xs); color: var(--content-secondary); font-size: var(--font-size-sm); }
.es-contact-details svg { flex: none; }
.es-contact-details span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.es-contact-notes { margin-top: var(--space-xs); -webkit-line-clamp: 2; }
.es-time {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--text-secondary);
  opacity: .85;
}
</style>
