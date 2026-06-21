<template>
  <div class="cal-page">

    <!-- 工具栏 -->
    <div class="cal-toolbar glass-card">
      <div class="toolbar-left">
        <button class="nav-btn" @click="prev">
          <PhCaretLeft :size="14" weight="bold" />
        </button>
        <button class="period-btn" ref="pickerAnchorRef" @click="togglePicker">
          <span>{{ periodLabel }}</span>
          <PhCaretDown :size="11" weight="bold" :style="{ transform: pickerOpen ? 'rotate(180deg)' : '', transition: 'transform 0.2s' }" />
        </button>
        <button class="nav-btn" @click="next">
          <PhCaretRight :size="14" weight="bold" />
        </button>
      </div>
      <button class="today-btn" @click="goToday">今天</button>
    </div>

    <!-- 主体 -->
    <div class="cal-layout">

      <!-- 日历主区 -->
      <div class="cal-main glass-card">
        <div class="weekday-row">
          <span v-for="w in weekdays" :key="w" class="weekday-hdr" :class="{ weekend: w === '六' || w === '日' }">{{ w }}</span>
        </div>

        <div class="month-body">
          <div
            v-for="(week, wi) in monthWeeks" :key="wi"
            class="week-row"
            :data-wi="wi"
            :ref="el => setWeekRef(el, wi)"
            @mousemove="onWeekMouseMove($event, week)"
            @mouseleave="hoveredDateIso = null"
          >
            <div
              v-for="d in week" :key="d.key"
              class="month-cell"
              :data-iso="d.iso"
              :class="{
                'other-month': d.other,
                'is-today':    d.isToday,
                'is-selected': d.iso === selectedDate,
                'is-weekend':  d.dow >= 5,
                'is-holiday':  !d.other && hdayType(d.iso) === 'holiday',
                'is-workday':  !d.other && hdayType(d.iso) === 'workday',
                'cell-hovered': d.iso === hoveredDateIso,
              }"
              @click="!drag.active && (selectedDate = d.iso)"
            >
              <div class="cell-head">
                <div class="cell-num">{{ d.date }}</div>
                <span v-if="!d.other && hdayType(d.iso)" class="hday-badge" :class="'hday-' + hdayType(d.iso)">{{ hdayType(d.iso) === 'holiday' ? '休' : '班' }}</span>
              </div>
              <!-- chips：paddingTop 将格子坐标系对齐到 bars-layer 坐标系 -->
              <template v-for="lay in [dayLayout(d.iso, week, wi)]" :key="'lay'">
                <div
                  class="cell-chips"
                  :style="{ paddingTop: lay.paddingTop + 'px' }"
                >
                  <div
                    v-for="ev in lay.visibleChips" :key="ev.id"
                    class="event-chip cal-chip"
                    :class="{ 'chip-proj': ev.isProject, 'chip-ev-click': ev.isUserEvent }"
                    :style="{ background: ev.accent + '28', color: darkenHex(ev.accent), borderColor: ev.accent + '70', cursor: ev.isProject || ev.isUserEvent ? 'pointer' : 'default' }"
                    @click.left.stop="ev.isProject ? openProject(ev) : (ev.isUserEvent && openEditForm(ev, $event, true))"
                    @contextmenu.prevent.stop="ev.isUserEvent && openEditForm(ev, $event, true)"
                    @mousedown.stop="ev.isProject ? startProjChipDrag(ev, $event) : (ev.isUserEvent && startEventDrag(ev, $event))"
                  >
                    <span v-if="ev.isProject" class="chip-proj-tag">项目</span>
                    <span v-else class="chip-proj-tag chip-ev-tag">活动</span>
                    <span v-if="ev.isProject" class="bar-status-dot" :class="'bsd-' + ev.status"></span>
                    {{ ev.name }}
                  </div>
                  <button
                    v-if="lay.moreCount > 0"
                    class="chip-more-btn cal-chip"
                    @click.stop="showMore($event, d.iso, lay.moreItems)"
                  >+{{ lay.moreCount }} 更多</button>
                </div>
              </template>
            </div>

            <!-- 项目条层（绝对定位，覆盖整行，不再有溢出按钮） -->
            <div class="bars-layer">
              <template v-for="bar in weekBarsCapped(week, wi).bars" :key="bar.id">
                <div
                  class="project-bar cal-chip"
                  :class="{ 'bar-start': bar.startsHere, 'bar-end': bar.endsHere, 'bar-dragging': drag.active && drag.item?.id === bar.id, 'bar-hovered': hoveredBarId === bar.id }"
                  :data-bar-id="bar.id"
                  @mouseenter="hoveredBarId = bar.id"
                  @mouseleave="hoveredBarId = null"
                  @click.stop="openProject(bar)"
                  @mousedown.stop="startBarDrag(bar, $event)"
                  :style="{
                    left:  bar.startsHere ? `calc(${bar.colStart / 7 * 100}% + 6px)` : (bar.colStart / 7 * 100) + '%',
                    right: bar.endsHere   ? `calc(${(7 - bar.colEnd - 1) / 7 * 100}% + 6px)` : ((7 - bar.colEnd - 1) / 7 * 100) + '%',
                    top:   (HEADER_H + bar.row * BAR_H) + 'px',
                    background: `linear-gradient(to right, ${bar.accent}50 0%, ${bar.accent}50 ${barSegFill(bar)}%, ${bar.accent}1a ${barSegFill(bar)}%, ${bar.accent}1a 100%)`,
                    borderColor: bar.accent + '70',
                    color:       darkenHex(bar.accent),
                  }"
                >
                  <div v-if="bar.startsHere" class="bar-rh bar-rh-left" @mousedown.stop.prevent="startBarResize(bar, 'start', $event)"></div>
                  <template v-if="bar.startsHere || bar.colStart === 0">
                    <span class="bar-proj-tag">项目</span>
                    <span class="bar-status-dot" :class="'bsd-' + bar.status"></span>
                    <span class="bar-label">{{ bar.name }}</span>
                  </template>
                  <div v-if="bar.endsHere" class="bar-rh bar-rh-right" @mousedown.stop.prevent="startBarResize(bar, 'end', $event)"></div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 侧栏 -->
      <div class="cal-sidebar glass-card" ref="calSidebarRef">
        <div class="sidebar-top">
          <div class="sidebar-date-label">{{ selectedDateLabel }}</div>
          <button class="add-event-btn" ref="addBtnRef" @click="openAddForm">
            <PhPlus :size="13" weight="bold" />
            添加活动
          </button>
        </div>

        <div v-if="selectedEvents.length" class="sidebar-events">
          <div v-for="ev in selectedEvents" :key="ev.id" class="sidebar-ev"
               :style="{ cursor: ev.isProject || ev.isUserEvent ? 'pointer' : 'default' }"
               @click.left="ev.isProject ? openProject(ev) : (ev.isUserEvent && openEditForm(ev, $event))"
               @contextmenu.prevent="ev.isUserEvent && openEditForm(ev, $event)"
          >
            <div class="sidebar-ev-bar" :style="{ background: ev.accent }"></div>
            <div class="sidebar-ev-body">
              <div class="sidebar-ev-name" :style="ev.isProject ? { color: darkenHex(ev.accent) } : {}">
                <span v-if="!ev.isUserEvent" class="ev-type-badge ev-proj-badge" :style="{ color: darkenHex(ev.accent) }">项目</span>
                <span v-else class="ev-type-badge ev-event-badge">{{ typeLabel(ev.type) }}</span>
                {{ ev.name }}
              </div>
              <template v-if="ev.isUserEvent">
                <div class="sidebar-ev-desc">
                  <PhAlignLeft :size="11" weight="bold" style="flex-shrink:0;opacity:0.38;margin-top:1px" />
                  <span v-if="ev.description">{{ ev.description }}</span>
                </div>
              </template>
              <template v-else>
                <div class="sidebar-ev-desc">
                  {{ ev.startDate?.slice(5).replace('-','/') }} → {{ ev.endDate?.slice(5).replace('-','/') }}
                  <template v-if="ev.currentStage"> · {{ ev.currentStage }}</template>
                </div>
              </template>
            </div>
            <button v-if="ev.isUserEvent" class="ev-del-btn" @click.stop="deleteEvent(ev)" title="删除活动">
              <PhTrash :size="12" weight="bold" />
            </button>
          </div>
        </div>
        <div v-else class="sidebar-empty">
          <PhCalendarBlank :size="26" weight="bold" style="opacity:0.3" />
          <span>当天无日程</span>
        </div>

        <div class="sidebar-divider"></div>

        <div class="sidebar-section-title">近期节点</div>
        <div v-for="ev in upcomingList" :key="ev.id" class="upcoming-item cap-row"
             :class="{ 'upcoming-proj': ev.isProject, 'upcoming-ev': ev.isUserEvent }"
             :style="{ cursor: ev.isProject || ev.isUserEvent ? 'pointer' : 'default' }"
             @click.left="ev.isProject ? openProject(ev) : (ev.isUserEvent && openEditForm(ev, $event))"
             @contextmenu.prevent="ev.isUserEvent && openEditForm(ev, $event)"
        >
          <div class="cap-capsule"
               :style="{ '--cap-bg': capBg(ev.accent, ev.progress), borderColor: hexAlpha(ev.accent, 0.3) }">
            <span class="cap-tag" :class="ev.isProject ? 'cap-tag-proj' : 'cap-tag-ev'" :style="ev.isProject ? { color: darkenHex(ev.accent) } : {}">{{ ev.isProject ? '项目' : '活动' }}</span>
            <span v-if="ev.isProject" class="cap-sdot" :class="'cap-s-' + ev.status"></span>
            <span class="cap-name" :style="{ color: darkenHex(ev.accent) }">{{ ev.name }}</span>
            <span class="cap-days" :class="{ urgent: ev.daysLeft <= 3 }">{{ ev.daysLabel }}</span>
          </div>
        </div>
      </div>

    </div>
  </div>

  <!-- 统一"更多"弹窗（项目 + 事件合并） -->
  <Teleport to="body">
    <Transition name="picker">
      <div v-if="morePopup.open" class="overflow-popup" ref="morePopupRef" :style="morePopup.style">
        <div class="overflow-popup-title">{{ morePopup.dateLabel }}</div>
        <div class="overflow-list">
          <div
            v-for="item in morePopup.items" :key="item.id"
            class="overflow-item cal-chip"
            :class="{ 'overflow-clickable': item.isProject || item.isUserEvent }"
            :style="{ background: item.accent + '28', borderColor: item.accent + '70', color: darkenHex(item.accent), cursor: (item.isProject || item.isUserEvent) ? 'grab' : 'default' }"
            @click.stop="item.isProject ? (morePopup.open = false, showEditForm = false, openProject(item)) : (item.isUserEvent && openEditForm(item, $event, true))"
            @mousedown.stop="(item.isProject || item.isUserEvent) && startMoreItemDrag(item, $event)"
          >
            <span class="overflow-tag" :class="{ 'overflow-tag-ev': !item.isProject }">{{ item.isProject ? '项目' : '活动' }}</span>
            <span v-if="item.isProject" class="bar-status-dot" :class="'bsd-' + item.status"></span>
            <span class="overflow-name">{{ item.name }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 年月快速选择器 -->
  <Teleport to="body">
    <Transition name="picker">
      <div v-if="pickerOpen" class="cal-month-picker" ref="pickerRef" :style="pickerStyle">
        <div class="picker-year-row">
          <button class="picker-nav" @click.stop="pickerYear--">
            <PhCaretLeft :size="12" weight="bold" />
          </button>
          <span class="picker-year">{{ pickerYear }}</span>
          <button class="picker-nav" @click.stop="pickerYear++">
            <PhCaretRight :size="12" weight="bold" />
          </button>
        </div>
        <div class="picker-months">
          <button
            v-for="m in 12" :key="m"
            class="picker-month"
            :class="{ active: m - 1 === cursor.getMonth() && pickerYear === cursor.getFullYear() }"
            @click.stop="selectYearMonth(pickerYear, m - 1)"
          >{{ m }}月</button>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 添加事件弹窗 -->
  <Teleport to="body">
    <Transition name="form-pop">
      <div v-if="showAddForm" class="add-event-popup" ref="addFormRef" :style="addFormStyle">
        <div class="popup-header">
          <span class="popup-title">添加活动</span>
          <button class="popup-close-btn" @click="showAddForm = false" title="关闭">
            <PhX :size="12" weight="bold" />
          </button>
        </div>
        <input v-model="newEvent.name" class="popup-input" placeholder="活动名称" @keydown.enter="saveEvent" @keydown.esc="showAddForm = false" autofocus />
        <DatePicker v-model="newEvent.date" placeholder="选择日期" />
        <textarea v-model="newEvent.description" class="popup-textarea" placeholder="描述（可选）" rows="2"></textarea>
        <div class="popup-actions">
          <button class="popup-save" @click="saveEvent" :disabled="!newEvent.name">保存</button>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- 编辑事件弹窗 -->
  <Teleport to="body">
    <Transition name="form-pop">
      <div v-if="showEditForm && editingEvent" class="add-event-popup" ref="editFormRef" :style="editFormStyle">
        <div class="popup-header">
          <span class="popup-title">编辑活动</span>
          <button class="popup-close-btn" @click="showEditForm = false" title="关闭">
            <PhX :size="12" weight="bold" />
          </button>
        </div>
        <input v-model="editingEvent.name" class="popup-input" placeholder="活动名称" @keydown.enter="saveEditEvent" @keydown.esc="showEditForm = false" autofocus />
        <DatePicker v-model="editingEvent.date" placeholder="选择日期" />
        <textarea v-model="editingEvent.description" class="popup-textarea" placeholder="描述（可选）" rows="2"></textarea>
        <div class="popup-actions">
          <button class="popup-save" @click="saveEditEvent" :disabled="!editingEvent.name">保存</button>
          <button class="popup-delete" @click="deleteEventFromEdit">删除</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script>
const eventsCache = {}
const upcomingEventsCache = { data: null }
</script>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useProjectStore } from '@/stores/projects'
import { eventsApi } from '@/services/api'
import DatePicker from '@/components/common/DatePicker.vue'
import { useHolidays } from '@/composables/useHolidays'
import { PhCaretLeft, PhCaretRight, PhCaretDown, PhPlus, PhAlignLeft, PhTrash, PhCalendarBlank, PhX } from '@phosphor-icons/vue'

