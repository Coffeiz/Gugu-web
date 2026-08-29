<template>
  <div class="adp-wrap" ref="wrapRef">
    <div class="adp-trigger" :class="{ open: show }" @click="toggle">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round" class="adp-icon">
        <rect x="2" y="3" width="12" height="11" rx="2"/>
        <path d="M5 1v3M11 1v3M2 7h12"/>
      </svg>
      <span :class="{ placeholder: !modelValue }">{{ display }}</span>
      <svg v-if="modelValue" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
        class="adp-clear" @click.stop="clear">
        <path d="M4 4l8 8M12 4l-8 8"/>
      </svg>
    </div>

    <PopupMenu :show="show" :style="popupStyle" popup-class="adp-popup-host">
      <!-- 主日历弹窗（暗色） -->
      <div class="adp-popup popup-menu-dark">
        <div class="adp-header">
          <button class="adp-nav" @click="prevMonth">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>
          </button>
          <button class="adp-ym-btn" ref="ymBtnRef" @click.stop="toggleYearPicker">
            {{ cur.year }} 年 {{ cur.month + 1 }} 月
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" :style="{ transform: showYearPicker ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }">
              <path d="M3 6l5 5 5-5"/>
            </svg>
          </button>
          <button class="adp-nav" @click="nextMonth">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>
          </button>
        </div>

        <div class="adp-weekdays">
          <span v-for="d in ['日','一','二','三','四','五','六']" :key="d">{{ d }}</span>
        </div>
        <div class="adp-grid">
          <button v-for="cell in cells" :key="cell.key" class="adp-cell"
            :class="{ other: !cell.cur, selected: cell.selected, today: cell.today }"
            @click="cell.cur && selectDay(cell)">{{ cell.day }}</button>
        </div>
      </div>

      <!-- 年份选择器（前台亮色 popup-menu） -->
      <PopupMenu :show="showYearPicker" :style="yearPopupStyle" popup-class="adp-year-popup-host">
      <div class="adp-year-popup popup-menu-dark">
        <div class="adp-yp-header">
          <button class="adp-yp-nav" @click.stop="yearBase -= 12">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>
          </button>
          <span class="adp-yp-range">{{ yearBase }}–{{ yearBase + 11 }}</span>
          <button class="adp-yp-nav" @click.stop="yearBase += 12">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>
          </button>
        </div>
        <div class="adp-yp-grid">
          <button v-for="y in yearRange" :key="y" class="adp-yp-cell"
            :class="{ selected: y === cur.year, today: y === today.year }"
            @click.stop="selectYear(y)">{{ y }}</button>
        </div>
      </div>
      </PopupMenu>
    </PopupMenu>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import PopupMenu from '@/components/common/PopupMenu.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '选择日期' },
})
const emit = defineEmits(['update:modelValue'])

const POPUP_W = 248

const show           = ref(false)
const showYearPicker = ref(false)
const wrapRef        = ref<HTMLElement | null>(null)
const ymBtnRef       = ref<HTMLElement | null>(null)
const popupStyle     = ref({})
const yearPopupStyle = ref({})

const todayDate = new Date()
const today  = { year: todayDate.getFullYear(), month: todayDate.getMonth(), day: todayDate.getDate() }
const cur      = ref({ year: today.year, month: today.month })
const yearBase = ref(Math.floor(today.year / 12) * 12)

const yearRange = computed(() => Array.from({ length: 12 }, (_, i) => yearBase.value + i))

watch(() => props.modelValue, v => {
  if (v) { const d = new Date(v); cur.value = { year: d.getFullYear(), month: d.getMonth() } }
}, { immediate: true })

const display = computed(() => props.modelValue || props.placeholder)

const cells = computed(() => {
  const { year, month } = cur.value
  const first = new Date(year, month, 1).getDay()
  const days  = new Date(year, month + 1, 0).getDate()
  const pDays = new Date(year, month, 0).getDate()
  const result = []
  for (let i = first - 1; i >= 0; i--)
    result.push({ key: `p${i}`, day: pDays - i, cur: false, selected: false, today: false })
  for (let d = 1; d <= days; d++) {
    const iso = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    result.push({ key: `c${d}`, day: d, cur: true, selected: props.modelValue === iso,
      today: year === today.year && month === today.month && d === today.day })
  }
  let n = 1
  while (result.length % 7 !== 0) result.push({ key: `n${n}`, day: n++, cur: false, selected: false, today: false })
  return result
})

function toggle() {
  show.value = !show.value
  if (show.value) { showYearPicker.value = false; nextTick(positionMain) }
  else showYearPicker.value = false
}

function positionMain() {
  const rect = wrapRef.value?.getBoundingClientRect()
  if (!rect) return
  const left  = rect.left + rect.width / 2 - POPUP_W / 2
  const below = rect.bottom + 310 < window.innerHeight
  popupStyle.value = {
    position: 'fixed',
    left: `${Math.max(8, left)}px`,
    top: below ? `${rect.bottom + 5}px` : `${rect.top - 315}px`,
    zIndex: 9999,
  }
}

function toggleYearPicker() {
  showYearPicker.value = !showYearPicker.value
  if (showYearPicker.value) nextTick(positionYearPicker)
}

