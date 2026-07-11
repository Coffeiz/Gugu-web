<template>
  <div ref="layoutRef" class="rec-layout">
    <!-- 顶部日期滑杆和玻璃卡列逐帧同步；松手后只做无动画的精确对齐。
         日历快速定位入口挪到了顶部胶囊行（index.vue，筛选框左边），选中日期写进
         store.jumpTarget，这里只管接住并跳转。相对日期文案（今天/昨天/…）直接改在
         DateIndex.vue 的刻度标签里，不单独起一个标签元素。 -->
    <div class="rec-scrub-row">
      <DateIndex :groups="indexGroups" :center-frac="centerFrac" @scrub="onScrub" @snap="onSnap" />
    </div>

    <!-- 横置便签流：左侧是过往、右侧是后来的日期；列内竖滚翻当天。
         便签以外的玻璃卡空白区域可以直接左右拖动切日期，跟顶部日期滑杆手感一致
         （见 onColumnsPointerDown 及以下三个函数）——原生 overflow-x:auto 只吃触控板横扫/
         滚动条，鼠标点了拖并不会自己动，这段手感需要自己接。 -->
    <div ref="scrollRef" class="rec-hscroll" @wheel="onWheel" @scroll="onScroll" @pointerdown="onColumnsPointerDown">
      <div v-if="store.loading && !store.loaded" class="rec-loading">加载中…</div>
      <NoteTimeline
        v-else
        ref="timelineRef"
        :groups="timelineGroups"
        :center-frac="cardVisualCenterFrac"
        :highlight-id="highlightId"
        :filtered="!!store.filterQ.trim()"
        @save="onSave"
        @delete="onDelete"
        @toggle-task="onToggleTask"
        @edit-request="onEditRequest"
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
import { localDayKey, parseUtc } from '@/utils/dateAttribution'
import { elasticPosition } from './utils/dateScrubberMath'
import CaptureBar from './components/CaptureBar.vue'
import DateIndex from './components/DateIndex.vue'
import NoteTimeline from './components/NoteTimeline.vue'

const store     = useMindStore()
const liveStore = useLiveStore()
const timelineRef = ref<InstanceType<typeof NoteTimeline> | null>(null)
const captureRef  = ref<InstanceType<typeof CaptureBar> | null>(null)
const scrollRef   = ref<HTMLElement | null>(null)
const layoutRef   = ref<HTMLElement | null>(null)

const highlightId = ref<number | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

onMounted(() => { if (!store.loaded) store.fetchNotes() })
// 进面板默认展开底部捕捉条，光标直接待输入——降低"想到就记"的操作成本，不用先点一下才能打字。
// 复用 captureRef.expand()（跟 jumpTarget=今天且当天没记录时那条路径同一个方法），内部本来
// 就会在展开后 focus 编辑器。
onMounted(() => captureRef.value?.expand())

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

// ── 便签以外的玻璃卡空白区域拖动切日期：只接鼠标（触屏本来就有原生横滚手势，不用管）；
// 点在便签本体上（.note-card，含它自己的标题/编辑/删除/勾选交互）一律放行，不抢它的点击。
// 手感跟顶部日期滑杆一致：拖动期间 1:1 跟手，松手按速度带一点惯性再吸附到最近的日期列中心，
// 复用同一套 followCardsTo 阻尼弹簧，不用另起一套缓动。
let colDragging = false
let colDragStartX = 0
let colDragStartScrollLeft = 0
let colDragVelocity = 0   // px/ms 指数滑动平均
let colDragLastX = 0
let colDragLastTime = 0
let cardVisualReturnRaf = 0
let cardRubberShift = 0
let cardRubberReturning = false

function onColumnsPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'mouse') return
  if ((e.target as HTMLElement).closest('.note-card')) return
  const root = scrollRef.value
  if (!root) return
  // 注意：这里不能 preventDefault()——pointerdown 阻止默认行为会连带抑制浏览器合成的
  // mousedown 事件，NoteCard.vue 的 onDocDown（document 上的 mousedown 监听，判断"点了
  // 卡外面就退出编辑"）就收不到这次点击了，编辑态点玻璃卡空白处会失效。文字选区改靠下面
  // 的 user-select:none 挡，不需要 preventDefault 这把大锤子。
  stopCardFollow()
  if (cardVisualReturnRaf) cancelAnimationFrame(cardVisualReturnRaf)
  cardVisualReturnRaf = 0
  cardRubberReturning = false
  cardRubberShift = 0
  cardVisualCenterFrac.value = centerFrac.value
  colDragging = true
  colDragStartX = e.clientX
  colDragStartScrollLeft = root.scrollLeft
  colDragVelocity = 0
  colDragLastX = e.clientX
  colDragLastTime = performance.now()
  root.setPointerCapture(e.pointerId)
  // 拖动过程中橡皮筋 transform 逐帧手动赋值、要立即跟手；CSS 的回弹过渡只在松手那一下要，
  // 拖着的时候关掉，不然每帧的新 transform 都会被那 0.2s 过渡追着跑，手感变粘滞。
  const cols0 = timelineColsEl()
  if (cols0) cols0.style.transition = 'none'
  // 拖动期间禁掉整页的文字选取——单单挡住 pointerdown 的默认行为不够，鼠标按下不动之后
  // 再小幅移动，部分浏览器仍会把它判成拖选文字（尤其经过便签正文这类可选文本时）。
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onColumnsPointerMove)
  window.addEventListener('pointerup', onColumnsPointerUp)
}
/** 拖过第一天/最后一天后的橡皮筋：scrollLeft 会被浏览器夹在 [0,max]，因此将越界距离
 * 映射为无硬边界的对数位移和虚拟中心。虚拟中心只继续驱动原有的左右景深曲线，并不另加
 * 一套橡皮筋缩放规则。 */
const CARD_DRAG_RATIO = 0.45 // 与 DateIndex.vue 完全一致：鼠标移动不会 1:1 推动日期位置
const CARD_RUBBER_RESPONSE = 0.45 // 对数曲线初段响应：更早变重，越往外增量越小
const CARD_COLUMN_PITCH = 454 // .tl-col 440px + 间距 14px；单卡没有相邻列时仍要有拖动单位
function timelineColsEl(): HTMLElement | null {
  return scrollRef.value?.querySelector<HTMLElement>('.timeline-cols') ?? null
}
function onColumnsPointerMove(e: PointerEvent) {
  if (!colDragging) return
  const root = scrollRef.value
  if (!root) return
  const raw = colDragStartScrollLeft - (e.clientX - colDragStartX)
  const centers = colCenters()
  if (!centers.length) return
  // 逻辑边界是首/末日期“居中”的位置，不是滚动容器的物理尽头：两侧 gutter 是为了让
  // 首末列能居中而留下的空白，若拿 scrollWidth 当边界，最后一天还得先拖过整段空白才能
  // 触发橡皮筋（截图里的 150px 延迟正是它）。
  const physicalMax = root.scrollWidth - root.clientWidth
  const logicalMin = Math.max(0, centers[0].c - contentCenter(root))
  const logicalMax = Math.max(logicalMin, Math.min(physicalMax, centers[centers.length - 1].c - contentCenter(root)))
  const clamped = Math.max(logicalMin, Math.min(logicalMax, raw))
  root.scrollLeft = clamped
  const over = raw - clamped   // 超出边界之外、原生滚动吃不下的那一截
  const cols = timelineColsEl()
  if (over) {
    // 边缘外没有真实列：从 over=0 开始就有阻力；对数曲线没有硬上限，拖得再远仍会移动，
    // 但每多拖一段的增量持续变小。
    const last = centers.length - 1
    const pitch = over < 0
      ? centers.length > 1 ? centers[1].c - centers[0].c : CARD_COLUMN_PITCH
      : centers.length > 1 ? centers[last].c - centers[last - 1].c : CARD_COLUMN_PITCH
    if (pitch > 0) {
      const boundary = over < 0 ? 0 : last
      const rawCenter = boundary + (over / pitch) * CARD_DRAG_RATIO
      const virtualCenter = elasticPosition(rawCenter, centers.length, CARD_RUBBER_RESPONSE)
      const overshootDays = virtualCenter - boundary
      const visualShift = -overshootDays * pitch
      if (cols) cols.style.transform = `translateX(${visualShift}px)`
      cardRubberShift = visualShift
      cardVisualCenterFrac.value = virtualCenter
    }
  } else if (cols) {
    cols.style.transform = ''
    cardRubberShift = 0
    cardVisualCenterFrac.value = centerFrac.value
  }
  const now = performance.now()
  const dt = Math.max(now - colDragLastTime, 4)
  const instant = (e.clientX - colDragLastX) / dt
  colDragVelocity = colDragVelocity * 0.6 + instant * 0.4   // 指数平滑，松手瞬间的抖动不会整个吃进去
  colDragLastX = e.clientX
  colDragLastTime = now
}
function onColumnsPointerUp() {
  window.removeEventListener('pointermove', onColumnsPointerMove)
  window.removeEventListener('pointerup', onColumnsPointerUp)
  document.body.style.userSelect = ''
  if (!colDragging) return
  colDragging = false
  const cols = timelineColsEl()
  if (cols) cols.style.transition = 'none'
  returnCardRubber()
  const root = scrollRef.value
  const colCenterList = colCenters()
  if (!root || !colCenterList.length) return
  // 惯性：按松手瞬间的速度多滑一点再吸附最近列，封顶避免用力过猛直接跳好几天
  const extraPx = Math.max(-260, Math.min(260, -colDragVelocity * 180))
  const cx = root.scrollLeft + extraPx + contentCenter(root)
  let nearest = colCenterList[0]
  let bestDist = Infinity
  for (const c of colCenterList) {
    const dist = Math.abs(c.c - cx)
    if (dist < bestDist) { bestDist = dist; nearest = c }
  }
  followCardsTo(nearest.c - contentCenter(root))
}

