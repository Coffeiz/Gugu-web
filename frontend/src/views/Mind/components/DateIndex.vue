<template>
  <!-- 日期刻度滑杆：playhead 固定在正中，刻度带整体平移让「当前日」的高刻度停在中线。
       可鼠标拖动左右滑（拖动 1:1 跟手，松手 spring 吸附到最近刻度）；点某根刻度直接吸过去。
       只列有便签的日期（与列一一对应），左新右旧与列序一致。 -->
  <div ref="stripRef" class="date-scrub" @pointerdown="onDown">
    <div ref="trackRef" class="ds-track" :class="{ dragging }"
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
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  groups: { date: string; count: number }[]
  active: string
}>()
const emit = defineEmits<{ (e: 'jump', date: string): void }>()

const stripRef = ref<HTMLElement | null>(null)
const trackRef = ref<HTMLElement | null>(null)
const offset   = ref(0)
const dragging = ref(false)

/** 把第 idx 根刻度的中心平移到容器中线所需的 translateX（读实测几何，不硬编码刻度间距） */
function centerOffsetFor(idx: number): number {
  const strip = stripRef.value, track = trackRef.value
  if (!strip || !track) return 0
  const tick = track.children[idx] as HTMLElement | undefined
  if (!tick) return 0
  return strip.clientWidth / 2 - (tick.offsetLeft + tick.offsetWidth / 2)
}

/** 当前 offset 下，离中线最近的刻度 index */
function nearestIndex(): number {
  const strip = stripRef.value, track = trackRef.value
  if (!strip || !track) return 0
  const centerInTrack = strip.clientWidth / 2 - offset.value
  let best = 0, bestDist = Infinity
  for (let i = 0; i < track.children.length; i++) {
    const t = track.children[i] as HTMLElement
    const d = Math.abs(t.offsetLeft + t.offsetWidth / 2 - centerInTrack)
    if (d < bestDist) { best = i; bestDist = d }
  }
  return best
}

// 外部（列滚动）改了 active → 把对应刻度带到中线（拖动中不抢，避免和手指打架）
watch(() => props.active, async (d) => {
  if (dragging.value || !d) return
  await nextTick()
  const idx = props.groups.findIndex(g => g.date === d)
  if (idx >= 0) offset.value = centerOffsetFor(idx)
})
// 数据/尺寸就绪后先摆正一次
watch(() => props.groups, async () => {
  await nextTick()
  const idx = Math.max(0, props.groups.findIndex(g => g.date === props.active))
  offset.value = centerOffsetFor(idx)
}, { immediate: true })

// ── 拖动：1:1 跟手（linear），松手 spring 吸附最近刻度并 emit ──────────────────
let startX = 0, startOffset = 0, moved = false, downIdx = -1

function onDown(e: PointerEvent) {
  startX = e.clientX
  startOffset = offset.value
  moved = false
  // 记录按下的是哪根刻度（用于"点击直接吸过去"，与"拖动"区分）
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
  offset.value = startOffset + dx   // 跟手：无过渡，1:1
}

function onUp() {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  dragging.value = false
  // 点击（没拖动）→ 吸到点的那根；拖动 → 吸到离中线最近的那根
  const idx = (!moved && downIdx >= 0) ? downIdx : nearestIndex()
  offset.value = centerOffsetFor(idx)   // transition 恢复 → spring 吸附
  const date = props.groups[idx]?.date
  if (date && date !== props.active) emit('jump', date)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
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
}
/* 松手吸附走 spring；拖动中去掉过渡（跟手） */
.ds-track:not(.dragging) {
  transition: transform 0.42s cubic-bezier(0.34, 1.3, 0.5, 1);
}

/* 每根刻度 10px 透明命中区，视觉只露中间 3px 的杆 */
.dsb-tick {
  position: relative; flex-shrink: 0;
  display: flex; align-items: flex-end; justify-content: center;
  width: 10px; height: 22px; padding: 0;
  border: none; background: none; cursor: inherit;
}
.dsb-bar {
  width: 3px; height: 12px; border-radius: 99px;
  background: rgba(123,127,178,0.3);
  transition: height 0.18s ease, background 0.18s ease, width 0.18s ease;
}
.date-scrub:not(.dragging) .dsb-tick:hover .dsb-bar { height: 17px; background: rgba(123,127,178,0.5); }
.dsb-tick.on .dsb-bar { width: 4px; height: 22px; background: var(--color-primary); }

/* 日期小签：当前刻度常显，其余 hover 浮出 */
.dsb-tip {
  position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  margin-top: 4px; font-size: 10px; white-space: nowrap;
  color: var(--text-secondary); opacity: 0; pointer-events: none;
  transition: opacity 0.15s ease;
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
