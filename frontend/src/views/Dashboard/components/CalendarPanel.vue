<template>
  <div class="glass-card calendar-panel">
    <!-- 月份头 -->
    <div class="cal-header">
      <button class="cal-nav" @click="prevMonth">‹</button>
      <div class="cal-month-btn" @click="togglePicker" ref="pickerAnchorRef">
        <span>{{ t('dashboardCalendarUi.month', { year, month: month + 1 }) }}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
          :style="{ transform: pickerOpen ? 'rotate(180deg)' : '', transition: 'transform 0.2s' }">
          <path d="M2 3.5l3 3 3-3"/>
        </svg>
      </div>
      <button class="cal-nav" @click="nextMonth">›</button>
    </div>

    <!-- 星期行 -->
    <div class="cal-grid" :style="{ gridTemplateRows: `auto repeat(${numWeeks}, 1fr)` }">
      <span class="weekday" v-for="w in weekdays" :key="w" :class="{ weekend: w === '六' || w === '日' }">{{ w }}</span>
      <div
        v-for="d in calDays" :key="d.key"
        class="cal-day"
        :class="{
          'other-month': d.other,
          'today': d.isToday,
          'is-holiday': !d.other && hdayType(d.iso) === 'holiday',
          'is-workday':  !d.other && hdayType(d.iso) === 'workday',
        }"
        @click="selectDay(d)"
      >
        <span class="day-num">{{ d.date }}</span>
        <span v-if="!d.other && hdayType(d.iso)" class="hday-badge" :class="'hday-' + hdayType(d.iso)">{{ hdayType(d.iso) === 'holiday' ? t('dashboardCalendarUi.holiday') : t('dashboardCalendarUi.workday') }}</span>
        <span v-if="!d.other && (d.hasEvent || d.isDeadline)" class="day-dots">
          <i v-if="d.hasEvent" class="dot-ev" :class="{ 'on-today': d.isToday }"></i>
          <i v-if="d.isDeadline" class="dot-dl" :class="{ 'on-today': d.isToday }"></i>
        </span>
      </div>
    </div>

    <!-- 近期节点 -->
    <div class="upcoming">
      <div class="upcoming-title">{{ t('dashboardCalendarUi.upcoming') }}</div>
      <div v-if="visibleEvents.length === 0" class="upcoming-empty">{{ t('dashboardCalendarUi.empty') }}</div>
      <div class="event-row cap-row" :class="{ 'ev-proj-row': e.isProject, 'ev-act-row': !e.isProject }" v-for="e in visibleEvents" :key="e.id">
        <div class="cap-capsule"
             :style="{ '--cap-bg': capBg(e.color, e.progress ?? 0), borderColor: hexAlpha(e.color, 0.3), cursor: 'pointer' }"
             @click="e.isProject ? openProject(e) : openEditForm(e, $event)">
          <span class="cap-tag" :class="e.isProject ? 'cap-tag-proj' : 'cap-tag-ev'" :style="e.isProject ? { color: darkenHex(e.color) } : {}">{{ e.isProject ? t('dashboardCalendarUi.project') : t('dashboardCalendarUi.event') }}</span>
          <span v-if="e.isProject" class="cap-sdot" :class="'cap-s-' + e.status"></span>
          <span class="cap-name" :style="{ color: darkenHex(e.color) }">{{ e.name }}</span>
          <span class="cap-days" :class="{ urgent: e.daysLeft <= 3 }">{{ e.daysLabel }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 编辑活动弹窗 -->
  <Teleport to="body">
    <Transition name="dash-form-pop">
      <div v-if="showEditForm && editingEvent" class="dash-edit-popup" ref="editFormRef" :style="editFormStyle">
        <div class="dash-popup-title">{{ t('dashboardCalendarUi.edit') }}</div>
        <input v-model="editingEvent.name" class="dash-popup-input" :placeholder="t('dashboardCalendarUi.name')"
          v-enter="saveEditForm" @keydown.esc="showEditForm = false" autofocus />
        <DatePicker v-model="editingEvent.date" :placeholder="t('dashboardCalendarUi.date')" />
        <textarea v-model="editingEvent.description" class="dash-popup-textarea" :placeholder="t('dashboardCalendarUi.description')" rows="2"></textarea>
        <div class="dash-popup-actions">
          <button class="dash-popup-cancel" @click="showEditForm = false">{{ t('dashboardCalendarUi.cancel') }}</button>
          <button class="dash-popup-save" @click="saveEditForm" :disabled="!editingEvent.name">{{ t('dashboardCalendarUi.save') }}</button>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- Teleport 到 body，脱离 glass-card 的堆叠上下文，blur 才能透出页面背景 -->
  <Teleport to="body">
    <Transition name="picker">
      <div
        v-if="pickerOpen"
        class="month-picker"
        ref="pickerRef"
        :style="pickerStyle"
      >
        <div class="picker-year-row">
          <button class="picker-nav" @click.stop="pickerYear--">‹</button>
          <span class="picker-year">{{ pickerYear }}</span>
          <button class="picker-nav" @click.stop="pickerYear++">›</button>
        </div>
        <div class="picker-months">
          <button
            v-for="m in 12" :key="m"
            class="picker-month"
            :class="{ active: m - 1 === month && pickerYear === year }"
            @click.stop="selectYearMonth(pickerYear, m - 1)"
          >{{ t('calendarUi.monthShort', { month: m }) }}</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { eventsApi } from '@/services/api'
import { InteractionSync } from '@/interaction/sync/InteractionSync'
import { useProjectStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import { useRouter } from 'vue-router'
import DatePicker from '@/components/common/controls/DatePicker.vue'
import { useHolidays } from '@/composables/shared/useHolidays'
import { projectProgress } from '@/utils/projectProgress'


const projectStore = useProjectStore()
const uiStore = useUiStore()
const router = useRouter()
const { t } = useI18n()

const today    = new Date()
const year     = ref(today.getFullYear())
const month    = ref(today.getMonth())
const weekdays = ['一', '二', '三', '四', '五', '六', '日']

const { fetchYear, getHolidayType } = useHolidays()

// 模块级节假日缓存，跨导航不重置
const _hdayStore: Record<number, any> = {}
const hdayCache  = ref(_hdayStore)

async function loadHolidays() {
  const y = year.value
  const years = [y]
  if (month.value === 11) years.push(y + 1)
  let changed = false
  for (const yr of years) {
    if (!_hdayStore[yr]) {
      _hdayStore[yr] = await fetchYear(yr)
      changed = true
    }
  }
  if (changed) hdayCache.value = { ..._hdayStore }
}

function hdayType(isoDate: string) {
  if (!isoDate) return null
  const yr = +isoDate.slice(0, 4)
  return getHolidayType(hdayCache.value[yr], isoDate)
}

const pickerOpen      = ref(false)
const pickerYear      = ref(today.getFullYear())
const pickerAnchorRef = ref<HTMLElement | null>(null)
const pickerRef       = ref<HTMLElement | null>(null)
const pickerStyle     = ref({})

function updatePickerPos() {
  const rect = pickerAnchorRef.value?.getBoundingClientRect()
  if (!rect) return
  pickerStyle.value = {
    position: 'fixed',
    top:  rect.bottom + 6 + 'px',
    left: rect.left + 'px',
    width: '220px',
    zIndex: 1000,
  }
}

function togglePicker() {
  if (!pickerOpen.value) {
    pickerYear.value = year.value
    pickerOpen.value = true
    nextTick(updatePickerPos)
  } else {
    pickerOpen.value = false
  }
}

function selectYearMonth(y: number, m: number) {
  year.value  = y
  month.value = m
  pickerOpen.value = false
}

// ── 编辑活动弹窗 ──────────────────────────────────────────────────────────────
const showEditForm  = ref(false)
const editingEvent  = ref<any | null>(null)
const editFormRef   = ref<HTMLElement | null>(null)
const editFormStyle = ref({})

function openEditForm(ev: any, nativeEv: MouseEvent) {
  if ((nativeEv?.target as HTMLElement | null)?.closest('.dp-popup')) return
  const el   = nativeEv.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const w    = 240
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8))
  const top  = Math.min(rect.bottom + 6, window.innerHeight - 260)
  editFormStyle.value = { position: 'fixed', top: top + 'px', left: left + 'px', width: w + 'px', zIndex: 2100 }
  editingEvent.value = { id: ev.rawId, name: ev.name, date: ev.iso, description: ev.description || '' }
  showEditForm.value = true
}

