<template>
  <div class="rec-layout">
    <!-- 顶部日期滑杆：拖动连续联动列（seek）、松手/点击平滑吸附（snap）、列滚动反向驱动（centerFrac）-->
    <DateIndex :groups="indexGroups" :active="activeDate" :center-frac="centerFrac"
               @seek="onSeek" @snap="d => jumpTo(d, true)" />

    <!-- 横置便签流：横向翻历史（滚轮转横滚），列内竖滚翻当天 -->
    <div ref="scrollRef" class="rec-hscroll" :class="{ 'snap-off': snapOff }" @wheel="onWheel" @scroll="onScroll">
      <div v-if="store.loading && !store.loaded" class="rec-loading">加载中…</div>
      <RecordTimeline
        v-else
        ref="timelineRef"
        :groups="store.timeline"
        :highlight-id="highlightId"
        :filtered="!!store.filterQ.trim()"
        @save="onSave"
        @delete="onDelete"
        @toggle-task="onToggleTask"
      />
    </div>

    <div class="rec-capture">
      <CaptureBar @created="onCreated" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useLiveStore } from '@/stores/live'
import { MindConflictError, useMindStore } from '@/stores/mind'
import { toggleTaskInMd } from '@/composables/useMindEditor'
import type { MindNote } from '@/services/api'
import CaptureBar from './components/CaptureBar.vue'
import DateIndex from './components/DateIndex.vue'
import RecordTimeline from './components/RecordTimeline.vue'

const store     = useMindStore()
const liveStore = useLiveStore()
const timelineRef = ref<InstanceType<typeof RecordTimeline> | null>(null)
const scrollRef   = ref<HTMLElement | null>(null)

const highlightId = ref<number | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

onMounted(() => { if (!store.loaded) store.fetchNotes() })

// 咕咕/多端改了便签 → 重新拉（P3 后端才开始推 mind 资源，这里先接好）
watch(() => liveStore.rev.mind, () => store.fetchNotes())

// ── 滚轮：悬在有溢出的列上→列内竖滚（浏览器默认）；否则纵滚轮转横滚（翻历史）──
function onWheel(e: WheelEvent) {
  const root = scrollRef.value
  if (!root) return
  if (e.deltaX || e.shiftKey) return   // 触控板横扫/Shift+滚轮：浏览器自己会横滚
  const colBody = (e.target as HTMLElement).closest<HTMLElement>('.tl-col-body')
  if (colBody && colBody.scrollHeight > colBody.clientHeight + 2) return
  root.scrollLeft += e.deltaY
  e.preventDefault()
}

// ── 滑杆语义：聚焦哪天、那天的列停在「内容区正中」（= 滑杆 playhead 那条竖线所在）──
// 列的滚动条铺满整个视口宽（#3：可被侧栏遮住），但对齐中心不是视口中心、而是内容区
// 中心（侧栏右侧那块的正中），才能和上方胶囊/滑杆的居中对齐。
// 「当前」= 中心离内容区中线最近的列。判定要随每个滚动像素连续变化，超出 IntersectionObserver
// 的能力（只在进出边界回调），改用 rAF 节流的 scroll 手算（几十列一次遍历微不足道）。
const SIDEBAR_W = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 220
const indexGroups = computed(() => store.timeline.map(g => ({ date: g.date, count: g.items.length })))
const activeDate  = ref('')
const centerFrac  = ref(0)   // 连续分数位置：内容区中线落在第几列（含小数），驱动滑杆连续跟随
let scrollRaf = 0

/** 内容区中线在滚动容器坐标里的 x（容器左边缘 = 视口左边缘 = 0） */
function contentCenter(root: HTMLElement) { return (SIDEBAR_W + root.clientWidth) / 2 }
/** 各列中心（滚动内容坐标），按 date 顺序（左新右旧） */
function colCenters(root: HTMLElement): { date: string; c: number }[] {
  return [...root.querySelectorAll<HTMLElement>('.tl-col[data-date]')]
    .map(el => ({ date: el.dataset.date!, c: el.offsetLeft + el.offsetWidth / 2 }))
}