const projectStore = useProjectStore()
const todayIso = ref(toIso(new Date()))

let _midnightTimer = null
function scheduleMidnightTick() {
  const now = new Date()
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now
  _midnightTimer = setTimeout(() => {
    todayIso.value = toIso(new Date())
    scheduleMidnightTick()
  }, msUntilMidnight)
}

const cursor       = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
const selectedDate = ref(todayIso.value)

const { fetchYear, getHolidayType } = useHolidays()
const hdayCache = ref({})

async function loadHolidays() {
  const y = cursor.value.getFullYear()
  const years = [y]
  if (cursor.value.getMonth() === 11) years.push(y + 1)
  for (const yr of years) {
    if (!hdayCache.value[yr]) {
      const data = await fetchYear(yr)
      hdayCache.value = { ...hdayCache.value, [yr]: data }
    }
  }
}

function hdayType(isoDate) {
  if (!isoDate) return null
  const yr = +isoDate.slice(0, 4)
  return getHolidayType(hdayCache.value[yr], isoDate)
}
const showAddForm  = ref(false)
const newEvent     = ref({ name: '', date: todayIso.value, description: '' })
const addBtnRef    = ref(null)
const addFormRef   = ref(null)
const addFormStyle = ref({})

const showEditForm  = ref(false)
const editingEvent  = ref(null)
const editFormRef   = ref(null)
const editFormStyle = ref({})
const calSidebarRef = ref(null)

