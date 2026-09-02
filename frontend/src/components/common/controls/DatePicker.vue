<template>
  <div class="dp-wrap" ref="wrapRef">
    <div
      class="dp-input"
      :class="{ 'has-value': modelValue, placeholder: !modelValue, open }"
      @click="toggle"
    >
      <svg class="dp-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <rect x="1" y="2" width="12" height="11" rx="3"/>
        <path d="M4 1v3M10 1v3M1 6h12"/>
      </svg>
      <span>{{ displayValue || placeholder }}</span>
    </div>

    <PopupMenu :show="open" :style="{ ...popupStyle, padding: 0 }">
      <div class="dp-popup" :class="popupClass" ref="popupRef">

          <!-- 月份导航 -->
          <div v-if="!yearMode" class="dp-header">
            <button class="dp-nav" @click.stop="prevMonth">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2L4 6l4 4"/></svg>
            </button>
            <button class="dp-period" @click.stop="enterYearMode">
              {{ periodLabel(cursor) }}
              <svg class="dp-period-caret" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
            </button>
            <button class="dp-nav" @click.stop="nextMonth">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg>
            </button>
          </div>

          <!-- 年份选择导航 -->
          <div v-else class="dp-header">
            <button class="dp-nav" @click.stop="yearStart -= 12">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 2L4 6l4 4"/></svg>
            </button>
            <button class="dp-period dp-period-range" @click.stop="yearMode = false">
              {{ yearStart }} — {{ yearStart + 11 }}
              <svg class="dp-period-caret up" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
            </button>
            <button class="dp-nav" @click.stop="yearStart += 12">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 2l4 4-4 4"/></svg>
            </button>
          </div>

          <!-- 月份日历 -->
          <template v-if="!yearMode">
            <div class="dp-weekrow">
              <span v-for="w in weekDays" :key="w" class="dp-wh">{{ w }}</span>
            </div>
            <div class="dp-grid">
              <button
                v-for="d in calDays"
                :key="d.key"
                class="dp-day"
                :class="{
                  'other': d.other,
                  'today': d.iso === todayIso,
                  'selected': d.iso === modelValue,
                  'weekend': d.dow >= 5,
                  'disabled': isDisabled(d.iso),
                }"
                @click.stop="select(d.iso)"
              >{{ d.date }}</button>
            </div>
          </template>

          <!-- 年份网格 -->
          <div v-else class="dp-year-grid">
            <button
              v-for="y in 12"
              :key="y"
              class="dp-year-btn"
              :class="{
                'this-year': yearStart + y - 1 === todayYear,
                'selected': yearStart + y - 1 === cursor.getFullYear(),
              }"
              @click.stop="selectYear(yearStart + y - 1)"
            >{{ yearStart + y - 1 }}</button>
          </div>

          <!-- 快捷 -->
          <div v-if="!yearMode" class="dp-footer">
            <button v-if="showClear" class="dp-clear" @click.stop="clear">{{ t('sharedUi.clear') }}</button>
            <button class="dp-today" @click.stop="select(todayIso)">{{ t('sharedUi.today') }}</button>
          </div>
        </div>
    </PopupMenu>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { nextZ, registerPopover } from '@/composables/windowz'
import PopupMenu from '@/components/common/overlays/PopupMenu.vue'
import { useI18n } from 'vue-i18n'

const { t, tm, locale } = useI18n()
const weekDays = computed(() => {
  const days = tm('sharedUi.weekdays') as string[]
  return [...days.slice(1), days[0]]
})

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '选择日期' },
  min: { type: String, default: '' },
  max: { type: String, default: '' },
  // 提供时只有这些日期可选（其余全部禁用）——例如「只能跳到有记录的那天」
  allowedDates: { type: Array, default: null },
  // Teleport 到 body 后不再是宿主的 DOM 后代；需要给某个用法附加语义类名用于定位、
  // 测试或交互识别时从这里传入，主题表面统一由 adoption/popovers.css 负责。
  popupClass: { type: [String, Array, Object], default: null },
  // 「清除」在纯跳转场景里没有意义（清空等于什么都不做，只是关掉弹层）；补录日期这类
  // 真的把字段清空有意义的场景保留默认显示
  showClear: { type: Boolean, default: true },
})
const emit = defineEmits(['update:modelValue'])

