<template>
  <div ref="layoutRef" class="rec-layout">
    <!-- 顶部日期滑杆和玻璃卡列逐帧同步；松手后只做无动画的精确对齐。
         日历快速定位入口挪到了顶部胶囊行（index.vue，筛选框左边），选中日期写进
         store.jumpTarget，这里只管接住并跳转。 -->
    <div class="rec-scrub-row">
      <DateIndex :groups="indexGroups" :center-frac="centerFrac" @scrub="onScrub" @snap="onSnap" />
    </div>

    <!-- 横置便签流：左侧是过往、右侧是后来的日期；列内竖滚翻当天 -->
    <div ref="scrollRef" class="rec-hscroll" @wheel="onWheel" @scroll="onScroll">
      <div v-if="store.loading && !store.loaded" class="rec-loading">加载中…</div>
      <RecordTimeline
        v-else
        ref="timelineRef"
        :groups="timelineGroups"
        :highlight-id="highlightId"
        :filtered="!!store.filterQ.trim()"
        @save="onSave"
        @delete="onDelete"
        @toggle-task="onToggleTask"
      />
    </div>

    <div class="rec-capture">
      <CaptureBar ref="captureRef" @created="onCreated" />
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
const captureRef  = ref<InstanceType<typeof CaptureBar> | null>(null)
const scrollRef   = ref<HTMLElement | null>(null)
const layoutRef   = ref<HTMLElement | null>(null)

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
  stopCardFollow()
  root.scrollLeft += e.deltaY
  e.preventDefault()
}

// ── 滑杆语义：聚焦哪天、那天的列停在「内容区正中」（= 滑杆 playhead 那条竖线所在）──
// 列的滚动条铺满整个视口宽（#3：可被侧栏遮住），但对齐中心不是视口中心、而是内容区
// 中心（侧栏右侧那块的正中），才能和上方胶囊/滑杆的居中对齐。
// 「当前」= 中心离内容区中线最近的列。判定要随每个滚动像素连续变化，超出 IntersectionObserver
// 的能力（只在进出边界回调），改用 rAF 节流的 scroll 手算（几十列一次遍历微不足道）。
const SIDEBAR_W = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 220
// store 保持「最新优先」，展示层改为时间正序：左侧是过往，右侧是后来的日期。
const timelineGroups = computed(() => [...store.timeline].reverse())
const indexGroups = computed(() => timelineGroups.value.map(g => ({ date: g.date, count: g.items.length })))
const activeDate  = ref('')
const centerFrac  = ref(0)   // 连续分数位置：内容区中线落在第几列（含小数），驱动滑杆连续跟随
const todayIso    = computed(() => _today())
let scrollRaf = 0

/** 读取记录页的实际中线，再换算到横向滚动容器坐标，避免侧栏/内边距带来的推算偏差。 */
function contentCenter(root: HTMLElement) {
  const layout = layoutRef.value
  if (!layout) return (SIDEBAR_W + root.clientWidth) / 2
  const rootRect = root.getBoundingClientRect()
  const layoutRect = layout.getBoundingClientRect()
  return layoutRect.left - rootRect.left + layoutRect.width / 2
}
/** 各列中心（滚动内容坐标），按 date 顺序（左旧右新） */
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

function onSnap(date: string) {
  activeDate.value = date
}

let cardFollowRaf = 0
let cardTargetLeft = 0
let cardFollowVelocity = 0
let cardFollowLast = 0

function stopCardFollow() {
  if (cardFollowRaf) cancelAnimationFrame(cardFollowRaf)
  cardFollowRaf = 0
  cardFollowVelocity = 0
}

/** 让玻璃卡列带阻尼地追随目标位置；日期条本身仍直接跟手。 */
function followCardsTo(left: number) {
  const root = scrollRef.value
  if (!root) return
  cardTargetLeft = Math.max(0, Math.min(root.scrollWidth - root.clientWidth, left))
  if (cardFollowRaf) return
  let pos = root.scrollLeft
  cardFollowLast = performance.now()
  const frame = (now: number) => {
    const current = scrollRef.value
    if (!current) { stopCardFollow(); return }
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - cardFollowLast) / 1000))
    cardFollowLast = now
    const spring = 210
    const damping = 28
    cardFollowVelocity += (spring * (cardTargetLeft - pos) - damping * cardFollowVelocity) * dt
    pos += cardFollowVelocity * dt
    current.scrollLeft = pos
    if (Math.abs(cardTargetLeft - pos) > 0.25 || Math.abs(cardFollowVelocity) > 2) {
      cardFollowRaf = requestAnimationFrame(frame)
      return
    }
    current.scrollLeft = cardTargetLeft
    cardFollowRaf = 0
    cardFollowVelocity = 0
  }
  cardFollowRaf = requestAnimationFrame(frame)
}