// ── 拖拽状态 ─────────────────────────────────────────────────────────────────
const drag = reactive({
  active:     false,
  type:       null,   // 'event' | 'proj-chip' | 'proj-bar' | 'proj-resize-start' | 'proj-resize-end'
  item:       null,
  offsetDays: 0,      // proj-bar: days from startDate to where drag started
})
const hoveredBarId  = ref(null)
const hoveredDateIso = ref(null)

function onWeekMouseMove(e, week) {
  const rect = e.currentTarget.getBoundingClientRect()
  const col  = Math.floor((e.clientX - rect.left) / rect.width * 7)
  hoveredDateIso.value = week[Math.max(0, Math.min(6, col))]?.iso ?? null
}

const dragOverIso = ref(null)

const dragOverRange = computed(() => {
  if (!drag.active || !dragOverIso.value) return null
  const iso = dragOverIso.value
  if (drag.type === 'event') return { start: iso, end: iso }
  if (drag.type === 'proj-chip') return { start: iso, end: iso }
  if (drag.type === 'proj-bar') {
    const newStart = addDays(iso, -drag.offsetDays)
    const dur      = daysBetween(drag.item.startDate, drag.item.endDate)
    return { start: newStart, end: addDays(newStart, dur) }
  }
  if (drag.type === 'proj-resize-start') {
    if (iso > drag.item.endDate) return null
    return { start: iso, end: drag.item.endDate }
  }
  if (drag.type === 'proj-resize-end') {
    if (iso < drag.item.startDate) return null
    return { start: drag.item.startDate, end: iso }
  }
  return null
})

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return toIso(d)
}
function barSegFill(bar) {
  if (!bar.progress) return 0
  const total = daysBetween(bar.startDate, bar.endDate)
  if (total <= 0) return bar.progress
  const progressDays  = total * bar.progress / 100
  const segStartOff   = daysBetween(bar.startDate, bar.segStartIso)
  const segEndOff     = daysBetween(bar.startDate, bar.segEndIso) + 1
  if (progressDays <= segStartOff) return 0
  if (progressDays >= segEndOff)   return 100
  return Math.round((progressDays - segStartOff) / (segEndOff - segStartOff) * 100)
}

function daysBetween(isoA, isoB) {
  return Math.round((new Date(isoB + 'T00:00:00') - new Date(isoA + 'T00:00:00')) / 86400000)
}
function isoFromPoint(x, y) {
  // elementsFromPoint won't reach month-cell behind bars-layer; use grid bounds instead
  for (let wi = 0; wi < monthWeeks.value.length; wi++) {
    const el = weekRowElMap[wi]
    if (!el) continue
    const rect = el.getBoundingClientRect()
    if (y >= rect.top && y < rect.bottom && x >= rect.left && x < rect.right) {
      const col = Math.min(6, Math.max(0, Math.floor((x - rect.left) / (rect.width / 7))))
      return monthWeeks.value[wi]?.[col]?.iso ?? null
    }
  }
  return null
}
function isInDragRange(iso) {
  const r = dragOverRange.value
  return r ? iso >= r.start && iso <= r.end : false
}