async function saveEditForm() {
  const ev = editingEvent.value
  if (!ev?.name) return
  showEditForm.value = false
  const previous = events.value.find(item => item.id === ev.id)
  const raw = projectStore.upcomingCalEvents.find(e => e.id === ev.id)
  const rawPrevious = raw ? { title: raw.title, date: raw.date, description: raw.description } : null
  try {
    await InteractionSync.execute({
      scope: 'calendar.event.dashboard-update', entityKey: `calendar-event:${ev.id}`,
      apply: () => {
        events.value = events.value.map(e => e.id === ev.id ? { ...e, title: ev.name, date: ev.date, description: ev.description } : e)
        _eventsCache.set(`${year.value}-${month.value}`, events.value)
        if (raw) { raw.title = ev.name; raw.date = ev.date; raw.description = ev.description }
      },
      rollback: () => {
        if (previous) events.value = events.value.map(e => e.id === ev.id ? previous : e)
        _eventsCache.set(`${year.value}-${month.value}`, events.value)
        if (raw && rawPrevious) Object.assign(raw, rawPrevious)
      },
      request: mutation => eventsApi.update(ev.id, { title: ev.name, date: ev.date, description: ev.description || undefined }, { mutationId: mutation.mutationId }),
    })
  } catch { /* 统一事务已回滚 */ }
}