/** 外层橡皮筋回弹：位移与虚拟中心走同一套物理弹簧，避免 CSS 缓动和景深各自回正。 */
function returnCardRubber() {
  if (cardVisualReturnRaf) cancelAnimationFrame(cardVisualReturnRaf)
  const cols = timelineColsEl()
  if (!cols) return
  let shift = cardRubberShift
  let shiftVelocity = 0
  let visualCenter = cardVisualCenterFrac.value
  let centerVelocity = 0
  let last = performance.now()
  cardRubberReturning = true
  const frame = (now: number) => {
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - last) / 1000))
    last = now
    // 接近临界阻尼：先有明确回弹加速度，靠近终点自然减速，不靠线性计时缓动硬拉回去。
    const spring = 260
    const damping = 32 // 与 DateIndex 的近临界阻尼一致：回弹自然缓出、不额外摆动
    shiftVelocity += (-spring * shift - damping * shiftVelocity) * dt
    shift += shiftVelocity * dt
    const centerDelta = centerFrac.value - visualCenter
    centerVelocity += (spring * centerDelta - damping * centerVelocity) * dt
    visualCenter += centerVelocity * dt
    cols.style.transform = `translateX(${shift}px)`
    cardVisualCenterFrac.value = visualCenter
    if (Math.abs(shift) > 0.2 || Math.abs(shiftVelocity) > 2 || Math.abs(centerDelta) > .002 || Math.abs(centerVelocity) > .02) {
      cardVisualReturnRaf = requestAnimationFrame(frame)
      return
    }
    cols.style.transform = ''
    cardRubberShift = 0
    cardVisualCenterFrac.value = centerFrac.value
    cardRubberReturning = false
    cardVisualReturnRaf = 0
  }
  cardVisualReturnRaf = requestAnimationFrame(frame)
}

// ── 拖选文字只能选中"这一张便签"内的内容，点便签外面直接清掉已有选区 ──
// CSS 的 user-select:none（.rec-hscroll 的玻璃卡背景）只能挡住"从空白处开始"的选区，挡不住
// "从便签内部拖出去、经过背景、又拖进另一张便签"这种一路蔓延的情况——浏览器的原生选区不
// 关心容器边界，得自己用 Selection API 在选区变化时把它夹回起手的那张便签里。
let selectionOriginNote: HTMLElement | null = null
function onGlobalMouseDown(e: MouseEvent) {
  const noteEl = (e.target as HTMLElement).closest<HTMLElement>('.note-card')
  selectionOriginNote = noteEl
  if (!noteEl) window.getSelection()?.removeAllRanges()   // 点便签外面：清掉之前选中的文字
}
function onSelectionChange() {
  const note = selectionOriginNote
  if (!note) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
  const range = sel.getRangeAt(0)
  const bounds = document.createRange()
  bounds.selectNodeContents(note)
  let changed = false
  if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
    range.setStart(bounds.startContainer, bounds.startOffset)
    changed = true
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
    range.setEnd(bounds.endContainer, bounds.endOffset)
    changed = true
  }
  if (changed) { sel.removeAllRanges(); sel.addRange(range) }
}
onMounted(() => {
  document.addEventListener('mousedown', onGlobalMouseDown, true)
  document.addEventListener('selectionchange', onSelectionChange)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onGlobalMouseDown, true)
  document.removeEventListener('selectionchange', onSelectionChange)
})

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
// 连续分数位置：内容区中线（=屏幕上的物理中心）落在第几列（含小数）。滑杆和玻璃卡的
// 深度效果共用同一个值，不再单独滞后平滑——卡片尺寸必须严格绑定「谁现在正在屏幕中间」，
// 不管这一刻的当前日/选中日是谁，物理居中的那张才该是最大的。
const centerFrac  = ref(0)
// 卡片景深默认跟真实中心；越界时临时使用对数橡皮筋推导出的虚拟中心，仍走同一条景深曲线。
const cardVisualCenterFrac = ref(0)
const todayIso    = computed(() => _today())
let scrollRaf = 0