function startDrag(type, item, e, offsetDays = 0, onActivate = null) {
  const startX = e.clientX
  const startY = e.clientY
  let activated = false

  const mm = (ev) => {
    if (!activated) {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (Math.sqrt(dx * dx + dy * dy) < 5) return
      activated = true
      drag.active     = true
      drag.type       = type
      drag.item       = item
      drag.offsetDays = offsetDays
      document.body.style.cursor     = 'grabbing'
      document.body.style.userSelect = 'none'
      onActivate?.()
    }
    dragOverIso.value = isoFromPoint(ev.clientX, ev.clientY)
  }

  const mu = (ev) => {
    document.removeEventListener('mousemove', mm)
    document.removeEventListener('mouseup', mu)
    if (activated) {
      dragOverIso.value = isoFromPoint(ev.clientX, ev.clientY)
      commitDrag()
      // suppress the click that fires after mouseup so it doesn't trigger open/select
      document.addEventListener('click', (ce) => ce.stopPropagation(), { capture: true, once: true })
      setTimeout(() => {
        drag.active = false
        drag.type   = null
        drag.item   = null
        dragOverIso.value = null
      }, 30)
    }
    document.body.style.cursor     = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', mm)
  document.addEventListener('mouseup', mu)
}

function startEventDrag(ev, e)              { startDrag('event', ev, e) }
function startProjChipDrag(bar, e)          { startDrag('proj-chip', bar, e) }
function startMoreItemDrag(item, e) {
  const closePopup = () => { morePopup.value.open = false }
  if (item.isProject) startDrag('proj-chip', item, e, 0, closePopup)
  else if (item.isUserEvent) startDrag('event', item, e, 0, closePopup)
}
function startBarDrag(bar, e) {
  const anchorIso = isoFromPoint(e.clientX, e.clientY) ?? bar.startDate
  startDrag('proj-bar', bar, e, daysBetween(bar.startDate, anchorIso))
}
function startBarResize(bar, edge, e) {
  startDrag(edge === 'start' ? 'proj-resize-start' : 'proj-resize-end', bar, e)
}

async function commitDrag() {
  const range = dragOverRange.value
  if (!range) return

  if (drag.type === 'event') {
    const ev = drag.item
    if (ev.date === range.start) return
    const patch = (list) => {
      const idx = list.findIndex(e => e.id === ev.id)
      if (idx !== -1) list[idx] = { ...list[idx], date: range.start }
    }
    patch(extraEvents.value)
    patch(nextMonthEvents.value)
    buildUpcomingList()
    eventsCache[`${cursor.value.getFullYear()}-${cursor.value.getMonth() + 1}`] = [...extraEvents.value]
    try { await eventsApi.update(ev.id, { title: ev.name, date: range.start, description: ev.description || undefined }) } catch {}
  }

  if (['proj-chip', 'proj-bar', 'proj-resize-start', 'proj-resize-end'].includes(drag.type)) {
    const projId = Number(String(drag.item.id).replace(/^p/, ''))
    const proj   = projectStore.projects.find(p => p.id === projId)
    if (!proj) return
    if (range.start === drag.item.startDate && range.end === drag.item.endDate) return
    try { await projectStore.updateProject(projId, { startDate: range.start, deadline: range.end }) } catch {}
  }
}

// ── 年月选择器 ──
const pickerOpen      = ref(false)
const pickerYear      = ref(new Date().getFullYear())
const pickerAnchorRef = ref(null)
const pickerRef       = ref(null)
const pickerStyle     = ref({})

const morePopup    = ref({ open: false, items: [], dateLabel: '', style: {} })
const morePopupRef = ref(null)

// ── 动态行高测量 ──
const BAR_H    = 20  // 每条 bar / chip 的行高（slot 高，含间距）
const HEADER_H = 32  // bars-layer 第一条 bar 的 top：cell-num 底部(31) + 1px 间距
const CELL_TOP = 31  // cell-chips 起点：cell padding-top(7) + cell-num(24)
const BOTTOM_PAD = 8 // 底部安全留白（px）：cell padding-bottom(4) + 4px 视觉安全区

const weekHeights = ref({})   // { [weekIndex]: heightInPx }
const weekRowElMap = {}       // 原生 el 引用，不需要响应式

function setWeekRef(el, wi) {
  if (el) weekRowElMap[wi] = el
  else    delete weekRowElMap[wi]
}

let ro = null
function setupRO() {
  if (ro) ro.disconnect()
  ro = new ResizeObserver(entries => {
    const next = { ...weekHeights.value }
    entries.forEach(e => {
      const wi = parseInt(e.target.dataset.wi)
      if (!isNaN(wi)) next[wi] = e.contentRect.height
    })
    weekHeights.value = next
  })
  Object.entries(weekRowElMap).forEach(([wi, el]) => {
    if (el) ro.observe(el)
  })
}

// 某一行最多能放几个条目（项目条 + 更多按钮 + chip 共用这个池）
function maxSlots(wi) {
  const h = weekHeights.value[wi] ?? 90
  return Math.max(1, Math.floor((h - HEADER_H - BOTTOM_PAD) / BAR_H))
}

// ── 核心布局计算 ──

// weekBars 结果按周缓存，避免贪心算法在同一渲染周期内重复执行
const _weekBarsCache = new Map()
function weekBarsCached(week) {
  const key = week[0].iso
  if (!_weekBarsCache.has(key)) _weekBarsCache.set(key, weekBars(week))
  return _weekBarsCache.get(key)
}
// projectTimelines 变化时清缓存（watch 在 script setup 末尾注册）

function weekBarsCapped(week, wi) {
  const all = weekBarsCached(week)
  const max = maxSlots(wi)
  return {
    bars: all.filter(b => b.row < max),
    all,
  }
}

/**
 * 统一的格子布局：一次调用完成所有计算，返回 paddingTop、可见 chips、更多信息。
 * 消除模板中 dayLayout + nextAvailableRow 的重复 weekBars 调用。
 */
function dayLayout(iso, week, wi) {
  const { bars: cappedBars, all } = weekBarsCapped(week, wi)

  // chip 起始行 = 覆盖该天的可见 bar 中最大 row + 1
  let maxBarRow = -1
  cappedBars.forEach(b => {
    if (b.startDate <= iso && b.endDate >= iso) maxBarRow = Math.max(maxBarRow, b.row)
  })
  const nextRow  = maxBarRow + 1
  const paddingTop = Math.max(0, nextRow * BAR_H + HEADER_H - CELL_TOP)
  const slots    = Math.max(0, maxSlots(wi) - nextRow)

  // 当天被隐藏的项目（row >= max）
  const cappedIds = new Set(cappedBars.map(b => b.id))
  const hiddenProjects = all
    .filter(b => b.startDate <= iso && b.endDate >= iso && !cappedIds.has(b.id))
    .map(b => ({ ...b, isProject: true }))

  // 单日项目（startDate === endDate）不进 bars-layer，在此当 chip 显示
  const singleDayProjects = effectiveProjectTimelines.value
    .filter(p => p.startDate === p.endDate && p.startDate === iso)
    .map(p => ({ ...p, isProject: true }))
  const allChips = [...singleDayProjects, ...effectiveExtraEvents.value.filter(e => e.date === iso)]
  const hasMore  = hiddenProjects.length > 0 || allChips.length > slots

  if (!hasMore) {
    return { paddingTop, visibleChips: allChips, moreCount: 0, moreItems: [] }
  }
  const chipLimit    = Math.max(0, slots - 1)
  const visibleChips = allChips.slice(0, chipLimit)
  const hiddenChips  = allChips.slice(chipLimit)
  const moreItems    = [...hiddenProjects, ...hiddenChips]
  return { paddingTop, visibleChips, moreCount: moreItems.length, moreItems }
}

// ── 统一"更多"弹窗 ──
function showMore(e, iso, items) {
  const d     = new Date(iso + 'T00:00:00')
  const label = `${d.getMonth()+1}月${d.getDate()}日`
  const w     = 230
  const left  = Math.max(8, Math.min(e.clientX - w / 2, window.innerWidth - w - 8))
  const top   = Math.min(e.clientY + 8, window.innerHeight - 220)
  morePopup.value = {
    open: true, items, dateLabel: label,
    style: { position: 'fixed', top: top + 'px', left: left + 'px', width: w + 'px', zIndex: 2000 },
  }
}

function togglePicker() {
  if (pickerOpen.value) { pickerOpen.value = false; return }
  pickerYear.value = cursor.value.getFullYear()
  pickerOpen.value = true
  nextTick(() => {
    const rect = pickerAnchorRef.value?.getBoundingClientRect()
    if (!rect) return
    const w = 220
    let left = rect.left + rect.width / 2 - w / 2
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    pickerStyle.value = { position: 'fixed', top: rect.bottom + 6 + 'px', left: left + 'px', width: w + 'px', zIndex: 2000 }
  })
}

function selectYearMonth(y, m) {
  cursor.value = new Date(y, m, 1)
  pickerOpen.value = false
}

const weekdays = ['一', '二', '三', '四', '五', '六', '日']

function toIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function extractAccent(colorStr) {
  const m = colorStr?.match(/#[0-9a-fA-F]{6}/)
  return m ? m[0] : '#7b7fb2'
}
function capBg(hex, progress) {
  const base = hexAlpha(hex, 0.1)
  if (!progress) return base
  const fill = hexAlpha(hex, 0.32)
  return `linear-gradient(to right, ${fill} 0%, ${fill} ${progress}%, ${base} ${progress}%, ${base} 100%)`
}

function hexAlpha(hex, a) {
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `rgba(${r},${g},${b},${a})`
}
function darkenHex(hex, amount = 0.60) {
  const r = Math.round(parseInt(hex.slice(1,3),16) * amount)
  const g = Math.round(parseInt(hex.slice(3,5),16) * amount)
  const b = Math.round(parseInt(hex.slice(5,7),16) * amount)
  return `rgb(${r},${g},${b})`
}
function typeLabel(t) {
  return { deadline: '截止日', meeting: '会议', review: '审核', milestone: '节点', project: '进行中' }[t] ?? '活动'
}

const TYPE_ACCENT = {
  meeting:   '#7b7fb2',
  review:    '#7ab8c8',
  milestone: '#c4afc8',
  deadline:  '#b07858',
  event:     '#8a8fa8',
}

function normalizeEvent(e) {
  return {
    id:          e.id,
    date:        e.date,
    name:        e.title,
    client:      e.client ?? '',
    type:        e.type,
    accent:      TYPE_ACCENT[e.type] ?? '#8a8fa8',
    isUserEvent: true,
    description: e.description ?? '',
  }
}

const extraEvents     = ref([])
const nextMonthEvents = ref([])

async function fetchNextMonthEvents() {
  const now = new Date()
  const m   = now.getMonth() + 1
  const nm  = m === 12 ? 1 : m + 1
  const ny  = m === 12 ? now.getFullYear() + 1 : now.getFullYear()
  const key = `${ny}-${nm}`
  if (eventsCache[key]) { nextMonthEvents.value = eventsCache[key]; return }
  try {
    const data       = await eventsApi.list(ny, nm)
    const normalized = data.map(normalizeEvent)
    eventsCache[key] = normalized
    nextMonthEvents.value = normalized
  } catch { }
}

async function fetchEvents() {
  const y   = cursor.value.getFullYear()
  const m   = cursor.value.getMonth() + 1
  const key = `${y}-${m}`
  if (eventsCache[key]) extraEvents.value = eventsCache[key]
  try {
    const data       = await eventsApi.list(y, m)
    const normalized = data.map(normalizeEvent)
    eventsCache[key] = normalized
    extraEvents.value = normalized
  } catch { }
}

function singleEvents(iso) { return extraEvents.value.filter(e => e.date === iso) }

function openProject(bar) {
  const pid = Number(bar.id.replace(/^p/, ''))
  const proj = projectStore.projects.find(p => p.id === pid)
  if (proj) projectStore.openModal(proj)
}

const projectTimelines = computed(() =>
  projectStore.projects
    .filter(p => p.startDate && p.deadline)
    .map(p => ({
      id:           `p${p.id}`,
      name:         p.name,
      client:       p.client,
      startDate:    p.startDate,
      endDate:      p.deadline,
      accent:       extractAccent(p.color),
      type:         'deadline',
      isProject:    true,
      status:       p.status,
      currentStage: p.stages?.find(s => s.key === p.currentStage)?.label ?? null,
      progress:     (() => {
        const stages = p.stages ?? []
        if (!stages.length) return 0
        const idx = stages.findIndex(s => s.key === p.currentStage)
        return idx < 0 ? 0 : Math.round((idx + 1) / stages.length * 100)
      })(),
    }))
)

const effectiveProjectTimelines = computed(() => {
  const range = dragOverRange.value
  if (!drag.active || !range || !drag.item) return projectTimelines.value
  if (!['proj-bar', 'proj-resize-start', 'proj-resize-end', 'proj-chip'].includes(drag.type)) return projectTimelines.value
  const dragId = drag.item.id
  return projectTimelines.value.map(p =>
    p.id === dragId ? { ...p, startDate: range.start, endDate: range.end } : p
  )
})

const effectiveExtraEvents = computed(() => {
  const range = dragOverRange.value
  if (!drag.active || drag.type !== 'event' || !range || !drag.item) return extraEvents.value
  const evId = drag.item.id
  return extraEvents.value.map(e =>
    e.id === evId ? { ...e, date: range.start } : e
  )
})

const monthDays = computed(() => {
  const y = cursor.value.getFullYear()
  const m = cursor.value.getMonth()
  const first    = new Date(y, m, 1)
  const last     = new Date(y, m + 1, 0)
  const startDow = (first.getDay() + 6) % 7
  const days     = []
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(y, m, -i)
    days.push({ key: `p${i}`, date: d.getDate(), iso: toIso(d), other: true, isToday: false, dow: (d.getDay()+6)%7 })
  }
  for (let i = 1; i <= last.getDate(); i++) {
    const d   = new Date(y, m, i)
    const iso = toIso(d)
    days.push({ key: iso, date: i, iso, other: false, isToday: iso === todayIso.value, dow: (d.getDay()+6)%7 })
  }
  const rem = 7 - (days.length % 7)
  if (rem < 7) for (let i = 1; i <= rem; i++) {
    const d = new Date(y, m + 1, i)
    days.push({ key: `n${i}`, date: i, iso: toIso(d), other: true, isToday: false, dow: (d.getDay()+6)%7 })
  }
  return days
})

const monthWeeks = computed(() => {
  const w = []
  for (let i = 0; i < monthDays.value.length; i += 7) w.push(monthDays.value.slice(i, i+7))
  return w
})

function weekBars(week) {
  const ws = week[0].iso
  const we = week[6].iso
  const bars = effectiveProjectTimelines.value
    .filter(p => p.endDate >= ws && p.startDate <= we && p.startDate !== p.endDate)
    .map(p => {
      const colStart = p.startDate <= ws ? 0 : week.findIndex(d => d.iso >= p.startDate)
      let colEnd = 6
      for (let i = 6; i >= 0; i--) { if (week[i].iso <= p.endDate) { colEnd = i; break } }
      const cs = Math.max(0, colStart)
      const ce = Math.min(6, colEnd)
      return {
        ...p,
        colStart: cs,
        colEnd:   ce,
        startsHere:   p.startDate >= ws && p.startDate <= we,
        endsHere:     p.endDate   >= ws && p.endDate   <= we,
        segStartIso:  week[cs].iso,
        segEndIso:    week[ce].iso,
      }
    })

  // 贪心区间着色：按开始列排序，分配最小可用行（不重叠的 bar 共享同一行）
  bars.sort((a, b) => a.colStart - b.colStart || (b.colEnd - b.colStart) - (a.colEnd - a.colStart))
  const rowEnds = []  // rowEnds[r] = 该行最后一条 bar 的 colEnd
  bars.forEach(bar => {
    let r = 0
    while (rowEnds[r] !== undefined && rowEnds[r] >= bar.colStart) r++
    bar.row = r
    rowEnds[r] = bar.colEnd
  })

  return bars
}

const periodLabel = computed(() => {
  const c = cursor.value
  return c.getFullYear() + '年 ' + (c.getMonth()+1) + '月'
})

function prev() { const d = new Date(cursor.value); d.setMonth(d.getMonth()-1); cursor.value = d }
function next() { const d = new Date(cursor.value); d.setMonth(d.getMonth()+1); cursor.value = d }
function goToday() {
  const now = new Date()
  cursor.value = new Date(now.getFullYear(), now.getMonth(), 1)
  selectedDate.value = todayIso.value
}

const selectedDateLabel = computed(() => {
  if (!selectedDate.value) return ''
  const d = new Date(selectedDate.value + 'T00:00:00')
  const cn = ['日','一','二','三','四','五','六']
  return (d.getMonth()+1) + '月' + d.getDate() + '日 · 周' + cn[d.getDay()]
})

const selectedEvents = computed(() => {
  const sel = selectedDate.value
  const chips = singleEvents(sel)
  const activeProjects = projectTimelines.value
    .filter(p => p.startDate <= sel && p.endDate >= sel)
    .map(p => ({ ...p, type: p.endDate === sel ? 'deadline' : 'project' }))
  return [...activeProjects, ...chips]
})

const upcomingList = ref([])

function buildUpcomingList() {
  const now         = new Date()
  const todayStr    = toIso(now)
  const cutoff      = toIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 15))
  const midnight    = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  function label(iso) {
    const d = Math.round((new Date(iso + 'T00:00:00') - midnight) / 86400000)
    return { daysLeft: d, daysLabel: d === 0 ? '今天' : d === 1 ? '明天' : d + '天后' }
  }

  // 项目截止（15天内，非已完成）
  const projects = projectTimelines.value
    .filter(p => p.endDate >= todayStr && p.endDate <= cutoff && p.status !== 'done')
    .sort((a, b) => a.endDate.localeCompare(b.endDate))
    .slice(0, 4)
    .map(p => ({ ...p, date: p.endDate, ...label(p.endDate) }))

  // 日历事件（当月 + 下月，15天内）
  const seen = new Set()
  const events = [...extraEvents.value, ...nextMonthEvents.value]
    .filter(ev => {
      if (seen.has(ev.id)) return false
      seen.add(ev.id)
      return ev.date >= todayStr && ev.date <= cutoff
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4)
    .map(ev => ({ ...ev, ...label(ev.date) }))

  upcomingList.value = [...projects, ...events]
}