function handleClickOutside(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest?.('.dp-popup')) return
  if (showEditForm.value) {
    if (!editFormRef.value?.contains(e.target as Node))
      showEditForm.value = false
  }
  if (!pickerOpen.value) return
  if (pickerAnchorRef.value?.contains(e.target as Node)) return
  if (pickerRef.value?.contains(e.target as Node)) return
  pickerOpen.value = false
}

onMounted(() => document.addEventListener('click', handleClickOutside, true))
onUnmounted(() => document.removeEventListener('click', handleClickOutside, true))

const TYPE_COLOR = { deadline: '#b07858', milestone: '#7b7fb2', meeting: '#7ab8c8', event: '#9590c4' }

// 模块级事件缓存，键为 `${year}-${month}`，跨导航不重置
const _eventsCache = new Map()

// 当前显示月份的事件（用于日历格子打点）
const events = ref<any[]>([])
async function loadEvents() {
  const key = `${year.value}-${month.value}`
  if (_eventsCache.has(key)) {
    events.value = _eventsCache.get(key)
    return
  }
  try {
    const data = await eventsApi.list(year.value, month.value)
    events.value = data
    _eventsCache.set(key, data)
  } catch { /* ignore */ }
}
onMounted(() => { loadEvents(); loadHolidays() })
watch([year, month], () => { loadEvents(); loadHolidays() })

// 近期节点日历事件直接读 store（DefaultLayout 挂载时已预加载）
const upcomingCalEvents = computed(() => projectStore.upcomingCalEvents)

// 当月项目截止日 ISO 集合
const deadlineDates = computed(() => {
  const set = new Set()
  const y = year.value, m = String(month.value + 1).padStart(2, '0')
  for (const p of projectStore.projects) {
    if (p.deadline && p.deadline.startsWith(`${y}-${m}`)) set.add(p.deadline)
  }
  return set
})

