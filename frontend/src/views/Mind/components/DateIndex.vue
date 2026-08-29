<template>
  <div ref="stripRef" class="date-scrub" @pointerdown="onDown" @pointermove="onHover" @pointerleave="onLeave">
    <div class="ds-track" :style="trackStyle">
      <button
        v-for="tick in visibleTicks" :key="tick.group.date"
        class="dsb-tick" :data-idx="tick.index"
        :style="tickStyle(tick.index)"
      >
        <span class="dsb-bar" :style="barStyle(tick.index)"></span>
        <span class="dsb-tip" :class="{ 'no-transition': dragging || animating }" :style="tipStyle(tick.index)">{{ fmtLabel(tick.group.date) }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { localDayKey } from '@/utils/dateAttribution'
import { useDateScrubberMotion } from '../composables/useDateScrubberMotion'
import { clampScrubberPosition, pitchAt, positionForIndex, tickVisual } from '../utils/dateScrubberMath'

const props = defineProps<{
  groups: { date: string; count: number }[]
  centerFrac: number
}>()
const emit = defineEmits<{
  (e: 'scrub', frac: number): void
  (e: 'snap', date: string): void
}>()

const stripRef = ref<HTMLElement | null>(null)
const stripWidth = ref(0)
const hoverIndex = ref<number | null>(null)
const DRAG_RATIO = 0.45
let removeGestureListeners: (() => void) | null = null

const motion = useDateScrubberMotion({
  getCount: () => props.groups.length,
  onPosition: frac => emit('scrub', frac),
  onSettled: index => {
    const date = props.groups[index]?.date
    if (date) emit('snap', date)
  },
})
const { visualPosition, dragging, animating } = motion

const visibleTicks = computed(() => {
  const center = Math.round(clampScrubberPosition(visualPosition.value, props.groups.length))
  const start = Math.max(0, center - 10)
  const end = Math.min(props.groups.length, center + 11)
  return props.groups.slice(start, end).map((group, offset) => ({ group, index: start + offset }))
})
const trackStyle = computed(() => ({
  transform: `translate3d(${stripWidth.value / 2 - positionForIndex(visualPosition.value, visualPosition.value, props.groups.length)}px,0,0)`,
}))

watch(() => props.centerFrac, position => motion.syncExternal(position), { immediate: true })
watch(() => props.groups, async () => {
  await nextTick()
  motion.syncExternal(props.centerFrac)
}, { immediate: true })

function visual(index: number) {
  return tickVisual(index, visualPosition.value, props.groups.length, hoverIndex.value)
}
function tickStyle(index: number) {
  return { left: `${visual(index).left}px` }
}
function barStyle(index: number) {
  const value = visual(index)
  return {
    height: `${value.barHeight}px`, width: `${value.barWidth}px`,
    opacity: `${value.barOpacity}`,
    // alpha 只交给 opacity 一次；此前 background 和 opacity 都带同一份 alpha，非选中条被平方后过淡。
    background: 'rgb(123,127,178)',
  }
}
function tipStyle(index: number) {
  const value = visual(index)
  return {
    opacity: `${value.tipOpacity}`,
    top: value.tipOffsetY ? `calc(100% + ${value.tipOffsetY}px)` : '',
    color: value.emphasized ? `rgba(90,94,134,${value.emphasisAlpha})` : 'var(--text-secondary)',
    fontWeight: value.emphasized ? '600' : '400',
  }
}

function onResize() { stripWidth.value = stripRef.value?.clientWidth ?? 0 }
function fractionNear(clientX: number): number | null {
  const root = stripRef.value
  if (!root || !visibleTicks.value.length) return null
  const rect = root.getBoundingClientRect()
  const trackX = clientX - rect.left - stripWidth.value / 2 + positionForIndex(visualPosition.value, visualPosition.value, props.groups.length)
  const ticks = visibleTicks.value
  const first = ticks[0].index
  if (trackX <= positionForIndex(first, visualPosition.value, props.groups.length)) return first
  for (let offset = 0; offset < ticks.length - 1; offset++) {
    const from = ticks[offset].index
    const to = ticks[offset + 1].index
    const fromX = positionForIndex(from, visualPosition.value, props.groups.length)
    const toX = positionForIndex(to, visualPosition.value, props.groups.length)
    if (trackX <= toX) return from + (trackX - fromX) / (toX - fromX) * (to - from)
  }
  return ticks[ticks.length - 1].index
}

function onDown(event: PointerEvent) {
  event.preventDefault()
  removeGestureListeners?.()
  removeGestureListeners = null
  const fraction = fractionNear(event.clientX)
  const startPitch = pitchAt(Math.floor(clampScrubberPosition(visualPosition.value, props.groups.length)), visualPosition.value)
  hoverIndex.value = null
  motion.begin(event.clientX, startPitch)
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  const onMove = (moveEvent: PointerEvent) => motion.move(moveEvent.clientX, DRAG_RATIO)
  const onUp = (upEvent: PointerEvent) => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    removeGestureListeners = null
    if (target.hasPointerCapture(upEvent.pointerId)) target.releasePointerCapture(upEvent.pointerId)
    motion.end(fraction === null ? null : Math.round(fraction))
  }
  removeGestureListeners = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
function onHover(event: PointerEvent) {
  if (dragging.value || animating.value || event.pointerType !== 'mouse') return
  const fraction = fractionNear(event.clientX)
  hoverIndex.value = fraction === null ? null : Math.round(clampScrubberPosition(fraction, props.groups.length))
}
function onLeave() { hoverIndex.value = null }

onMounted(() => {
  onResize()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  removeGestureListeners?.()
  window.removeEventListener('resize', onResize)
})

defineExpose({
  settleTo: (index: number) => motion.settleTo(index),
})

const today = localDayKey(new Date())
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
function fmtLabel(iso: string) {
  const days = Math.round((new Date(today + 'T00:00:00').getTime() - new Date(iso + 'T00:00:00').getTime()) / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days === 2) return '前天'
  if (days > 2 && days <= 7) return '周' + WEEKDAY[new Date(iso + 'T00:00:00').getDay()]
  const [year, month, day] = iso.split('-')
  return year === today.slice(0, 4) ? `${+month}月${+day}日` : `${year}年${+month}月${+day}日`
}
</script>

<style scoped>
.date-scrub {
  position: relative; flex-shrink: 0; height: 46px; overflow: hidden; cursor: grab;
  touch-action: pan-y; user-select: none; -webkit-user-select: none;
  mask-image: linear-gradient(to right, transparent, #000 5%, #000 95%, transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, #000 5%, #000 95%, transparent);
}
.date-scrub:active { cursor: grabbing; }
.ds-track { position: absolute; top: 4px; left: 0; width: 0; height: 22px; will-change: transform; }
.dsb-tick { position: absolute; display: flex; align-items: flex-start; justify-content: center; width: 14px; height: 22px; padding: 0; transform: translateX(-50%); border: none; background: none; cursor: inherit; }
.dsb-bar { width: 3px; height: 12px; border-radius: 99px; will-change: height, width, opacity, background; }
.dsb-tip { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: 4px; font-size: 10px; white-space: nowrap; color: var(--text-secondary); pointer-events: none; transition: opacity .15s ease; }
.dsb-tip.no-transition { transition: none; }
</style>