/** 当前滚动位置 → 连续分数 + 四舍五入的当前日 */
function updateActive() {
  const root = scrollRef.value
  if (!root) return
  const cols = colCenters(root)
  if (!cols.length) return
  const cx = root.scrollLeft + contentCenter(root)
  let frac = 0
  if (cx <= cols[0].c) frac = 0
  else if (cx >= cols[cols.length - 1].c) frac = cols.length - 1
  else {
    for (let i = 0; i < cols.length - 1; i++) {
      if (cx >= cols[i].c && cx <= cols[i + 1].c) { frac = i + (cx - cols[i].c) / (cols[i + 1].c - cols[i].c); break }
    }
  }
  centerFrac.value = frac
  activeDate.value = cols[Math.round(frac)].date
}

function onScroll() {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateActive() })
}

/** 连续分数位置 → 该位置居中所需的 scrollLeft（相邻列线性插值） */
function scrollForFrac(root: HTMLElement, p: number): number {
  const cols = colCenters(root)
  if (!cols.length) return 0
  const f = Math.max(0, Math.min(cols.length - 1, p))
  const lo = Math.floor(f), hi = Math.min(lo + 1, cols.length - 1)
  const cen = cols[lo].c + (cols[hi].c - cols[lo].c) * (f - lo)
  return cen - contentCenter(root)
}

// 滑杆驱动列滚动时关掉原生 scroll-snap（否则每帧 seek 都被吸附打架）；停 160ms 后自动恢复，
// 恢复瞬间位置已在滑杆惯性补间的落点（=某列中心=吸附点），不会跳。wheel 路径不触发 seek，
// snap 一直开着 → 触控板/滚轮滚列自带惯性 + 松开磁吸到最近日期（#4）。
const snapOff = ref(false)
let snapOffTimer: ReturnType<typeof setTimeout> | null = null
function suspendSnap() {
  snapOff.value = true
  if (snapOffTimer) clearTimeout(snapOffTimer)
  snapOffTimer = setTimeout(() => { snapOff.value = false }, 160)
}

/** 滑杆拖动/惯性补间：连续联动，列平滑跟手（瞬时设 scrollLeft，但 p 连续 → 视觉平滑，不跳格）*/
function onSeek(p: number) {
  const root = scrollRef.value
  if (!root) return
  suspendSnap()
  root.scrollLeft = scrollForFrac(root, p)
  // 立刻更新 active（不等 rAF），让刻度即时长高 + 卡片高亮跟上
  centerFrac.value = p
  const cols = colCenters(root)
  if (cols.length) activeDate.value = cols[Math.max(0, Math.min(cols.length - 1, Math.round(p)))].date
}

/** 把某天的列滚到内容区正中。animate=true → 平滑（点击/松手吸附/新建）、false → 瞬时（首载/resize）*/
function jumpTo(date: string, animate = true) {
  const root = scrollRef.value
  const col = root?.querySelector<HTMLElement>(`.tl-col[data-date="${date}"]`)
  if (root && col) {
    root.scrollTo({
      left: col.offsetLeft + col.offsetWidth / 2 - contentCenter(root),
      behavior: animate ? 'smooth' : 'auto',
    })
  }
}

// resize：内容区中线变了，把当前列瞬时重新居中（不飞入）
function onResize() { if (activeDate.value) jumpTo(activeDate.value, false) }
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => {
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  if (snapOffTimer) clearTimeout(snapOffTimer)
  window.removeEventListener('resize', onResize)
})

// 首次数据就绪：今天（最新一列）直接定在正中，不播滚动动画
let centeredOnce = false
watch(() => store.timeline, async (groups) => {
  await nextTick()
  if (!centeredOnce && groups.length) {
    centeredOnce = true
    jumpTo(groups[0].date, false)
  }
  updateActive()
}, { immediate: true })

// ── 新建：翻进历史 → 先滚回最左（今天）再插入+高亮；补录 → 不滚，toast 报落点 ──
const _today = () => new Date().toISOString().slice(0, 10)