const numWeeks = computed(() => {
  const first    = new Date(year.value, month.value, 1)
  const last     = new Date(year.value, month.value + 1, 0)
  const startDow = (first.getDay() + 6) % 7
  return Math.ceil((startDow + last.getDate()) / 7)
})

const calDays = computed(() => {
  const first    = new Date(year.value, month.value, 1)
  const last     = new Date(year.value, month.value + 1, 0)
  const startDow = (first.getDay() + 6) % 7
  const days: Array<{ key: string; date: number; other: boolean; iso: string; isToday?: boolean; hasEvent?: boolean; isDeadline?: boolean }> = []

  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(year.value, month.value, -i)
    days.push({ key: `p${i}`, date: d.getDate(), other: true, iso: localIso(d) })
  }
  for (let i = 1; i <= last.getDate(); i++) {
    const iso        = `${year.value}-${String(month.value + 1).padStart(2,'0')}-${String(i).padStart(2,'0')}`
    const isToday    = year.value === today.getFullYear() && month.value === today.getMonth() && i === today.getDate()
    const hasCalEvent = events.value.some(e => e.date === iso)
    const hasDeadline = deadlineDates.value.has(iso)
    days.push({ key: iso, date: i, other: false, iso, isToday, hasEvent: hasCalEvent, isDeadline: hasDeadline })
  }
  let next = 1
  while (days.length < numWeeks.value * 7) {
    const nd = new Date(year.value, month.value + 1, next)
    days.push({ key: `n${next}`, date: next, other: true, iso: localIso(nd) })
    next++
  }
  return days
})


function localIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// 近期节点：合并日历事件 + 项目截止日，未来 15 天内，按日期排序
const visibleEvents = computed(() => {
  const now      = new Date()
  const todayIso = localIso(now)
  const cutoff   = localIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 15))
  const items = []

  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  for (const e of upcomingCalEvents.value) {
    if (e.date >= todayIso && e.date <= cutoff) {
      const dl = Math.round((new Date(e.date + 'T00:00:00').getTime() - nowMidnight.getTime()) / 86400000)
      items.push({
        id:          'ev-' + e.id,
        rawId:       e.id,
        name:        e.title,
        color:       TYPE_COLOR[e.type as keyof typeof TYPE_COLOR] ?? '#9590c4',
        iso:         e.date,
        description: e.description ?? '',
        daysLeft:    dl,
        daysLabel:   dl === 0 ? '今天' : dl === 1 ? '明天' : dl + '天后',
      })
    }
  }
  for (const p of projectStore.projects) {
    if (p.deadline && p.deadline >= todayIso && p.deadline <= cutoff && p.status !== 'done') {
      const dl = Math.round((new Date(p.deadline + 'T00:00:00').getTime() - nowMidnight.getTime()) / 86400000)
      items.push({
        id:        'pr-' + p.id,
        name:      p.name,
        color:     p.color?.match(/#[0-9a-fA-F]{6}/)?.[0] ?? '#7b7fb2',
        iso:       p.deadline,
        isProject: true,
        status:    p.status,
        progress:  projectProgress(p),
        daysLeft:  dl,
        daysLabel: dl === 0 ? '今天' : dl === 1 ? '明天' : dl + '天后',
      })
    }
  }

  return items.sort((a, b) => {
    if (a.isProject !== b.isProject) return a.isProject ? -1 : 1
    return a.iso.localeCompare(b.iso)
  })
})

function prevMonth() {
  if (month.value === 0) { month.value = 11; year.value-- } else month.value--
}
function nextMonth() {
  if (month.value === 11) { month.value = 0; year.value++ } else month.value++
}
// 点某天 → 跳完整日历视图并定位到该日（含相邻月的灰格：跳到它所属的月份）
function selectDay(d: any) {
  if (!d?.iso) return
  uiStore.pendingCalendarDate = d.iso
  router.push('/calendar')
}

function openProject(e: any) {
  const pid = Number(String(e.id).replace(/^pr-/, ''))
  const proj = projectStore.projects.find(p => p.id === pid)
  if (proj) projectStore.openModal(proj)
}

