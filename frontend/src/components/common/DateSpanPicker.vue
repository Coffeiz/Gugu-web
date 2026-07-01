<template>
  <div class="drp-wrap" ref="wrapRef">
    <div class="drp-input" :class="{ 'has-value': startDate || endDate, placeholder: !startDate && !endDate }" @click="toggle">
      <svg class="drp-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <rect x="1" y="2" width="12" height="11" rx="3"/>
        <path d="M4 1v2M10 1v2M1 6h12"/>
      </svg>
      <span v-if="startDate || endDate">
        <span>{{ fmt(startDate) }}</span>
        <span class="drp-sep"> — </span>
        <span :class="{ 'drp-end-placeholder': !endDate }">{{ endDate ? fmt(endDate) : '截止日期' }}</span>
      </span>
      <span v-else>{{ placeholder }}</span>
    </div>

    <Teleport to="body">
      <Transition name="drp-pop">
        <div v-if="open" class="drp-popup" :style="popupStyle" ref="popupRef">

          <!-- 头部导航 -->
          <div v-if="!yearMode" class="drp-header">
            <button class="drp-nav" @click.stop="prevMonth">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2L4 6l4 4"/></svg>
            </button>
            <button class="drp-period" @click.stop="enterYearMode">
              {{ cursor.getFullYear() }}年{{ cursor.getMonth() + 1 }}月
              <svg class="drp-period-caret" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
            </button>
            <button class="drp-nav" @click.stop="nextMonth">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg>
            </button>
          </div>

          <!-- 年份导航 -->
          <div v-else class="drp-header">
            <button class="drp-nav" @click.stop="yearStart -= 12">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2L4 6l4 4"/></svg>
            </button>
            <button class="drp-period" @click.stop="yearMode = false">
              {{ yearStart }} — {{ yearStart + 11 }}
              <svg class="drp-period-caret up" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
            </button>
            <button class="drp-nav" @click.stop="yearStart += 12">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg>
            </button>
          </div>

          <!-- 年份网格 -->
          <div v-if="yearMode" class="drp-year-grid">
            <button
              v-for="y in 12" :key="y"
              class="drp-year-btn"
              :class="{ 'this-year': yearStart + y - 1 === todayYear, 'selected': yearStart + y - 1 === cursor.getFullYear() }"
              @click.stop="selectYear(yearStart + y - 1)"
            >{{ yearStart + y - 1 }}</button>
          </div>

          <!-- 月历 -->
          <template v-else>
            <!-- 选择阶段提示 -->
            <div class="drp-hint">
              <span :class="{ active: phase === 'start' }">开始日期</span>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 6h8M7 3l3 3-3 3"/></svg>
              <span :class="{ active: phase === 'end' }">截止日期</span>
            </div>

            <div class="drp-weekrow">
              <span v-for="w in '一二三四五六日'" :key="w" class="drp-wh">{{ w }}</span>
            </div>

            <div class="drp-grid"
              @mousemove="onGridMove"
              @mouseleave="hovered = null"
            >
              <button
                v-for="d in calDays" :key="d.key"
                class="drp-day"
                :data-iso="d.iso"
                :class="{
                  other:             d.other,
                  today:             d.iso === todayIso,
                  'sel-start':       d.iso === props.startDate,
                  'sel-end':         d.iso === effectiveEnd,
                  'in-range':        isInRange(d.iso),
                  'in-range-right':  d.iso === props.startDate && isInRange(nextDay(d.iso)),
                  'in-range-left':   d.iso === effectiveEnd   && isInRange(prevDay(d.iso)),
                  weekend:           d.dow >= 5,
                }"
                @click.stop="pickDay(d.iso)"
              >{{ d.date }}</button>
            </div>

            <div class="drp-footer">
              <button class="drp-clear" @click.stop="clear">清除</button>
              <button class="drp-today" @click.stop="cursor = new Date(today.getFullYear(), today.getMonth(), 1)">今天</button>
            </div>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { nextZ } from '@/composables/windowz'

const props = defineProps({
  startDate: { type: String, default: '' },
  endDate:   { type: String, default: '' },
  placeholder: { type: String, default: '选择日期范围' },
})
const emit = defineEmits(['update:startDate', 'update:endDate'])

const open      = ref(false)
const wrapRef   = ref(null)
const popupRef  = ref(null)
const popupStyle = ref({})
const yearMode  = ref(false)
const phase     = ref('start')   // 'start' | 'end'
const hovered   = ref(null)

const today     = new Date()
const todayIso  = toIso(today)
const todayYear = today.getFullYear()

const cursor = ref(
  props.startDate
    ? new Date(props.startDate + 'T00:00:00')
    : new Date(today.getFullYear(), today.getMonth(), 1)
)
const yearStart = ref(Math.floor(cursor.value.getFullYear() / 12) * 12)

function toIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function fmt(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  const base = `${d.getMonth()+1}/${d.getDate()}`
  return d.getFullYear() !== todayYear ? `${d.getFullYear()}/${base}` : base
}

