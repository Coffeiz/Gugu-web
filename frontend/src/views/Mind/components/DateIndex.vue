<template>
  <!-- 日期刻度滑杆：逻辑日期坐标同时驱动刻度、命中区和内容列，不依赖会变动的 DOM 宽度。 -->
  <div ref="stripRef" class="date-scrub" @pointerdown="onDown" @pointermove="onHover" @pointerleave="onLeave">
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
import { localDayKey } from '@/utils/dateAttribution'

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
const switchingAnim = ref(false)   // 这次弹簧回中是不是真的在切换到不同日期
const hoverActive = ref(false)
const hoverIdx = ref(0)
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
function positionForFrac(p: number, focus = currentFrac.value): number {
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

const selectedIdx = ref<number | null>(null)   // 上一次真正落定选中的日期，用来判断这次回弹是不是"换日期"

watch(() => props.centerFrac, (p) => {
  if (dragging.value || animating.value || lockedIndex.value !== null) return
  currentFrac.value = p
  selectedIdx.value = Math.round(p)
})
watch(() => props.groups, async () => {
  await nextTick()
  if (!dragging.value && !animating.value && lockedIndex.value === null) {
    currentFrac.value = props.centerFrac
    selectedIdx.value = Math.round(props.centerFrac)
  }
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
  const base = Math.exp(-d * d * 1.7)
  if (hoverActive.value && i === hoverIdx.value) return 1
  // 拖到边缘之外的橡皮筋区域时，边界日期的长条/文字保持常显，不随拖动距离继续衰减。
  const last = props.groups.length - 1
  if (currentFrac.value < 0 && i === 0) return 1
  if (currentFrac.value > last && i === last) return 1
  return base
}
/** 悬停到别的日期时，原选中日的长条继续保留，只隐藏它的文字，避免离得近时两个日期文字重叠。 */
function tipHiddenByHover(i: number) {
  return hoverActive.value && i === Math.round(currentFrac.value) && i !== hoverIdx.value
}

/** 在可见刻度里找出离指针 x 最近的一个，用于精确点击命中。 */
function indexNearClientX(clientX: number): number {
  const frac = fracNearClientX(clientX)
  return frac === null ? -1 : Math.round(frac)
}

/** 指针 x 对应的连续逻辑坐标（不取整），用于插值出更精确的最近刻度。 */
function fracNearClientX(clientX: number): number | null {
  if (!stripRef.value) return null
  const rect = stripRef.value.getBoundingClientRect()
  const trackX = clientX - rect.left - stripCenter() + positionForFrac(currentFrac.value)
  const ticks = visibleTicks.value
  if (!ticks.length) return null
  if (trackX <= positionForFrac(ticks[0].index)) return ticks[0].index
  for (let k = 0; k < ticks.length - 1; k++) {
    const a = ticks[k].index
    const b = ticks[k + 1].index
    const xa = positionForFrac(a)
    const xb = positionForFrac(b)
    if (trackX <= xb) return a + (trackX - xa) / (xb - xa) * (b - a)
  }
  return ticks[ticks.length - 1].index
}

function onHover(e: PointerEvent) {
  // 点击后弹簧回中动画还没走完时，先不响应悬停，避免和"选中"的位移/文字动画打架。
  if (dragging.value || animating.value || e.pointerType !== 'mouse') return
  const frac = fracNearClientX(e.clientX)
  if (frac === null) return
  hoverIdx.value = Math.round(clampFrac(frac))
  hoverActive.value = true
}
function onLeave() {
  hoverActive.value = false
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
  // 真的在切换到不同日期时，弹簧回中过程中先不露文字，等落定了再显示；
  // 如果回弹的目标本来就是已选中的日期（比如在边缘橡皮筋松手），文字不该跟着隐藏又淡入。
  const opacity = (animating.value && switchingAnim.value) || tipHiddenByHover(i) ? 0 : Math.max(0, (focus - 0.38) / 0.62)
  return {
    opacity: `${opacity}`,
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
  downIdx = indexNearClientX(e.clientX)
  onLeave()
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
  switchingAnim.value = idx !== selectedIdx.value
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
    switchingAnim.value = false
    lockedIndex.value = idx
    selectedIdx.value = idx
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

const _today = localDayKey(new Date())   // 本地今天（不是 UTC）
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
/** 刻度标签：离今天 0/1/2 天说人话，3~7 天内说星期几，更早退回具体日期——比干巴巴
 *  的日期数字更有时间感（离今天越近的刻度本来就聚焦得越大越显眼，这个改动直接受益）。 */
function fmtLabel(iso: string) {
  const diffDays = Math.round((new Date(_today + 'T00:00:00').getTime() - new Date(iso + 'T00:00:00').getTime()) / 86400000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays === 2) return '前天'
  if (diffDays > 2 && diffDays <= 7) return '周' + WEEKDAY[new Date(iso + 'T00:00:00').getDay()]
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
  transition: opacity 0.15s ease;
}
</style>