const open       = ref(false)
const wrapRef    = ref<HTMLElement | null>(null)
const popupRef   = ref<HTMLElement | null>(null)
const popupStyle = ref({})
const yearMode   = ref(false)

const today    = new Date()
const todayIso = toIso(today)
const todayYear = today.getFullYear()

const cursor = ref(
  props.modelValue
    ? new Date(props.modelValue + 'T00:00:00')
    : new Date(today.getFullYear(), today.getMonth(), 1)
)

function periodLabel(date: Date) {
  if (locale.value === 'en-US') {
    return new Intl.DateTimeFormat(locale.value, { year: 'numeric', month: 'long' }).format(date)
  }
  return `${date.getFullYear()}${t('calendar.year')}${date.getMonth() + 1}${t('calendar.month')}`
}

const yearStart = ref(Math.floor(cursor.value.getFullYear() / 12) * 12)

function toIso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// 本年度不显示年份（跟全站其它日期展示一致的「同年只显月日」规则），跨年才带上年份
const displayValue = computed(() => {
  if (!props.modelValue) return ''
  const d = new Date(props.modelValue + 'T00:00:00')
  return d.getFullYear() === todayYear ? `${d.getMonth()+1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`
})

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

function prevMonth() {
  const d = new Date(cursor.value)
  d.setMonth(d.getMonth() - 1)
  cursor.value = d
}
function nextMonth() {
  const d = new Date(cursor.value)
  d.setMonth(d.getMonth() + 1)
  cursor.value = d
}

function enterYearMode() {
  yearStart.value = Math.floor(cursor.value.getFullYear() / 12) * 12
  yearMode.value = true
}

function selectYear(y: number) {
  const d = new Date(cursor.value)
  d.setFullYear(y)
  cursor.value = d
  yearMode.value = false
}

const allowedSet = computed(() => props.allowedDates ? new Set(props.allowedDates) : null)
function isDisabled(iso: string) {
  if (props.min && iso < props.min) return true
  if (props.max && iso > props.max) return true
  if (allowedSet.value && !allowedSet.value.has(iso)) return true
  return false
}

function select(iso: string) {
  if (isDisabled(iso)) return
  emit('update:modelValue', iso)
  open.value = false
}

function calcPopupStyle() {
  const rect = wrapRef.value?.getBoundingClientRect()
  if (!rect) return
  const popW = 224
  const centerX = rect.left + rect.width / 2
  const left = Math.max(8, Math.min(centerX - popW / 2, window.innerWidth - popW - 8))
  const base = { position: 'fixed', left: left + 'px', width: popW + 'px', zIndex: nextZ() }
  // 下方放不下且上方更宽裕 → 向上开：用 bottom 锚定弹层底边（切年份模式高度变了也
  // 自然向上生长）。触发场景：贴视口底部的输入条（笔记页捕捉条的补录日期）。
  const EST_H = 320
  const spaceBelow = window.innerHeight - rect.bottom
  popupStyle.value = (spaceBelow < EST_H + 14 && rect.top > spaceBelow)
    ? { ...base, bottom: window.innerHeight - rect.top + 6 + 'px' }
    : { ...base, top: rect.bottom + 6 + 'px' }
}

function openPicker() {
  if (open.value) return
  calcPopupStyle()
  open.value = true
}

function closePicker() { open.value = false }

defineExpose({ openPicker, closePicker })

function clear() {
  emit('update:modelValue', '')
  open.value = false
}

function toggle() {
  if (open.value) { open.value = false; yearMode.value = false; return }
  calcPopupStyle()
  open.value = true
}

function onClickOutside(e: MouseEvent) {
  if (!open.value) return
  if (wrapRef.value?.contains(e.target as Node)) return
  if (popupRef.value?.contains(e.target as Node)) return
  open.value = false
  yearMode.value = false
}