/** 读取笔记页的实际中线，再换算到横向滚动容器坐标，避免侧栏/内边距带来的推算偏差。 */
function contentCenter(root: HTMLElement) {
  const layout = layoutRef.value
  if (!layout) return (SIDEBAR_W + root.clientWidth) / 2
  const rootRect = root.getBoundingClientRect()
  const layoutRect = layout.getBoundingClientRect()
  return layoutRect.left - rootRect.left + layoutRect.width / 2
}

/**
 * 时间流两端的留白必须和 contentCenter() 使用同一套实测坐标。此前 CSS 用 vw/sidebar
 * 估算、JS 用实际 rect 定位，多列时可滚动余量会掩盖两者误差，单列却会直接停在偏移处。
 */
function syncTimelineGutters(root: HTMLElement) {
  const halfColumn = 220 // .tl-col 宽 440px 的一半，改列宽时一并更新
  const center = contentCenter(root)
  root.style.setProperty('--timeline-left-gutter', `${Math.max(0, center - halfColumn)}px`)
  // 右侧额外留出缓冲，保证首末列都能被滚到实测中线。
  root.style.setProperty('--timeline-right-gutter', `${Math.max(0, root.clientWidth - center - halfColumn) + 300}px`)
}
// 列的 DOM 节点列表缓存：日期列表结构没变时（绝大多数滚动/拖动帧）不用每帧重新
// querySelectorAll，只在 timelineGroups 变化、DOM 实际增删列之后才重查一次。
let colEls: HTMLElement[] = []
function refreshColEls() {
  const root = scrollRef.value
  colEls = root ? [...root.querySelectorAll<HTMLElement>('.tl-col[data-date]')] : []
}
/** 各列中心（滚动内容坐标），按 date 顺序（左旧右新）；offsetLeft/offsetWidth 仍每次实测
 *  （resize 等会让它们变化），只有「查哪些节点」这一步走缓存。 */
function colCenters(): { date: string; c: number }[] {
  return colEls.map(el => ({ date: el.dataset.date!, c: el.offsetLeft + el.offsetWidth / 2 }))
}

/** 当前滚动位置 → 连续分数 + 四舍五入的当前日 */
function updateActive() {
  const root = scrollRef.value
  if (!root) return
  const cols = colCenters()
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
  if (!colDragging && !cardRubberReturning) cardVisualCenterFrac.value = frac
  activeDate.value = cols[Math.round(frac)].date
}

function onScroll() {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateActive() })
}

function onSnap(date: string) {
  suppressEditGuard = false   // 同 onScrub：用户自己操作滑杆，不该再当成"飞去编辑目标"处理
  activeDate.value = date
}

let cardFollowRaf = 0
let cardTargetLeft = 0
let cardFollowVelocity = 0
let cardFollowLast = 0
// 弹簧真正停稳那一刻要调的回调（点两侧便签→居中后进编辑态就靠这个，不能靠原生 scrollend——
// 这段位移是手动改 scrollLeft 画的，不是浏览器自己的 smooth scroll，scrollend 对着这种
// "每帧手动挪一点"的滚动会在弹簧还没真正到位时就提前触发，编辑请求那时候拿 activeDate
// 一比对不上目标日期，直接被判定"作废"——便签飞到中间了却死活不进编辑态，就是这个原因）。
let cardFollowOnSettled: (() => void) | null = null