function positionYearPicker() {
  const btn = ymBtnRef.value?.getBoundingClientRect()
  if (!btn) return
  const YP_W = 220, YP_H = 180
  const left  = btn.left + btn.width / 2 - YP_W / 2
  const below = btn.bottom + YP_H < window.innerHeight
  yearPopupStyle.value = {
    position: 'fixed',
    left: `${Math.max(8, left)}px`,
    top: below ? `${btn.bottom + 4}px` : `${btn.top - YP_H - 4}px`,
    width: `${YP_W}px`,
    zIndex: 10000,
  }
}

function clear() { emit('update:modelValue', '') }

function prevMonth() {
  if (cur.value.month === 0) { cur.value.year--; cur.value.month = 11 }
  else cur.value.month--
}
function nextMonth() {
  if (cur.value.month === 11) { cur.value.year++; cur.value.month = 0 }
  else cur.value.month++
}

function selectYear(y: number) {
  cur.value.year = y
  yearBase.value = Math.floor(y / 12) * 12
  showYearPicker.value = false
}

function selectDay(cell: any) {
  const iso = `${cur.value.year}-${String(cur.value.month+1).padStart(2,'0')}-${String(cell.day).padStart(2,'0')}`
  emit('update:modelValue', iso)
  show.value = false
  showYearPicker.value = false
}

function onClickOutside(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  const inWrap  = wrapRef.value?.contains(t)
  const inPopup = t?.closest('.adp-popup') || t?.closest('.adp-year-popup')
  if (!inWrap && !inPopup) { show.value = false; showYearPicker.value = false }
}
onMounted(() => document.addEventListener('mousedown', onClickOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', onClickOutside))
</script>

<style scoped>
.adp-wrap { position: relative; display: inline-block; }

.adp-trigger {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  height: 34px; padding: 0 12px; border-radius: 9px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.75); font-size: 13px;
  cursor: pointer; transition: border-color 0.15s, background 0.15s;
  user-select: none; min-width: 128px; position: relative;
  font-family: var(--font-sans);
}
.adp-trigger:hover,
.adp-trigger.open { border-color: rgba(255,255,255,0.22); background: rgba(255,255,255,0.08); }
.adp-icon    { color: rgba(255,255,255,0.35); flex-shrink: 0; }
.placeholder { color: rgba(255,255,255,0.28); }
.adp-clear   { position: absolute; right: 10px; color: rgba(255,255,255,0.28); transition: color 0.15s; }
.adp-clear:hover { color: rgba(255,255,255,0.65); }

/* 主弹窗 */
.adp-popup { width: 248px; padding: 10px; font-family: var(--font-sans); }
:global(.popup-menu-host.adp-popup-host), :global(.popup-menu-host.adp-year-popup-host) { padding: 0; border: 0; background: transparent; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }

.adp-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px; padding: 0 2px;
}
.adp-nav {
  width: 24px; height: 24px; border-radius: 6px; border: none;
  background: transparent; color: rgba(255,255,255,0.35);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background 0.12s, color 0.12s; flex-shrink: 0;
}
.adp-nav:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.8); }

.adp-ym-btn {
  display: flex; align-items: center; gap: 5px;
  border: none; background: transparent; cursor: pointer;
  font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.75);
  padding: 3px 8px; border-radius: 6px;
  transition: background 0.12s, color 0.12s;
  font-family: var(--font-sans);
}
.adp-ym-btn:hover { background: rgba(255,255,255,0.09); color: #fff; }

.adp-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); margin-bottom: 3px; }
.adp-weekdays span {
  text-align: center; font-size: 11px; font-weight: 600;
  color: rgba(255,255,255,0.22); padding: 2px 0;
}

.adp-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.adp-cell {
  aspect-ratio: 1; border-radius: 6px; border: none;
  background: transparent; color: rgba(255,255,255,0.6);
  font-size: 12px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.1s, color 0.1s; font-family: var(--font-sans);
}
.adp-cell:hover:not(.other) { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); }
.adp-cell.other   { color: rgba(255,255,255,0.15); cursor: default; }
.adp-cell.today   { color: rgba(160,150,235,0.95); font-weight: 700; }
.adp-cell.selected {
  background: rgba(120,110,200,0.45); border: 1px solid rgba(150,140,225,0.4);
  color: #fff; font-weight: 700;
}

/* 年份选择器（亮色 popup-menu，scoped 内只控制尺寸和内部布局） */
.adp-year-popup { padding: 8px; font-family: var(--font-sans); }

.adp-yp-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px; padding: 0 2px;
}
.adp-yp-nav {
  width: 22px; height: 22px; border-radius: 6px; border: none;
  background: transparent; color: rgba(255,255,255,0.35);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background 0.12s, color 0.12s;
}
.adp-yp-nav:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.8); }
.adp-yp-range { font-size: 12px; font-weight: 600; color: rgba(255,255,255,0.65); }

.adp-yp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; }
.adp-yp-cell {
  padding: 7px 4px; border-radius: 7px; border: none;
  background: transparent; color: rgba(255,255,255,0.65);
  font-size: 13px; cursor: pointer; text-align: center;
  transition: background 0.1s, color 0.1s; font-family: var(--font-sans);
}
.adp-yp-cell:hover { background: rgba(255,255,255,0.08); color: #fff; }
.adp-yp-cell.today { color: rgba(160,150,235,0.95); font-weight: 700; }
.adp-yp-cell.selected { background: rgba(120,110,200,0.45); color: #fff; font-weight: 700; }
</style>