function capBg(hex: string, progress = 0) {
  const base = hexAlpha(hex, 0.1)
  if (!progress) return base
  const fill = hexAlpha(hex, 0.32)
  return `linear-gradient(to right, ${fill} 0%, ${fill} ${progress}%, ${base} ${progress}%, ${base} 100%)`
}

function hexAlpha(hex: string, a: number) {
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `rgba(${r},${g},${b},${a})`
}

function darkenHex(hex: string, amount = 0.60) {
  const r = Math.round(parseInt(hex.slice(1,3),16) * amount)
  const g = Math.round(parseInt(hex.slice(3,5),16) * amount)
  const b = Math.round(parseInt(hex.slice(5,7),16) * amount)
  return `rgb(${r},${g},${b})`
}
</script>

<style scoped>
.calendar-panel {
  padding: 20px;
  display: flex; flex-direction: column;
}

.cal-header {
  display: grid; grid-template-columns: 32px 1fr 32px;
  align-items: center; margin-bottom: 14px;
}

.cal-month-btn {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  font-size: 14px; font-weight: 700;
  cursor: pointer; user-select: none;
  padding: 3px 8px; border-radius: 8px;
  transition: background 0.15s;
}
.cal-month-btn:hover { background: rgba(0,0,0,0.06); }

.cal-nav {
  background: none; border: none; cursor: pointer;
  color: var(--text-secondary); font-size: 16px;
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  border-radius: 7px; transition: background 0.15s; padding: 0;
}
.cal-nav:hover { background: rgba(0,0,0,0.06); }

.cal-grid {
  display: grid; grid-template-columns: repeat(7, 1fr);
  gap: 3px; margin-bottom: 14px;
  height: 196px;
}
.weekday {
  text-align: center; font-size: 11px; font-weight: 600;
  color: var(--text-secondary); padding: 3px 0 7px;
}
.weekday.weekend { color: rgba(195,90,90,0.85); }