async function onCreated(md: string, capturedAt?: string) {
  let created: MindNote
  try {
    created = await store.createNote({ contentMd: md, capturedAt })
  } catch {
    Message.error('记录失败，请重试')
    return
  }
  if (capturedAt && capturedAt.slice(0, 10) !== _today()) {
    // 补录落进右边很远的日期列，眼前不会有任何动静——不给反馈用户会以为没保存
    const [, m, d] = capturedAt.slice(0, 10).split('-')
    Message.success(`已记到 ${+m} 月 ${+d} 日`)
    return
  }
  await nextTick()               // 今天的列可能是刚创建出来的，等它进 DOM 再居中
  jumpTo(_today(), true)
  highlightId.value = created.id
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => { highlightId.value = null }, 1800)
}

async function onSave(note: MindNote, md: string) {
  try {
    await store.updateNote(note.id, { contentMd: md, version: note.version })
  } catch (e) {
    if (e instanceof MindConflictError) {
      // 乐观锁撞车：别覆盖别人的改动，拉最新回来让用户重看
      timelineRef.value?.flagConflict()
      await store.fetchNotes()
      Message.warning('这条便签已被其他端修改，已刷新为最新内容')
    } else {
      Message.error('保存失败，请重试')
    }
  }
}

/** 卡上直接勾待办：翻转第 idx 个任务再走同一条乐观锁保存路径 */
async function onToggleTask(note: MindNote, idx: number) {
  await onSave(note, toggleTaskInMd(note.contentMd, idx))
}

async function onDelete(note: MindNote) {
  try {
    await store.deleteNote(note.id)
  } catch {
    Message.error('删除失败，请重试')
  }
}
</script>

<style scoped>
.rec-layout {
  position: relative; height: 100%;
  display: flex; flex-direction: column; gap: 18px; min-height: 0;   /* 滑杆↔列的安全距离 */
}

/* #3：列的横向滚动区铺满整个视口宽——向左顶开（侧栏宽 + fullBleed 左内边距 20），
   宽度取 100vw，最左的列滚到侧栏底下（侧栏 z 更高、玻璃磨砂，自然把它们糊住）。
   列在容器内仍按「内容区中心」居中（见 timeline-cols 两端 padding + JS contentCenter），
   所以活动列和上方胶囊/滑杆对齐，只是溢出的历史列能钻到侧栏后面。 */
.rec-hscroll {
  flex: 1; min-height: 0;
  width: 100vw;
  margin-left: calc(-1 * (var(--sidebar-width) + 24px));   /* 顶到视口左：侧栏宽 + fullBleed 左内边距 24 */
  /* ⚠️ position:relative 必须有：让 .tl-col 的 offsetParent = 本容器，offsetLeft 才和本容器的
     scrollLeft 同一套原点（都从视口左 x=0 算）。否则 offsetParent 落到 rec-layout（在侧栏右侧），
     offsetLeft 从 x=244 起算、却拿去和从 x=0 起算的 scrollLeft 相减 → 列整体偏出一个侧栏宽（#1）。*/
  position: relative;
  overflow-x: auto; overflow-y: hidden;
  /* 横向：滚动时磁吸到日期列中心（scroll-snap），触控板/滚轮自带惯性、松开吸附到最近日期（#4）；
     滑杆驱动时由 JS 关掉 snap（.snap-off）免得跟每帧 seek 打架。scroll-padding-left=侧栏宽 把
     吸附中线从"视口中心"挪到"内容区中心"（= contentCenter），和滑杆 playhead 对齐。 */
  scroll-snap-type: x proximity;
  scroll-padding-left: var(--sidebar-width);
  scrollbar-width: none;
  padding-bottom: 96px;   /* 给底部停靠的捕捉条让空间，最下的卡不被盖住 */
}
.rec-hscroll.snap-off { scroll-snap-type: none; }
.rec-hscroll::-webkit-scrollbar { display: none; }

.rec-loading { padding: 40px 24px; font-size: 12.5px; color: var(--text-secondary); }

/* 捕捉条：停靠底部、在内容区水平居中（与胶囊/滑杆对齐）。
   bottom:28 与胶囊顶 28（fullBleed padding-top）等距，跟咕咕悬浮球 bottom:28 齐平 */
.rec-capture {
  position: absolute; bottom: 28px; left: 0; right: 0;
  margin: 0 auto;
  width: min(100% - 24px, 680px);
  z-index: 8;
}
</style>