function stopCardFollow() {
  if (cardFollowRaf) cancelAnimationFrame(cardFollowRaf)
  cardFollowRaf = 0
  cardFollowVelocity = 0
  cardFollowOnSettled = null   // 弹簧被打断（比如用户自己划走了）就不该再触发那个回调
  suppressEditGuard = false   // 同上：这趟"追向编辑目标"的位移被用户自己的操作打断了，
                              // 居中日期改判定要立刻恢复正常，该退出编辑就退出
}

/** 让玻璃卡列带阻尼地追随目标位置；日期条本身仍直接跟手。onSettled 只在弹簧真正停稳时调
 *  一次——连续调用 followCardsTo（拖拽/连续点击）时，只有最后一次传的回调会生效，之前
 *  排队的会被静默顶掉（跟"编辑请求以最后一次点击为准"是同一个语义）。 */
function followCardsTo(left: number, onSettled?: () => void) {
  const root = scrollRef.value
  if (!root) return
  cardTargetLeft = Math.max(0, Math.min(root.scrollWidth - root.clientWidth, left))
  cardFollowOnSettled = onSettled ?? null
  if (cardFollowRaf) return
  let pos = root.scrollLeft
  cardFollowLast = performance.now()
  const frame = (now: number) => {
    const current = scrollRef.value
    if (!current) { stopCardFollow(); return }
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - cardFollowLast) / 1000))
    cardFollowLast = now
    const spring = 260
    const damping = 32 // 与顶部日期滑条同一套近临界阻尼参数
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
    const settled = cardFollowOnSettled
    cardFollowOnSettled = null
    settled?.()
  }
  cardFollowRaf = requestAnimationFrame(frame)
}

/** 滑杆拖动/回正期间，让玻璃卡列按相同的连续日期位置带阻尼跟随。 */
function onScrub(frac: number) {
  const root = scrollRef.value
  if (!root) return
  // 用户自己在拖滑杆了——这次不管是不是正在"飞去匹配编辑目标"，都算被打断，恢复正常判定
  // （followCardsTo 下面这行会顶掉原来的 onSettled，不会再触发那个回调把它设回 false）
  suppressEditGuard = false
  const cols = colCenters()
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

// ── 编辑态强制绑定居中日期：点两侧列的便签立刻进编辑态（点了却要等移动完才有反应，
// 不符合直觉），同时把那天滚到正中——先进编辑、再移动过去，不是先移动、移动完才进编辑。
// 「居中日期变了就退出编辑」统一交给下面 watch(activeDate) 处理。──
const editingNoteDate = ref<string | null>(null)
// 移动去追一个"已经在编辑"的目标日期期间，中途路过的日期不该被 watch(activeDate) 当成
// "居中变了、该退出编辑"——不然编辑态还没等飞到目标列就被沿途经过的其它日期打断了。
// 被用户自己的操作（拖滑杆/滚轮/resize）打断就在 stopCardFollow 里恢复正常判定。
let suppressEditGuard = false

function onEditRequest(n: MindNote) {
  const noteDate = n.capturedAt.slice(0, 10)
  editingNoteDate.value = noteDate
  timelineRef.value?.confirmEdit(n)
  if (noteDate === activeDate.value) return
  const root = scrollRef.value
  const col = root?.querySelector<HTMLElement>(`.tl-col[data-date="${noteDate}"]`)
  if (!root || !col) return
  suppressEditGuard = true
  // 用 followCardsTo（滑杆拖动松手吸附的那套阻尼弹簧），不用 jumpTo 的浏览器原生
  // smooth scroll——原生那个太快、跟切换日期时的手感对不上，统一成同一种"阻尼速度"。
  followCardsTo(col.offsetLeft + col.offsetWidth / 2 - contentCenter(root), () => {
    suppressEditGuard = false
  })
}
// 居中日期一变（滑杆拖动/滚轮/跳转…任何原因），只要跟正在编辑的便签所在日期对不上了
// 就退出编辑态；suppressEditGuard 为真时是"正在飞去匹配已经打开的编辑目标"，沿途路过
// 的日期不算数，不提前判定。
watch(activeDate, (cur) => {
  if (suppressEditGuard) return
  if (cur === editingNoteDate.value) return
  timelineRef.value?.stopEditing()
  editingNoteDate.value = null
})

// ── 快速定位：日历弹层选任意日期（弹层自带"今天"快捷按钮，选中即是同一条路径）。
// 没便签的日期不出列（#见 NoteTimeline 注释），选中的目标日不存在时退化到最近的
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
  if (cardVisualReturnRaf) cancelAnimationFrame(cardVisualReturnRaf)
  cardVisualReturnRaf = 0
  cardRubberReturning = false
  cardRubberShift = 0
  const cols = timelineColsEl()
  if (cols) cols.style.transform = ''
  const root = scrollRef.value
  if (!root) return
  syncTimelineGutters(root)
  if (activeDate.value) jumpTo(activeDate.value, false)
}
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => {
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  if (cardVisualReturnRaf) cancelAnimationFrame(cardVisualReturnRaf)
  cardRubberReturning = false
  stopCardFollow()
  window.removeEventListener('resize', onResize)
  window.removeEventListener('pointermove', onColumnsPointerMove)
  window.removeEventListener('pointerup', onColumnsPointerUp)
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
  // 多列删除到仅剩一天时，旧视野的 scrollLeft 已经没有语义；不能只重算 gutter，必须把
  // 唯一日期按新布局重新定位，否则它会停在多列时留下的左侧位置。
  const collapsedToSingle = renderedDates.length > 1 && groups.length === 1
  if (insertedBeforeActive && root) {
    // watcher 默认在 DOM 提交前运行，先预补偿一个日期列宽，避免旧卡先被顶开一帧。
    root.scrollLeft += 306
  }
  await nextTick()
  if (root) syncTimelineGutters(root)
  await nextTick()
  refreshColEls()   // 日期列增删后 DOM 已提交，这里是唯一需要重查节点的地方
  if (!centeredOnce && groups.length) {
    centeredOnce = true
    jumpTo(groups[groups.length - 1].date, false)
  } else if (collapsedToSingle && root) {
    root.scrollLeft = 0
    jumpTo(groups[0].date, false)
  } else if (insertedBeforeActive && root) {
    // 以实测宽度校准预补偿，兼容列宽/间距将来的调整。
    root.scrollLeft = leftBefore + root.scrollWidth - widthBefore
  }
  renderedDates = groups.map(group => group.date)
  updateActive()
}, { immediate: true })