.cal-day {
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 500; border-radius: 9px; cursor: pointer;
  position: relative; transition: background 0.12s; color: var(--text-primary);
}
.cal-day:hover { background: rgba(123,127,178,0.1); }
.cal-day.other-month { color: var(--text-secondary); opacity: 0.38; }
.cal-day.today {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; font-weight: 700;
  box-shadow: 0 2px 8px rgba(123,127,178,0.28);
}
.cal-day.is-holiday .day-num { color: rgba(210,75,75,0.82); }
.cal-day.today .day-num { color: inherit; }
.hday-badge {
  position: absolute; top: 2px; right: 3px;
  font-size: 8px; font-weight: 700; line-height: 1;
  pointer-events: none;
}
.hday-holiday { color: rgba(210,75,75,0.82); }
.hday-workday { color: rgba(170,100,5,0.85); }
.cal-day.today .hday-badge { color: rgba(255,255,255,0.75); }
.day-dots {
  position: absolute; bottom: 3px;
  display: flex; gap: 2px; align-items: center;
}
.dot-ev, .dot-dl {
  display: block; width: 4px; height: 4px; border-radius: 50%;
}
.dot-ev { background: #7b7fb2; }
.dot-dl { background: #c4a060; }
.dot-ev.on-today, .dot-dl.on-today { background: rgba(255,255,255,0.85); }

.upcoming {
  border-top: 1px solid rgba(0,0,0,0.05); padding-top: 13px;
}
.upcoming-title {
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 9px;
}
.upcoming-empty { font-size: 11px; color: var(--text-secondary); opacity: 0.5; padding: 6px 0; }
.event-row { display: flex; align-items: center; margin-bottom: 7px; }
.event-meta { font-size: 11px; color: var(--text-secondary); margin-top: 2px; display: flex; align-items: center; gap: 5px; }
.event-tag {
  font-size: 9px; font-weight: 600;
  background: rgba(196,160,96,0.15); color: #a07830;
  border-radius: 4px; padding: 1px 5px;
}
</style>

<!-- 选择器样式必须全局，因为它被 Teleport 到 body -->
<style>
.month-picker {
  background: rgba(255,255,255,0.62);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.85);
  border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 32px rgba(60,70,100,0.12);
  padding: 14px;
}

.picker-year-row {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 10px;
}
.picker-year { font-size: 13px; font-weight: 700; color: #1e2028; }
.picker-nav {
  background: none; border: none; cursor: pointer;
  font-size: 15px; color: #8a8fa8;
  padding: 2px 8px; border-radius: 7px; transition: background 0.12s;
}
.picker-nav:hover { background: rgba(0,0,0,0.07); }

.picker-months {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px;
}
.picker-month {
  padding: 6px 0; border-radius: 8px; border: none;
  font-size: 12px; font-weight: 500; font-family: var(--font-family-ui);
  cursor: pointer; background: none; color: #1e2028;
  transition: all 0.12s;
}
.picker-month:hover { background: rgba(123,127,178,0.14); }
.picker-month.active {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; font-weight: 700;
  box-shadow: 0 2px 6px rgba(123,127,178,0.3);
}

.picker-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.picker-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.picker-enter-from   { opacity: 0; transform: scaleY(0.88) translateY(-6px); transform-origin: top; }
.picker-leave-to     { opacity: 0; transform: scaleY(0.92) translateY(-4px); transform-origin: top; }

.dash-edit-popup {
  background: rgba(255,255,255,0.66); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.88); border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 8px 32px rgba(60,70,100,0.12);
  padding: 16px; display: flex; flex-direction: column; gap: 9px;
}
.dash-popup-title { font-size: 13px; font-weight: 700; color: #1e2028; margin-bottom: 2px; }
.dash-popup-input {
  width: 100%; padding: 7px 10px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.75); background: rgba(255,255,255,0.68);
  font-size: 12px; font-family: var(--font-family-ui); color: #1e2028;
  outline: none; box-sizing: border-box; transition: border-color 0.15s, box-shadow 0.15s;
}
.dash-popup-input:focus { border-color: rgba(123,127,178,0.55); box-shadow: 0 0 0 3px rgba(123,127,178,0.12); background: rgba(255,255,255,0.85); }
.dash-popup-textarea {
  width: 100%; padding: 7px 10px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.75); background: rgba(255,255,255,0.68);
  font-size: 12px; font-family: var(--font-family-ui); color: #1e2028;
  outline: none; box-sizing: border-box; transition: border-color 0.15s, box-shadow 0.15s;
  resize: none; line-height: 1.5;
}
.dash-popup-textarea:focus { border-color: rgba(123,127,178,0.55); box-shadow: 0 0 0 3px rgba(123,127,178,0.12); background: rgba(255,255,255,0.85); }
.dash-popup-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 2px; }
.dash-popup-cancel { padding: 5px 12px; border-radius: 8px; border: none; background: none; font-size: 12px; cursor: pointer; color: #8a8fa8; font-family: var(--font-family-ui); transition: background 0.12s; }
.dash-popup-cancel:hover { background: rgba(0,0,0,0.06); }
.dash-popup-save { padding: 5px 14px; border-radius: 8px; border: none; background: var(--action-primary-bg); color: var(--content-on-accent); font-size: 12px; font-weight: 600; cursor: pointer; font-family: var(--font-family-ui); transition: background-color 0.15s; box-shadow: none; }
.dash-popup-save:disabled { opacity: 0.38; cursor: default; }
.dash-popup-save:not(:disabled):hover { background: var(--action-primary-bg-hover); opacity: 1; }
.dash-form-pop-enter-active { transition: opacity 0.16s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.dash-form-pop-leave-active { transition: opacity 0.12s, transform 0.12s ease-in; }
.dash-form-pop-enter-from, .dash-form-pop-leave-to { opacity: 0; transform: scale(0.95) translateY(-6px); }
</style>
