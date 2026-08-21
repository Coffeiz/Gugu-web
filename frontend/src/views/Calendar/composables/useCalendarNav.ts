import { computed, nextTick, ref, type ComputedRef, type Ref } from 'vue'

interface CalendarWeekLabel { iso: string; md: string }

interface CalendarNavOptions {
  cursor: Ref<Date>
  selectedDate: Ref<string | null>
  todayIso: Ref<string>
  weekRef: Ref<Date>
  weekDays: ComputedRef<CalendarWeekLabel[]>
}

export function useCalendarNav({ cursor, selectedDate, todayIso, weekRef, weekDays }: CalendarNavOptions) {
  const viewMode = ref<'month' | 'week'>('month')
  const pickerOpen = ref(false)
  const pickerYear = ref(new Date().getFullYear())
  const pickerAnchorRef = ref<HTMLElement | null>(null)
  const pickerStyle = ref<Record<string, string | number>>({})

  const periodLabel = computed(() => {
    if (viewMode.value === 'week') {
      const days = weekDays.value
      return new Date(days[0].iso + 'T00:00:00').getFullYear() + '年 ' + days[0].md + ' - ' + days[6].md
    }
    return cursor.value.getFullYear() + '年 ' + (cursor.value.getMonth() + 1) + '月'
  })

  function prev() {
    if (viewMode.value === 'week') {
      const date = new Date(weekRef.value)
      date.setDate(date.getDate() - 7)
      weekRef.value = date
    } else {
      const date = new Date(cursor.value)
      date.setMonth(date.getMonth() - 1)
      cursor.value = date
    }
  }

  function next() {
    if (viewMode.value === 'week') {
      const date = new Date(weekRef.value)
      date.setDate(date.getDate() + 7)
      weekRef.value = date
    } else {
      const date = new Date(cursor.value)
      date.setMonth(date.getMonth() + 1)
      cursor.value = date
    }
  }

  function goToday() {
    const now = new Date()
    cursor.value = new Date(now.getFullYear(), now.getMonth(), 1)
    weekRef.value = now
    selectedDate.value = todayIso.value
  }

  function setView(mode: 'month' | 'week') {
    if (mode === viewMode.value) return
    if (mode === 'week') weekRef.value = new Date((selectedDate.value || todayIso.value) + 'T00:00:00')
    else cursor.value = new Date(weekRef.value.getFullYear(), weekRef.value.getMonth(), 1)
    viewMode.value = mode
  }

  function togglePicker(anchor: HTMLElement | null = null) {
    if (pickerOpen.value) {
      pickerOpen.value = false
      return
    }
    pickerAnchorRef.value = anchor
    pickerYear.value = cursor.value.getFullYear()
    pickerOpen.value = true
    nextTick(() => {
      const rect = pickerAnchorRef.value?.getBoundingClientRect()
      if (!rect) return
      // 先用预估宽度定位，避免首帧闪烁
      const fallbackW = 220
      const left0 = Math.max(8, Math.min(rect.left + rect.width / 2 - fallbackW / 2, window.innerWidth - fallbackW - 8))
      pickerStyle.value = { position: 'fixed', top: rect.bottom + 6 + 'px', left: left0 + 'px', width: fallbackW, zIndex: 2000 }
      // 再用弹窗实际渲染宽度重新居中
      requestAnimationFrame(() => {
        const pickerEl = document.querySelector('.cal-month-picker') as HTMLElement | null
        if (!pickerEl) return
        const pw = pickerEl.offsetWidth
        if (pw === fallbackW) return
        const left = Math.max(8, Math.min(rect.left + rect.width / 2 - pw / 2, window.innerWidth - pw - 8))
        pickerStyle.value = { ...pickerStyle.value, left: left + 'px', width: pw }
      })
    })
  }

  function selectYearMonth(year: number, month: number) {
    cursor.value = new Date(year, month, 1)
    pickerOpen.value = false
  }

  return { viewMode, periodLabel, prev, next, goToday, setView, pickerOpen, pickerYear, pickerAnchorRef, pickerStyle, togglePicker, selectYearMonth }
}