watch([projectTimelines, extraEvents, nextMonthEvents], buildUpcomingList, { immediate: true })

function openAddForm() {
  newEvent.value = { name: '', date: selectedDate.value || todayIso.value, description: '' }
  const btnEl = addBtnRef.value
  if (btnEl) {
    const btnRect    = btnEl.getBoundingClientRect()
    const popupWidth = 240
    const sbEl   = btnEl.closest('.cal-sidebar') ?? calSidebarRef.value
    const sbRect = sbEl?.getBoundingClientRect()
    const centerX = sbRect
      ? sbRect.left + sbRect.width / 2
      : btnRect.right - popupWidth / 2
    const left = Math.max(8, Math.min(centerX - popupWidth / 2, window.innerWidth - popupWidth - 8))
    addFormStyle.value = {
      position: 'fixed',
      top:   btnRect.bottom + 8 + 'px',
      left:  left + 'px',
      width: popupWidth + 'px',
      zIndex: 1000,
    }
  }
  showAddForm.value = true
}

function openEditForm(ev, nativeEv, useMousePos = false) {
  showAddForm.value = false
  editingEvent.value = { id: ev.id, name: ev.name, date: ev.date, description: ev.description || '' }
  const w = 240
  let left, top
  if (useMousePos) {
    left = Math.max(8, Math.min(nativeEv.clientX - w / 2, window.innerWidth - w - 8))
    top  = Math.min(nativeEv.clientY + 8, window.innerHeight - 220)
  } else {
    const el    = nativeEv.currentTarget ?? nativeEv.target
    const rect  = el.getBoundingClientRect()
    const sbEl  = el.closest('.cal-sidebar') ?? calSidebarRef.value
    const sbRect = sbEl?.getBoundingClientRect()
    const centerX = sbRect ? sbRect.left + sbRect.width / 2 : rect.left + rect.width / 2
    left = Math.max(8, Math.min(centerX - w / 2, window.innerWidth - w - 8))
    top  = rect.bottom + 6
  }
  editFormStyle.value = { position: 'fixed', top: top + 'px', left: left + 'px', width: w + 'px', zIndex: 2100 }
  showEditForm.value = true
}