/** 滑杆拖动/回正期间，让玻璃卡列按相同的连续日期位置带阻尼跟随。 */
function onScrub(frac: number) {
  const root = scrollRef.value
  if (!root) return
  const cols = colCenters(root)
  if (!cols.length) return
  const clamped = Math.max(0, Math.min(cols.length - 1, frac))
  const lo = Math.floor(clamped)
  const hi = Math.min(lo + 1, cols.length - 1)
  const t = clamped - lo
  const center = cols[lo].c + (cols[hi].c - cols[lo].c) * t
  followCardsTo(center - contentCenter(root))
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

// ── 快速定位：日历弹层选任意日期（弹层自带"今天"快捷按钮，选中即是同一条路径）。
// 没便签的日期不出列（#见 RecordTimeline 注释），选中的目标日不存在时退化到最近的
// 有记录的日期，并给出明确反馈，不静默跳偏；选的正好是今天且没记录，顺手展开捕捉条邀请写一条。 ──
function fmtMD(iso: string) {
  const [, m, d] = iso.split('-')
  return `${+m}月${+d}日`
}
function nearestExistingDate(target: string): string | null {
  const dates = indexGroups.value.map(g => g.date)
  if (!dates.length) return null
  const targetMs = new Date(target + 'T00:00:00').getTime()
  let best = dates[0], bestDiff = Infinity
  for (const d of dates) {
    const diff = Math.abs(new Date(d + 'T00:00:00').getTime() - targetMs)
    if (diff < bestDiff) { bestDiff = diff; best = d }
  }
  return best
}
watch(() => store.jumpTarget, (date) => {
  if (!date) return
  if (indexGroups.value.some(g => g.date === date)) { jumpTo(date); return }
  const nearest = nearestExistingDate(date)
  if (nearest) jumpTo(nearest)
  if (date === todayIso.value) {
    Message.info('今天还没有记录，写一条试试～')
    captureRef.value?.expand()
  } else if (nearest) {
    Message.info(`${fmtMD(date)}没有记录，已定位到最近的 ${fmtMD(nearest)}`)
  } else {
    Message.info('还没有任何记录')
  }
})

// resize：内容区中线变了，把当前列瞬时重新居中（不飞入）
function onResize() {
  stopCardFollow()
  if (activeDate.value) jumpTo(activeDate.value, false)
}
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => {
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  stopCardFollow()
  window.removeEventListener('resize', onResize)
})

// 首次数据就绪：今天（最右一列）直接定在正中，不播滚动动画
let centeredOnce = false
let renderedDates: string[] = []
watch(timelineGroups, async (groups) => {
  const root = scrollRef.value
  const widthBefore = root?.scrollWidth ?? 0
  const leftBefore = root?.scrollLeft ?? 0
  const newDateIndex = groups.findIndex(group => !renderedDates.includes(group.date))
  const activeIndexBefore = renderedDates.indexOf(activeDate.value)
  const insertedBeforeActive = renderedDates.length > 0 && newDateIndex >= 0 && activeIndexBefore >= newDateIndex
  if (insertedBeforeActive && root) {
    // watcher 默认在 DOM 提交前运行，先预补偿一个日期列宽，避免旧卡先被顶开一帧。
    root.scrollLeft += 306
  }
  await nextTick()
  if (!centeredOnce && groups.length) {
    centeredOnce = true
    jumpTo(groups[groups.length - 1].date, false)
  } else if (insertedBeforeActive && root) {
    // 以实测宽度校准预补偿，兼容列宽/间距将来的调整。
    root.scrollLeft = leftBefore + root.scrollWidth - widthBefore
  }
  renderedDates = groups.map(group => group.date)
  updateActive()
}, { immediate: true })

// ── 新建：不移动当前视野；新日期卡在右侧单独入场，补录仍 toast 报落点 ──
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
    // 补录落进左边较远的日期列，眼前不会有任何动静——不给反馈用户会以为没保存
    const [, m, d] = capturedAt.slice(0, 10).split('-')
    Message.success(`已记到 ${+m} 月 ${+d} 日`)
    return
  }
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
  /* 日期条已统一管理吸附；原生 scroll-snap 会在动画结束后按另一套 padding 规则二次改写位置。 */
  scroll-snap-type: none;
  scrollbar-width: none;
  padding-bottom: 96px;   /* 给底部停靠的捕捉条让空间，最下的卡不被盖住 */
}
.rec-hscroll::-webkit-scrollbar { display: none; }

.rec-loading { padding: 40px 24px; font-size: 12.5px; color: var(--text-secondary); }

/* 日期滑杆贴齐顶部胶囊（204px）量级；日历快速定位入口挪去了顶部胶囊行，这里只剩滑杆本身 */
.rec-scrub-row { display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.rec-scrub-row > :deep(.date-scrub) { flex: 0 0 210px; }

/* 捕捉条：停靠底部、在内容区水平居中（与胶囊/滑杆对齐）。
   bottom:28 与胶囊顶 28（fullBleed padding-top）等距，跟咕咕悬浮球 bottom:28 齐平 */
.rec-capture {
  position: absolute; bottom: 28px; left: 0; right: 0;
  margin: 0 auto;
  width: min(100% - 24px, 680px);
  z-index: 8;
}
</style>
