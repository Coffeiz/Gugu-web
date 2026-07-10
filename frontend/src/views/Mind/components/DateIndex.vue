<template>
  <!-- 日期刻度滑杆：逻辑日期坐标同时驱动刻度、命中区和内容列，不依赖会变动的 DOM 宽度。 -->
  <div ref="stripRef" class="date-scrub" @pointerdown="onDown">
    <div class="ds-track" :style="trackStyle()">
      <button
        v-for="tick in visibleTicks" :key="tick.group.date"
        class="dsb-tick"
        :data-idx="tick.index"
        :style="tickSlotStyle(tick.index)"
      >
        <span class="dsb-bar" :style="tickBarStyle(tick.index)"></span>
        <span class="dsb-tip" :style="tickTipStyle(tick.index)">{{ fmtLabel(tick.group.date) }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

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
const currentFrac = ref(0)
const dragging = ref(false)
const animating = ref(false)
const lockedIndex = ref<number | null>(null)
let lockTimer: ReturnType<typeof setTimeout> | null = null

// 日期条只保留选中日期前后各 10 个刻度；定位仍基于完整日期序列，窗口切换不改变拖动比例。
const visibleTicks = computed(() => {
  const center = Math.round(clampFrac(currentFrac.value))
  const start = Math.max(0, center - 10)
  const end = Math.min(props.groups.length, center + 11)
  return props.groups.slice(start, end).map((group, offset) => ({ group, index: start + offset }))
})

// 每段日期间距由逻辑坐标计算，中心较疏、两侧较密；不再改变按钮的实际布局宽度。
const BASE_PITCH = 9
const CENTER_EXTRA = 8
const DRAG_RATIO = 0.45

function stripCenter() { return stripWidth.value / 2 }
function clampFrac(p: number) { return Math.max(0, Math.min(props.groups.length - 1, p)) }
function pitchAt(interval: number, focus: number) {
  const distance = Math.abs(interval + 0.5 - focus)
  // 只在中心两段改变间距；用连续曲线过渡，拖动时不会在跨日期边界时跳变。
  const smoothstep = (t: number) => t * t * (3 - 2 * t)
  let extra = 0
  if (distance <= 0.5) extra = CENTER_EXTRA
  else if (distance < 1.5) extra = CENTER_EXTRA * (1 - 0.5 * smoothstep(distance - 0.5))
  else if (distance < 2.5) extra = CENTER_EXTRA * 0.5 * (1 - smoothstep(distance - 1.5))
  return BASE_PITCH + extra
}

/** 第 p 个日期在刻度轨道中的逻辑 x；允许边界外的小幅橡皮筋。 */
function positionForFrac(p: number, focus = currentFrac.value) {
  const n = props.groups.length
  if (!n) return 0
  if (p < 0) return p * pitchAt(0, focus)
  if (p > n - 1) return positionForFrac(n - 1, focus) + (p - (n - 1)) * pitchAt(n - 2, focus)
  const lo = Math.floor(p)
  let x = 0
  for (let i = 0; i < lo; i++) x += pitchAt(i, focus)
  return x + (p - lo) * pitchAt(lo, focus)
}

function trackStyle() {
  return { transform: `translate3d(${stripCenter() - positionForFrac(currentFrac.value)}px,0,0)` }
}
function tickSlotStyle(i: number) {
  const distance = Math.abs(i - currentFrac.value)
  // 窗口边缘（第 9、10 个日期）逐步淡出，避免 21 个刻度像被硬切掉。
  const t = Math.max(0, Math.min(1, (distance - 8) / 2))
  const opacity = 1 - t * t * (3 - 2 * t)
  return { left: `${positionForFrac(i)}px`, opacity: `${opacity}` }
}

function rubberBand(raw: number) {
  const last = props.groups.length - 1
  if (raw >= 0 && raw <= last) return raw
  const distance = raw < 0 ? -raw : raw - last
  const resisted = (1 - 1 / (distance + 1)) * 0.7
  return raw < 0 ? -resisted : last + resisted
}
/** 日期中心是凹槽：在日期附近更慢，在两日期之间更快。 */
function detentFrac(raw: number) {
  const banded = rubberBand(raw)
  const last = props.groups.length - 1
  if (banded < 0 || banded > last) return banded
  const lo = Math.floor(banded)
  if (lo >= last) return banded
  const t = banded - lo
  // 比普通 ease-in-out 更贴近两端，靠近日期中心时有更清晰的吸附阻尼。
  const snapped = t * t * t * (t * (t * 6 - 15) + 10)
  return lo + snapped
}

watch(() => props.centerFrac, (p) => {
  if (dragging.value || animating.value || lockedIndex.value !== null) return
  currentFrac.value = p
})
watch(() => props.groups, async () => {
  await nextTick()
  if (!dragging.value && !animating.value && lockedIndex.value === null) currentFrac.value = props.centerFrac
}, { immediate: true })
function onResize() {
  stripWidth.value = stripRef.value?.clientWidth ?? 0
  if (!dragging.value && !animating.value && lockedIndex.value === null) currentFrac.value = props.centerFrac
}
onMounted(() => {
  onResize()
  window.addEventListener('resize', onResize)
})

function tickFocus(i: number) {
  const d = Math.abs(i - currentFrac.value)
  return Math.exp(-d * d * 1.7)
}
function tickBarStyle(i: number) {
  const focus = tickFocus(i)
  return {
    height: `${10 + focus * 12}px`,
    width: `${3 + focus * 1.5}px`,
    background: `rgba(123,127,178,${0.25 + focus * 0.75})`,
  }
}
function tickTipStyle(i: number) {
  const focus = tickFocus(i)
  return {
    opacity: `${Math.max(0, (focus - 0.38) / 0.62)}`,
    color: focus > 0.82 ? '#5a5e86' : 'var(--text-secondary)',
    fontWeight: focus > 0.82 ? '600' : '400',
  }
}

let startX = 0
let startFrac = 0
let moved = false
let downIdx = -1
let rafId = 0
let animationRun = 0
let velocityFrac = 0   // 指数滑动平均，单位 frac/ms，驱动松手惯性
let lastMoveTime = 0

function stopAnim() {
  animationRun += 1
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  animating.value = false
}

function onDown(e: PointerEvent) {
  e.preventDefault()
  stopAnim()
  lockedIndex.value = null
  if (lockTimer) clearTimeout(lockTimer)
  lockTimer = null
  startX = e.clientX
  startFrac = currentFrac.value
  moved = false
  velocityFrac = 0
  lastMoveTime = 0
  const el = (e.target as HTMLElement).closest<HTMLElement>('.dsb-tick')
  downIdx = el ? Number(el.dataset.idx) : -1
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function onMove(e: PointerEvent) {
  const dx = e.clientX - startX
  if (Math.abs(dx) > 3) moved = true
  const pitch = pitchAt(Math.floor(clampFrac(startFrac)), startFrac)
  const next = detentFrac(startFrac - (dx * DRAG_RATIO) / pitch)
  const now = performance.now()
  const dt = lastMoveTime ? now - lastMoveTime : 16
  const instant = (next - currentFrac.value) / Math.max(dt, 4)
  velocityFrac = velocityFrac * 0.6 + instant * 0.4   // 指数平滑，松手瞬间的抖动不会整个吃进去
  lastMoveTime = now
  currentFrac.value = next
  emit('scrub', clampFrac(currentFrac.value))
}

function onUp() {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  dragging.value = false
  const last = props.groups.length - 1
  let idx: number
  if (!moved && downIdx >= 0) {
    idx = Math.max(0, Math.min(last, downIdx))
  } else {
    // 惯性：按松手瞬间的速度多滑一点再吸附到最近刻度，快甩多走一点、慢放基本不动；
    // 封顶避免用力过猛直接跳好几天——"稍微多移动一点"而不是真的做一整套抛物线减速。
    const extra = Math.max(-1.1, Math.min(1.1, velocityFrac * 45))
    idx = Math.round(clampFrac(currentFrac.value + extra))
  }
  animateTo(idx)
}

function animateTo(idx: number) {
  const run = ++animationRun
  const date = props.groups[idx]?.date
  let pos = currentFrac.value
  let velocity = 0
  let last = performance.now()
  animating.value = true
  const frame = (now: number) => {
    if (run !== animationRun) return
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000))
    last = now
    const spring = 260
    const damping = 32
    velocity += (spring * (idx - pos) - damping * velocity) * dt
    pos += velocity * dt
    currentFrac.value = pos
    emit('scrub', clampFrac(pos))
    if (Math.abs(idx - pos) > 0.002 || Math.abs(velocity) > 0.02) {
      rafId = requestAnimationFrame(frame)
      return
    }
    currentFrac.value = idx
    rafId = 0
    animating.value = false
    lockedIndex.value = idx
    emit('scrub', idx)
    if (lockTimer) clearTimeout(lockTimer)
    lockTimer = setTimeout(() => { lockedIndex.value = null; lockTimer = null }, 520)
    if (date) emit('snap', date)
  }
  rafId = requestAnimationFrame(frame)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('resize', onResize)
  if (lockTimer) clearTimeout(lockTimer)
  stopAnim()
})

