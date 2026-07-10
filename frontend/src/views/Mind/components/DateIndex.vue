<template>
  <!-- 日期刻度滑杆：playhead 固定正中，刻度带整体平移让当前日的高刻度停中线。
       拖动 1:1 跟手、列随之**连续平滑**滑动（不是一格一格跳）；到两端有弹力阻尼、松手回弹吸附；
       点某根刻度平滑吸过去。刻度 grow/shrink（选中↔脱离）带过渡动画。 -->
  <div ref="stripRef" class="date-scrub" @pointerdown="onDown">
    <div ref="trackRef" class="ds-track" :class="{ snapping }"
         :style="{ transform: `translate3d(${offset}px,0,0)` }">
      <button
        v-for="(g, i) in groups" :key="g.date"
        class="dsb-tick" :class="{ on: g.date === active }"
        :data-date="g.date" :data-idx="i"
      >
        <span class="dsb-bar"></span>
        <span class="dsb-tip">{{ fmtLabel(g.date) }}</span>
      </button>
    </div>
    <div class="ds-playhead" aria-hidden="true"></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  groups: { date: string; count: number }[]
  active: string       // 四舍五入后的当前日（刻度 .on / 高亮用）
  centerFrac: number   // 连续分数位置（列滚动驱动时用它把刻度带连续拉过来）
}>()
const emit = defineEmits<{
  (e: 'seek', frac: number): void        // 拖动中：连续联动列
  (e: 'snap', date: string): void        // 松手/点击：平滑吸附到某天
}>()

const stripRef = ref<HTMLElement | null>(null)
const trackRef = ref<HTMLElement | null>(null)
const offset   = ref(0)
const dragging = ref(false)
const snapping = ref(false)   // 松手回弹期间才给 track 上过渡（spring）

// ── 几何（读实测，不硬编码刻度间距）───────────────────────────────────────────
function stripCenter() { return (stripRef.value?.clientWidth ?? 0) / 2 }
function tickCenter(i: number): number {
  const t = trackRef.value?.children[i] as HTMLElement | undefined
  return t ? t.offsetLeft + t.offsetWidth / 2 : 0
}
/** 让第 i 根刻度停中线的 offset（offset 随 i 增大而减小） */
function offsetForIndex(i: number) { return stripCenter() - tickCenter(i) }
/** 连续分数位置 p 对应的 offset（相邻刻度线性插值） */
function offsetForFrac(p: number): number {
  const n = props.groups.length
  if (n === 0) return 0
  const f = Math.max(0, Math.min(n - 1, p))
  const lo = Math.floor(f), hi = Math.min(lo + 1, n - 1)
  return offsetForIndex(lo) + (offsetForIndex(hi) - offsetForIndex(lo)) * (f - lo)
}
/** 当前 offset 落在哪个连续分数位置 */
function fracFromOffset(off: number): number {
  const n = props.groups.length
  if (n === 0) return 0
  const centerInTrack = stripCenter() - off
  const c0 = tickCenter(0), cN = tickCenter(n - 1)
  if (centerInTrack <= c0) return 0
  if (centerInTrack >= cN) return n - 1
  for (let i = 0; i < n - 1; i++) {
    const a = tickCenter(i), b = tickCenter(i + 1)
    if (centerInTrack >= a && centerInTrack <= b) return i + (centerInTrack - a) / (b - a)
  }
  return 0
}
/** 两端弹力：超出「最新/最旧刻度居中」的范围后，位移打三折（橡皮筋阻尼） */
function rubberBand(raw: number): number {
  const n = props.groups.length
  if (n === 0) return raw
  const max = offsetForIndex(0)      // 最新（最左）刻度居中 → offset 最大
  const min = offsetForIndex(n - 1)  // 最旧（最右）刻度居中 → offset 最小
  if (raw > max) return max + (raw - max) * 0.32
  if (raw < min) return min + (raw - min) * 0.32
  return raw
}

// ── 列滚动驱动（wheel）：连续分数 → 刻度带连续跟随（拖动/回弹中不抢）──────────
watch(() => props.centerFrac, (p) => {
  if (dragging.value || snapping.value) return
  offset.value = offsetForFrac(p)
})
// 数据/尺寸就绪后先摆正一次（瞬时）
watch(() => props.groups, async () => {
  await nextTick()
  if (!dragging.value && !snapping.value) offset.value = offsetForFrac(props.centerFrac)
}, { immediate: true })
function onResize() { if (!dragging.value && !snapping.value) offset.value = offsetForFrac(props.centerFrac) }
onMounted(() => window.addEventListener('resize', onResize))