async function saveEditEvent() {
  const ev = editingEvent.value
  if (!ev?.name) return
  showEditForm.value = false

  // 更新本地列表
  const update = (list) => {
    const idx = list.findIndex(e => e.id === ev.id)
    if (idx !== -1) {
      list[idx] = { ...list[idx], name: ev.name, date: ev.date, description: ev.description }
    }
  }
  update(extraEvents.value)
  update(nextMonthEvents.value)
  buildUpcomingList()
  const cacheKey = `${cursor.value.getFullYear()}-${cursor.value.getMonth() + 1}`
  eventsCache[cacheKey] = [...extraEvents.value]

  try {
    await eventsApi.update(ev.id, { title: ev.name, date: ev.date, description: ev.description || undefined })
  } catch { }
}

function handleClickOutside(e) {
  if (e.target.closest('.dp-popup')) return
  if (showAddForm.value) {
    if (!addBtnRef.value?.contains(e.target) && !addFormRef.value?.contains(e.target))
      showAddForm.value = false
  }
  if (showEditForm.value) {
    if (!editFormRef.value?.contains(e.target) && !morePopupRef.value?.contains(e.target))
      showEditForm.value = false
  }
  if (pickerOpen.value) {
    if (!pickerAnchorRef.value?.contains(e.target) && !pickerRef.value?.contains(e.target))
      pickerOpen.value = false
  }
  if (morePopup.value.open) {
    if (!morePopupRef.value?.contains(e.target) && !editFormRef.value?.contains(e.target))
      morePopup.value.open = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside, true)
  fetchEvents()
  fetchNextMonthEvents()
  nextTick(setupRO)
  scheduleMidnightTick()
  loadHolidays()
})
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside, true)
  ro?.disconnect()
  clearTimeout(_midnightTimer)
})

watch(cursor, () => { fetchEvents(); loadHolidays() })
watch(monthWeeks, () => nextTick(setupRO))
watch([projectTimelines, dragOverRange], () => _weekBarsCache.clear())

async function deleteEvent(ev) {
  extraEvents.value     = extraEvents.value.filter(e => e.id !== ev.id)
  nextMonthEvents.value = nextMonthEvents.value.filter(e => e.id !== ev.id)
  buildUpcomingList()
  const key = `${cursor.value.getFullYear()}-${cursor.value.getMonth() + 1}`
  eventsCache[key] = extraEvents.value
  try { await eventsApi.delete(ev.id) } catch { }
}

async function deleteEventFromEdit() {
  const ev = editingEvent.value
  if (!ev) return
  showEditForm.value = false
  await deleteEvent(ev)
}

async function saveEvent() {
  if (!newEvent.value.name) return
  const date = newEvent.value.date || selectedDate.value
  const localItem = {
    id:          'u' + Date.now(),
    date,
    name:        newEvent.value.name,
    client:      '',
    type:        'event',
    accent:      '#7b7fb2',
    isUserEvent: true,
    description: newEvent.value.description || '',
  }
  extraEvents.value.push(localItem)
  selectedDate.value = date
  newEvent.value = { name: '', date: todayIso.value, description: '' }
  showAddForm.value = false

  const cacheKey = `${cursor.value.getFullYear()}-${cursor.value.getMonth() + 1}`
  try {
    const created = await eventsApi.create({ title: localItem.name, date, type: 'event', description: localItem.description || undefined })
    const norm = normalizeEvent(created)
    const idx = extraEvents.value.findIndex(e => e.id === localItem.id)
    if (idx !== -1) extraEvents.value[idx] = norm
  } catch { }
  eventsCache[cacheKey] = [...extraEvents.value]
}
</script>

<style scoped>
.cal-page { display: flex; flex-direction: column; gap: 14px; height: 100%; }
.cal-toolbar { display: flex; align-items: center; justify-content: space-between; height: 52px; box-sizing: border-box; padding: 0 18px; flex-shrink: 0; }
.toolbar-left { display: flex; align-items: center; gap: 4px; }
.nav-btn { width: 30px; height: 30px; border-radius: 8px; border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); transition: background 0.15s; }
.nav-btn:hover { background: rgba(0,0,0,0.06); }
.period-btn {
  display: flex; align-items: center; gap: 5px;
  font-size: 15px; font-weight: 700; color: var(--text-primary);
  min-width: 130px; justify-content: center;
  padding: 4px 10px; border-radius: 9px; border: none; background: none;
  cursor: pointer; font-family: var(--font-sans);
  transition: background 0.15s;
}
.period-btn:hover { background: rgba(0,0,0,0.06); }
.today-btn { padding: 5px 14px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.1); background: rgba(255,255,255,0.56); font-size: 12px; font-weight: 600; cursor: pointer; color: var(--text-secondary); font-family: var(--font-sans); transition: all 0.15s; }
.today-btn:hover { background: rgba(255,255,255,0.82); color: var(--text-primary); }