// 切回笔记页时 store 往往已经有缓存数据：immediate watcher 会早于 ref 挂载执行，虽标记了
// centeredOnce，却没有真实滚动容器可对齐。等路由布局完成一帧后以实测中线补一次无动画校准。
onMounted(async () => {
  await nextTick()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const root = scrollRef.value
  const groups = timelineGroups.value
  if (!root || !groups.length) return
  syncTimelineGutters(root)
  refreshColEls()
  const date = groups.some(group => group.date === activeDate.value)
    ? activeDate.value
    : groups[groups.length - 1].date
  jumpTo(date, false)
  updateActive()
})

// ── 新建：不移动当前视野；新日期卡在右侧单独入场，补录仍 toast 报落点 ──
const _today = () => localDayKey(new Date())   // 本地今天（不是 UTC）

async function onCreated(md: string, capturedAt?: string) {
  let created: MindNote
  try {
    created = await store.createNote({ contentMd: md, capturedAt })
  } catch {
    Message.error('记录失败，请重试')
    return
  }
  if (capturedAt && localDayKey(parseUtc(capturedAt)) !== _today()) {
    // 补录落进左边较远的日期列，眼前不会有任何动静——不给反馈用户会以为没保存
    const [, m, d] = localDayKey(parseUtc(capturedAt)).split('-')
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
  cursor: grab;
  /* 玻璃卡空白区域（日期头、卡间空隙…）不可选中：user-select 会被子孙继承，便签内容要
     选回来见下面的 :deep(.note-card) 覆盖。这样从空白处拖到便签上不会顺手选中背景文字，
     从便签里拖出空白区域时选区也会在边界卡住，不会一路蔓延选到旁边别的便签。 */
  user-select: none;
}
.rec-hscroll:active { cursor: grabbing; }
.rec-hscroll::-webkit-scrollbar { display: none; }
/* 便签本体不该显得能拖（它自己有点击进编辑等交互），光标退回默认；文字选取也要选回来 */
.rec-hscroll :deep(.note-card) { cursor: default; user-select: text; }

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
  /* 深度效果给居中列写的 zIndex 最高到 100（NoteTimeline columnStyle），捕捉条必须盖过它 */
  z-index: 120;
}
</style>