// ── 拖动：跟手 + 弹力，实时连续联动列；松手 spring 吸附最近刻度 ─────────────────
let startX = 0, startOffset = 0, moved = false, downIdx = -1
let snapTimer: ReturnType<typeof setTimeout> | null = null

function onDown(e: PointerEvent) {
  startX = e.clientX
  startOffset = offset.value
  moved = false
  const el = (e.target as HTMLElement).closest<HTMLElement>('.dsb-tick')
  downIdx = el ? Number(el.dataset.idx) : -1
  snapping.value = false
  if (snapTimer) { clearTimeout(snapTimer); snapTimer = null }
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function onMove(e: PointerEvent) {
  const dx = e.clientX - startX
  if (Math.abs(dx) > 3) moved = true
  offset.value = rubberBand(startOffset + dx)   // 跟手 + 两端阻尼
  emit('seek', fracFromOffset(offset.value))    // 连续联动列（列平滑跟随手指）
}

function onUp() {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  dragging.value = false
  // 点击（没拖）→ 吸点的那根；拖动 → 吸离中线最近（round）；都夹在 [0, n-1]
  const n = props.groups.length
  const raw = (!moved && downIdx >= 0) ? downIdx : Math.round(fracFromOffset(offset.value))
  const idx = Math.max(0, Math.min(n - 1, raw))
  snapTo(idx)
}

function snapTo(idx: number) {
  snapping.value = true                    // 开 track 过渡 → spring 回弹
  offset.value = offsetForIndex(idx)
  const date = props.groups[idx]?.date
  if (date) emit('snap', date)             // 列平滑滚到该天居中
  if (snapTimer) clearTimeout(snapTimer)
  snapTimer = setTimeout(() => { snapping.value = false }, 440)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('resize', onResize)
  if (snapTimer) clearTimeout(snapTimer)
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
  flex-shrink: 0; height: 46px;   /* 容下刻度(26) + 底部日期小签(~42)，overflow:hidden 才不裁掉签 */
  overflow: hidden;
  cursor: grab;
  touch-action: pan-y;   /* 竖向手势留给页面，横向自己接管 */
}
.date-scrub:active { cursor: grabbing; }

.ds-track {
  position: absolute; top: 4px; left: 0;
  display: flex; align-items: flex-end; gap: 3px;
  will-change: transform;
  /* 平时无过渡（拖动跟手、列联动、resize 都瞬时连续）；只有松手回弹(.snapping)给一段 spring */
}
.ds-track.snapping {
  transition: transform 0.44s cubic-bezier(0.34, 1.28, 0.5, 1);
}

/* 每根刻度 10px 透明命中区，视觉只露中间 3px 的杆 */
.dsb-tick {
  position: relative; flex-shrink: 0;
  display: flex; align-items: flex-end; justify-content: center;
  width: 10px; height: 22px; padding: 0;
  border: none; background: none; cursor: inherit;
}
/* grow/shrink（选中↔脱离）带过渡：高度/宽度/色都缓动，切日期时刻度平滑长高/回落 */
.dsb-bar {
  width: 3px; height: 12px; border-radius: 99px;
  background: rgba(123,127,178,0.3);
  transition: height 0.24s cubic-bezier(0.34,1.3,0.5,1), width 0.24s ease, background 0.24s ease;
}
.date-scrub:not(.snapping) .dsb-tick:hover .dsb-bar { height: 17px; background: rgba(123,127,178,0.5); }
.dsb-tick.on .dsb-bar { width: 4px; height: 22px; background: var(--color-primary); }

/* 日期小签：当前刻度常显，其余 hover 浮出 */
.dsb-tip {
  position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  margin-top: 4px; font-size: 10px; white-space: nowrap;
  color: var(--text-secondary); opacity: 0; pointer-events: none;
  transition: opacity 0.18s ease;
}
.dsb-tick:hover .dsb-tip { opacity: 1; }
.dsb-tick.on .dsb-tip { opacity: 1; color: #5a5e86; font-weight: 600; }

/* playhead：正中的淡竖线，标出"当前位"（刻度带在它底下滑过） */
.ds-playhead {
  position: absolute; top: 2px; left: 50%; transform: translateX(-50%);
  width: 2px; height: 26px; border-radius: 99px;
  background: rgba(123,127,178,0.16);
  pointer-events: none;
}
</style>