const calDays = computed(() => {
  const y = cursor.value.getFullYear()
  const m = cursor.value.getMonth()
  const first = new Date(y, m, 1)
  const last  = new Date(y, m + 1, 0)
  const startDow = (first.getDay() + 6) % 7
  const days = []
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(y, m, -i)
    days.push({ key: `p${i}`, date: d.getDate(), iso: toIso(d), other: true, dow: (d.getDay()+6)%7 })
  }
  for (let i = 1; i <= last.getDate(); i++) {
    const d = new Date(y, m, i)
    days.push({ key: toIso(d), date: i, iso: toIso(d), other: false, dow: (d.getDay()+6)%7 })
  }
  const rem = 7 - (days.length % 7)
  if (rem < 7) for (let i = 1; i <= rem; i++) {
    const d = new Date(y, m + 1, i)
    days.push({ key: `n${i}`, date: i, iso: toIso(d), other: true, dow: (d.getDay()+6)%7 })
  }
  return days
})

const effectiveEnd = computed(() =>
  phase.value === 'end' ? (hovered.value || props.endDate) : props.endDate
)

function shiftDay(iso, delta) {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + delta); return toIso(d)
}
function nextDay(iso) { return shiftDay(iso, 1) }
function prevDay(iso) { return shiftDay(iso, -1) }

function isInRange(iso) {
  const s = props.startDate
  const e = effectiveEnd.value
  if (!s || !e) return false
  const [lo, hi] = s <= e ? [s, e] : [e, s]
  return iso > lo && iso < hi
}

function onGridMove(e) {
  if (phase.value !== 'end') return
  const btn = e.target.closest('[data-iso]')
  hovered.value = btn ? btn.dataset.iso : null
}

function pickDay(iso) {
  if (phase.value === 'start') {
    emit('update:startDate', iso)
    emit('update:endDate', '')
    phase.value = 'end'
  } else {
    // 如果选的截止早于开始，自动交换
    if (props.startDate && iso < props.startDate) {
      emit('update:endDate', props.startDate)
      emit('update:startDate', iso)
    } else {
      emit('update:endDate', iso)
    }
    hovered.value = null
    open.value = false
    yearMode.value = false
  }
}

function prevMonth() {
  const d = new Date(cursor.value); d.setMonth(d.getMonth() - 1); cursor.value = d
}
function nextMonth() {
  const d = new Date(cursor.value); d.setMonth(d.getMonth() + 1); cursor.value = d
}

function enterYearMode() {
  yearStart.value = Math.floor(cursor.value.getFullYear() / 12) * 12
  yearMode.value = true
}
function selectYear(y) {
  const d = new Date(cursor.value); d.setFullYear(y); cursor.value = d
  yearMode.value = false
}

function calcPopupStyle() {
  const rect = wrapRef.value?.getBoundingClientRect()
  if (!rect) return
  const popW = 240
  const centerX = rect.left + rect.width / 2
  const left = Math.max(8, Math.min(centerX - popW / 2, window.innerWidth - popW - 8))
  popupStyle.value = { position: 'fixed', top: rect.bottom + 6 + 'px', left: left + 'px', width: popW + 'px', zIndex: nextZ() }
}

function toggle() {
  if (open.value) { open.value = false; yearMode.value = false; return }
  phase.value = 'start'
  calcPopupStyle()
  open.value = true
}

function clear() {
  emit('update:startDate', '')
  emit('update:endDate', '')
  phase.value = 'start'
  open.value = false
}

function onClickOutside(e) {
  if (!open.value) return
  if (wrapRef.value?.contains(e.target)) return
  if (popupRef.value?.contains(e.target)) return
  open.value = false
  yearMode.value = false
}

onMounted(() => document.addEventListener('click', onClickOutside, true))
onUnmounted(() => document.removeEventListener('click', onClickOutside, true))

watch(() => props.startDate, v => {
  if (v) cursor.value = new Date(v + 'T00:00:00')
})
</script>