const _today = new Date().toISOString().slice(0, 10)
function fmtLabel(iso: string) {
  const [y, m, d] = iso.split('-')
  return y === _today.slice(0, 4) ? `${+m}月${+d}日` : `${y}年${+m}月${+d}日`
}
</script>

<style scoped>
.date-scrub {
  position: relative;
  flex-shrink: 0; height: 46px;
  overflow: hidden;
  cursor: grab;
  touch-action: pan-y;
  user-select: none; -webkit-user-select: none;
  mask-image: linear-gradient(to right, transparent, #000 5%, #000 95%, transparent);
  -webkit-mask-image: linear-gradient(to right, transparent, #000 5%, #000 95%, transparent);
}
.date-scrub:active { cursor: grabbing; }

.ds-track {
  position: absolute; top: 4px; left: 0;
  width: 0; height: 22px;
  will-change: transform;
}
.dsb-tick {
  position: absolute;
  display: flex; align-items: flex-start; justify-content: center;
  width: 14px; height: 22px; padding: 0;
  transform: translateX(-50%);
  border: none; background: none; cursor: inherit;
}
.dsb-bar {
  width: 3px; height: 12px; border-radius: 99px;
  background: rgba(123,127,178,0.3);
  will-change: height, width, background;
}
.dsb-tip {
  position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  margin-top: 4px; font-size: 10px; white-space: nowrap;
  color: var(--text-secondary); opacity: 0; pointer-events: none;
}
</style>