let unregisterPopover: (() => void) | null = null
watch(open, v => {
  unregisterPopover?.()
  unregisterPopover = v
    ? registerPopover(z => { popupStyle.value = { ...popupStyle.value, zIndex: z } })
    : null
})

onMounted(() => document.addEventListener('click', onClickOutside, true))
onUnmounted(() => {
  unregisterPopover?.()
  document.removeEventListener('click', onClickOutside, true)
})

watch(() => props.modelValue, v => {
  if (v) cursor.value = new Date(v + 'T00:00:00')
})
</script>

<style scoped>
.dp-wrap { position: relative; width: 100%; }

/* 与 DateSpanPicker.drp-input / TimeInput.boxed 同一套描边输入框契约（--input-* token）。 */
.dp-input {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 8px 11px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm, 10px);
  font-size: 13px; color: var(--input-fg);
  cursor: pointer; user-select: none;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.dp-input:hover {
  border-color: var(--input-border-hover);
  background: var(--input-bg-hover);
  box-shadow: var(--input-hover-shadow);
}
.dp-input.open {
  border-color: var(--input-border-focus);
  background: var(--input-bg-focus);
  box-shadow: var(--input-focus-shadow);
}
.dp-input.placeholder span { color: var(--input-placeholder); opacity: 0.6; font-size: 13px; }
.dp-icon { color: var(--input-placeholder); flex-shrink: 0; }
</style>

<style>
/* Popup and calendar paint live in adoption/popovers.css. This block owns geometry/typography only,
   so Teleport consumers cannot accumulate a second light-only theme layer. */
.dp-popup { padding: 12px; user-select: none; }

.dp-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 8px;
}
.dp-period {
  display: flex; align-items: center; gap: 4px;
  font-size: 13px; font-weight: 700;
  border: none; background: none; cursor: pointer;
  padding: 3px 8px; border-radius: 7px;
  font-family: var(--font-family-ui);
}
.dp-period-range { letter-spacing: 0.5px; }
.dp-period-caret { opacity: 0.5; flex-shrink: 0; }
.dp-period-caret.up { transform: rotate(180deg); }
.dp-nav {
  width: 26px; height: 26px; border-radius: 7px;
  border: none; background: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}

.dp-weekrow {
  display: grid; grid-template-columns: repeat(7, 1fr);
  margin-bottom: 4px;
}
.dp-wh {
  text-align: center; font-size: 10px; font-weight: 600;
  padding: 2px 0;
}

.dp-grid {
  display: grid; grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.dp-day {
  aspect-ratio: 1;
  display: flex; align-items: center; justify-content: center;
  border: none; background: none; cursor: pointer; padding: 0;
  font-size: 11px; font-weight: 500; line-height: 1;
  border-radius: 7px;
  font-family: var(--font-family-ui);
}
.dp-day.other { opacity: 0.4; }
.dp-day.today:not(.selected) { font-weight: 700; }
.dp-day.disabled { opacity: 0.25; cursor: not-allowed; pointer-events: none; }
.dp-day.selected { font-weight: 700; }

/* 年份网格 */
.dp-year-grid {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 4px; padding: 2px 0 4px;
}
.dp-year-btn {
  height: 34px; border-radius: 8px; border: none; background: none;
  font-size: 12px; font-weight: 500; cursor: pointer;
  font-family: var(--font-family-ui);
}
.dp-year-btn.this-year:not(.selected),
.dp-year-btn.selected { font-weight: 700; }

.dp-footer {
  display: flex; justify-content: space-between;
  margin-top: 8px; padding-top: 8px;
  border-top: 1px solid transparent;
}
.dp-clear, .dp-today {
  font-size: 11px; font-weight: 600;
  padding: 4px 10px; border-radius: 7px; border: none;
  cursor: pointer; font-family: var(--font-family-ui);
}
.dp-clear { background: none; }
/* 「清除」隐藏时 today 独自留在 footer 里，margin-left:auto 保它一直贴右边，不因为
   justify-content:space-between 只剩一个子元素就跳到左边 */
.dp-today { margin-left: auto; }

</style>