<style scoped>
.drp-wrap { position: relative; width: 100%; }
.drp-input {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 9px 12px;
  background: rgba(255,255,255,0.72);
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 10px;
  font-size: 13px; color: var(--text-primary, #1e2028);
  cursor: pointer; user-select: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.drp-input:hover {
  border-color: rgba(123,127,178,0.4);
  box-shadow: 0 0 0 3px rgba(123,127,178,0.08);
}
.drp-input.placeholder span { color: var(--text-secondary, #8a8fa8); opacity: 0.6; }
.drp-icon { color: var(--text-secondary, #8a8fa8); flex-shrink: 0; }
.drp-sep { opacity: 0.4; }
.drp-end-placeholder { color: var(--text-secondary, #8a8fa8); opacity: 0.5; }
</style>

<style>
.drp-popup {
  background: var(--panel-bg);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.78);
  border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98), 0 12px 36px rgba(30,40,80,0.14);
  padding: 12px; user-select: none;
}

.drp-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px;
}
.drp-period {
  display: flex; align-items: center; gap: 4px;
  font-size: 13px; font-weight: 700; color: #1e2028;
  border: none; background: none; cursor: pointer;
  padding: 3px 8px; border-radius: 7px;
  font-family: 'PingFang SC', 'Segoe UI', sans-serif;
  transition: background 0.12s, color 0.12s;
}
.drp-period:hover { background: rgba(123,127,178,0.1); color: #7b7fb2; }
.drp-period-caret { opacity: 0.5; flex-shrink: 0; transition: transform 0.15s; }
.drp-period-caret.up { transform: rotate(180deg); }
.drp-nav {
  width: 26px; height: 26px; border-radius: 7px;
  border: none; background: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: #8a8fa8; transition: background 0.12s;
}
.drp-nav:hover { background: rgba(0,0,0,0.07); }

/* 阶段提示 */
.drp-hint {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  font-size: 11px; font-weight: 600; color: #8a8fa8;
  margin-bottom: 8px; letter-spacing: 0.03em;
}
.drp-hint span.active { color: #7b7fb2; }

.drp-weekrow {
  display: grid; grid-template-columns: repeat(7, 1fr);
  margin-bottom: 4px;
}
.drp-wh { text-align: center; font-size: 10px; font-weight: 600; color: #8a8fa8; padding: 2px 0; }

.drp-grid { display: grid; grid-template-columns: repeat(7, 1fr); }
.drp-day {
  aspect-ratio: 1;
  display: flex; align-items: center; justify-content: center;
  border: none; background: none; cursor: pointer; padding: 0;
  font-size: 11px; font-weight: 500; color: #1e2028; line-height: 1;
  border-radius: 7px; transition: background 0.1s, color 0.1s;
  font-family: 'PingFang SC', 'Segoe UI', sans-serif;
  position: relative;
}
.drp-day:hover:not(.sel-start):not(.sel-end) { background: rgba(123,127,178,0.12); }
.drp-day.other { color: #8a8fa8; opacity: 0.4; }
.drp-day.weekend:not(.sel-start):not(.sel-end):not(.today) { color: #b07080; }
.drp-day.today:not(.sel-start):not(.sel-end) {
  background: rgba(123,127,178,0.15); color: #7b7fb2; font-weight: 700;
}

/* 区间 */
.drp-day.in-range {
  background: rgba(123,127,178,0.13); border-radius: 0; color: #1e2028;
}
.drp-day.in-range.weekend { color: #b07080; }

/* 起止端点 */
.drp-day.sel-start, .drp-day.sel-end {
  background: linear-gradient(135deg,#7b7fb2,#9590c4);
  color: white; font-weight: 700;
  box-shadow: 0 2px 8px rgba(123,127,178,0.32);
  border-radius: 7px; z-index: 1;
}

/* 区间与端点拼接：端点单侧延伸背景 */
.drp-day.sel-start.in-range-right::after,
.drp-day.sel-end.in-range-left::after {
  content: ''; position: absolute; top: 0; bottom: 0; width: 50%;
  background: rgba(123,127,178,0.13); z-index: -1;
}
.drp-day.sel-start.in-range-right::after { right: 0; border-radius: 0; }
.drp-day.sel-end.in-range-left::after    { left: 0;  border-radius: 0; }

/* 年份网格 */
.drp-year-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 2px 0 4px; }
.drp-year-btn {
  height: 34px; border-radius: 8px; border: none; background: none;
  font-size: 12px; font-weight: 500; color: #1e2028; cursor: pointer;
  font-family: 'PingFang SC', 'Segoe UI', sans-serif; transition: background 0.1s, color 0.1s;
}
.drp-year-btn:hover:not(.selected) { background: rgba(123,127,178,0.12); }
.drp-year-btn.this-year:not(.selected) { background: rgba(123,127,178,0.15); color: #7b7fb2; font-weight: 700; }
.drp-year-btn.selected {
  background: linear-gradient(135deg,#7b7fb2,#9590c4);
  color: white; font-weight: 700; box-shadow: 0 2px 8px rgba(123,127,178,0.32);
}

.drp-footer {
  display: flex; justify-content: space-between;
  margin-top: 8px; padding-top: 8px;
  border-top: 1px solid rgba(0,0,0,0.06);
}
.drp-clear, .drp-today {
  font-size: 11px; font-weight: 600;
  padding: 4px 10px; border-radius: 7px; border: none;
  cursor: pointer; font-family: 'PingFang SC', 'Segoe UI', sans-serif;
  transition: background 0.12s;
}
.drp-clear { background: none; color: #8a8fa8; }
.drp-clear:hover { background: rgba(0,0,0,0.06); color: #1e2028; }
.drp-today { background: rgba(123,127,178,0.12); color: #7b7fb2; }
.drp-today:hover { background: rgba(123,127,178,0.22); }

.drp-pop-enter-active { transition: opacity 0.15s, transform 0.18s cubic-bezier(0.34,1.2,0.64,1); }
.drp-pop-leave-active { transition: opacity 0.1s, transform 0.1s ease-in; }
.drp-pop-enter-from, .drp-pop-leave-to { opacity: 0; transform: scale(0.95) translateY(-4px); }
</style>