.cal-layout { display: grid; grid-template-columns: 1fr 260px; gap: 14px; flex: 1; min-height: 0; }
.cal-main { padding: 16px 16px 8px; display: flex; flex-direction: column; overflow: hidden; }
.weekday-row { display: grid; grid-template-columns: repeat(7, 1fr); flex-shrink: 0; margin-bottom: 2px; }
.weekday-hdr { text-align: center; font-size: 11px; font-weight: 600; color: var(--text-secondary); padding: 3px 0 8px; border-right: 1px solid rgba(123,127,178,0.15); }
.weekday-hdr:last-child { border-right: none; }
.weekday-hdr.weekend { color: rgba(195,90,90,0.85); }

.month-body { flex: 1; display: flex; flex-direction: column; border-top: 1px solid rgba(123,127,178,0.15); overflow: hidden; }

.week-row {
  flex: 1;
  display: grid; grid-template-columns: repeat(7, 1fr);
  position: relative;
  border-bottom: 1px solid rgba(123,127,178,0.15);
  min-height: 80px;
  overflow: hidden;
}
.week-row:last-child { border-bottom: none; }

.month-cell {
  padding: 7px 6px 4px;
  border-right: 1px solid rgba(123,127,178,0.15);
  cursor: pointer; transition: background 0.12s;
  overflow: hidden;
}
.month-cell:last-child { border-right: none; }
.month-cell.cell-hovered { background: rgba(123,127,178,0.06); }
.month-cell.other-month { opacity: 0.3; }
.month-cell.is-weekend { background: rgba(195,90,90,0.028); }
.month-cell.is-weekend.cell-hovered { background: rgba(195,90,90,0.07); }
.month-cell.is-today .cell-num { background: linear-gradient(135deg,#7b7fb2,#9590c4); color: rgba(255,255,255,0.88) !important; font-weight: 700; border-radius: 6px; }
.month-cell.is-selected { background: rgba(123,127,178,0.1); }
.month-cell.is-selected.is-weekend { background: rgba(195,90,90,0.1); }
.month-cell.is-selected:not(.is-today) .cell-num { background: rgba(123,127,178,0.15); color: var(--color-primary); font-weight: 700; border-radius: 6px; }
.month-cell.is-selected:not(.is-today).is-weekend .cell-num { background: rgba(195,90,90,0.15); color: rgba(195,90,90,0.9); }
.month-cell.is-selected:not(.is-today).is-workday .cell-num { color: var(--color-primary); }

.cell-head { display: flex; align-items: center; gap: 3px; height: 24px; }
.cell-num { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; color: var(--text-primary); flex-shrink: 0; transition: all 0.15s; }
.hday-badge { font-size: 9px; font-weight: 700; line-height: 1; padding: 2px 3px; border-radius: 3px; flex-shrink: 0; }
.hday-holiday { background: rgba(210,75,75,0.1); color: rgba(210,75,75,0.82); }
.hday-workday { background: rgba(210,130,20,0.14); color: rgba(170,100,5,0.9); }
.month-cell.is-holiday .cell-num { color: rgba(210,75,75,0.82); }
.month-cell.is-workday.is-weekend .cell-num { color: var(--text-primary); }

/* chip 区域：paddingTop 由 JS 动态设置，推到 bar 下方 */
.cell-chips { display: flex; flex-direction: column; gap: 2px; }

.event-chip {
  height: 18px; box-sizing: border-box;
  font-size: 10px; font-weight: 500;
  padding: 0 7px; border-radius: 99px; border: 1px solid transparent;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  display: flex; align-items: center;
}
.event-chip.chip-proj,
.event-chip.chip-ev-click { cursor: grab; }
.chip-more-btn {
  height: 16px; box-sizing: border-box;
  font-size: 10px; font-weight: 500;
  padding: 0 7px; border-radius: 99px;
  border: 1px solid rgba(123,127,178,0.35);
  background: rgba(123,127,178,0.1); color: rgb(101,104,146);
  cursor: pointer; font-family: var(--font-sans);
  white-space: nowrap;
  display: flex; align-items: center;
}

/* 项目条层 */
.bars-layer { position: absolute; inset: 0; pointer-events: none; }
/* bars-layer is pointer-events:none so date-cell clicks work; individual bars opt back in */

.project-bar {
  position: absolute; height: 16px;
  border: 1px solid transparent;
  display: flex; align-items: center;
  padding: 0 6px; font-size: 10px; font-weight: 500;
  white-space: nowrap; overflow: hidden; box-sizing: border-box;
  pointer-events: auto; cursor: grab;
}
.project-bar.bar-dragging { opacity: 0.6; }
.project-bar.bar-start  { border-radius: 99px 0 0 99px; padding-left: 8px; }
.project-bar.bar-end    { border-radius: 0 99px 99px 0; }
.project-bar.bar-start.bar-end { border-radius: 99px; }

/* resize handles */
.bar-rh {
  position: absolute; top: 0; bottom: 0; width: 8px;
  cursor: ew-resize; display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity 0.15s; z-index: 1;
}
.bar-rh::after {
  content: ''; width: 2px; height: 8px; border-radius: 2px;
  background: currentColor; opacity: 0.7;
}
.bar-rh-left  { left: 0; }
.bar-rh-right { right: 0; }
.project-bar.bar-hovered .bar-rh { opacity: 1; }

.bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }

.bar-proj-tag {
  flex-shrink: 0;
  font-size: 8px; font-weight: 700; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.5);
  border-radius: 3px; padding: 0 3px; line-height: 11px;
  margin-right: 2px;
}
.bar-status-dot {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-right: 4px;
}
.bsd-pending { background: #d46b6b; }
.bsd-active  { background: #c9943a; }
.bsd-done    { background: #5a9e88; }
.chip-proj-tag {
  flex-shrink: 0;
  font-size: 8px; font-weight: 700; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.55);
  border-radius: 3px; padding: 0 3px; line-height: 11px;
  margin-right: 4px;
}
.chip-ev-tag {
  background: rgba(210,175,40,0.28); color: #7a5c00;
}



/* 侧栏 */
.cal-sidebar { padding: 16px; display: flex; flex-direction: column; gap: 0; overflow-y: auto; min-height: 0; scrollbar-gutter: stable; }
.sidebar-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.sidebar-date-label { font-size: 13px; font-weight: 700; color: var(--text-primary); }
.add-event-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 8px; border: 1px solid rgba(123,127,178,0.3); background: rgba(123,127,178,0.08); font-size: 11px; font-weight: 600; cursor: pointer; color: var(--color-primary); font-family: var(--font-sans); transition: all 0.15s; }
.add-event-btn:hover { background: rgba(123,127,178,0.15); border-color: rgba(123,127,178,0.5); }
.sidebar-events { display: flex; flex-direction: column; gap: 7px; margin-bottom: 4px; }
.sidebar-ev { display: flex; gap: 9px; align-items: flex-start; background: rgba(255,255,255,0.66); border: 1px solid rgba(255,255,255,0.88); border-radius: 10px; padding: 8px 10px; }
.sidebar-ev-body { flex: 1; min-width: 0; }
.ev-del-btn {
  background: rgba(176,120,88,0.08);
  border: 1px solid rgba(176,120,88,0.3);
  cursor: pointer; flex-shrink: 0;
  color: #b07858; padding: 4px;
  display: flex; align-items: center; align-self: center;
  border-radius: 6px; margin-left: auto;
  transition: background 0.15s, transform 0.15s;
}
.ev-del-btn:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); transform: scale(1.1); }
.sidebar-ev-bar { width: 3px; border-radius: 99px; align-self: stretch; flex-shrink: 0; min-height: 26px; }
.sidebar-ev-name { font-size: 12px; font-weight: 500; color: var(--text-primary); line-height: 1.4; overflow-wrap: break-word; word-break: break-word; }
.ev-type-badge {
  display: inline-block; vertical-align: middle; margin-left: 4px;
  font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
  padding: 1px 5px; border-radius: 4px; line-height: 1.5;
  white-space: nowrap;
}
.ev-proj-badge {
  background: rgba(123,127,178,0.12); color: #7b7fb2;
  border: 1px solid rgba(123,127,178,0.2);
}
.ev-event-badge {
  background: rgba(210,175,40,0.15); color: #a07c00;
  border: 1px solid rgba(210,175,40,0.4);
}
.sidebar-ev-desc { font-size: 11px; color: var(--text-secondary); margin-top: 3px; line-height: 1.4; display: flex; align-items: flex-start; gap: 4px; }
.sidebar-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 0; color: var(--text-secondary); font-size: 12px; opacity: 0.55; }
.sidebar-divider { height: 1px; background: rgba(0,0,0,0.06); margin: 14px 0; }
.sidebar-section-title { font-size: 10px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px; }
.upcoming-item { display: flex; align-items: center; margin-bottom: 7px; }
.upcoming-item:last-child { margin-bottom: 0; }
</style>

<style>
.overflow-popup {
  background: rgba(238,240,246,0.96);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.82);
  border-radius: 14px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 28px rgba(30,40,80,0.14);
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.overflow-popup-title { font-size: 12px; font-weight: 700; color: var(--text-secondary); line-height: 1; padding-bottom: 2px; margin-bottom: -2px; }
.overflow-list { display: flex; flex-direction: column; gap: 4px; }
.overflow-item {
  display: flex; align-items: center; gap: 4px;
  height: 22px; padding: 0 8px; border-radius: 99px;
  border: 1px solid transparent; font-size: 10px; font-weight: 500;
  white-space: nowrap; overflow: hidden;
}
.overflow-item:not(.overflow-clickable) { pointer-events: none; }
.overflow-tag {
  font-size: 8px; font-weight: 700; letter-spacing: 0.04em;
  background: rgba(255,255,255,0.5);
  border-radius: 3px; padding: 0 3px; line-height: 11px;
  flex-shrink: 0; margin-right: 2px;
}
.overflow-tag-ev { background: rgba(210,175,40,0.35); color: #7a5c00; }
.overflow-name { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }

.cal-month-picker {
  background: rgba(238,240,246,0.96);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.82);
  border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 10px 36px rgba(30,40,80,0.14);
  padding: 14px;
}
.picker-year-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.picker-year { font-size: 13px; font-weight: 700; color: #1e2028; }
.picker-nav { width: 26px; height: 26px; border-radius: 7px; border: none; background: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #8a8fa8; transition: background 0.12s; }
.picker-nav:hover { background: rgba(0,0,0,0.07); }
.picker-months { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
.picker-month { padding: 6px 0; border-radius: 8px; border: none; font-size: 12px; font-weight: 500; font-family: 'PingFang SC','Segoe UI',sans-serif; cursor: pointer; background: none; color: #1e2028; transition: all 0.12s; }
.picker-month:hover { background: rgba(123,127,178,0.14); }
.picker-month.active { background: linear-gradient(135deg,#7b7fb2,#9590c4); color: white; font-weight: 700; box-shadow: 0 2px 6px rgba(123,127,178,0.3); }

.picker-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.picker-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.picker-enter-from,.picker-leave-to { opacity: 0; transform: scaleY(0.9) translateY(-6px); transform-origin: top; }

.add-event-popup { background: rgba(255,255,255,0.66); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,0.88); border-radius: 16px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 32px rgba(60,70,100,0.12); padding: 16px; display: flex; flex-direction: column; gap: 9px; }
.popup-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.popup-title { font-size: 13px; font-weight: 700; color: #1e2028; }
.popup-close-btn { width: 22px; height: 22px; border-radius: 6px; border: none; background: none; cursor: pointer; color: #8a8fa8; display: flex; align-items: center; justify-content: center; transition: background 0.12s, color 0.12s; padding: 0; flex-shrink: 0; }
.popup-close-btn:hover { background: rgba(0,0,0,0.07); color: #1e2028; }
.popup-input { width: 100%; padding: 7px 10px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.75); background: rgba(255,255,255,0.68); font-size: 12px; font-family: 'PingFang SC', 'Segoe UI', sans-serif; color: #1e2028; outline: none; box-sizing: border-box; transition: border-color 0.15s, box-shadow 0.15s; }
.popup-input:focus { border-color: rgba(123,127,178,0.55); box-shadow: 0 0 0 3px rgba(123,127,178,0.12); background: rgba(255,255,255,0.85); }
.popup-input::placeholder { color: #8a8fa8; opacity: 0.7; }
.popup-textarea { width: 100%; padding: 7px 10px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.75); background: rgba(255,255,255,0.68); font-size: 12px; font-family: 'PingFang SC', 'Segoe UI', sans-serif; color: #1e2028; outline: none; box-sizing: border-box; transition: border-color 0.15s, box-shadow 0.15s; resize: none; line-height: 1.5; }
.popup-textarea:focus { border-color: rgba(123,127,178,0.55); box-shadow: 0 0 0 3px rgba(123,127,178,0.12); background: rgba(255,255,255,0.85); }
.popup-textarea::placeholder { color: #8a8fa8; opacity: 0.7; }
.popup-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 2px; }
.popup-delete { padding: 5px 12px; border-radius: 8px; border: 1px solid rgba(176,120,88,0.3); background: rgba(176,120,88,0.08); font-size: 12px; cursor: pointer; color: #b07858; font-family: 'PingFang SC', 'Segoe UI', sans-serif; font-weight: 600; transition: background 0.12s, border-color 0.12s; }
.popup-delete:hover { background: rgba(176,120,88,0.15); border-color: rgba(176,120,88,0.5); }
.popup-save { padding: 5px 14px; border-radius: 8px; border: none; background: linear-gradient(135deg,#7b7fb2,#9590c4); color: white; font-size: 12px; font-weight: 600; cursor: pointer; font-family: 'PingFang SC', 'Segoe UI', sans-serif; transition: opacity 0.15s; box-shadow: 0 2px 8px rgba(123,127,178,0.28); }
.popup-save:disabled { opacity: 0.38; cursor: default; }
.popup-save:not(:disabled):hover { opacity: 0.88; }
.form-pop-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.form-pop-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.form-pop-enter-from, .form-pop-leave-to { opacity: 0; transform: scale(0.95) translateY(-6px); }
</style>
