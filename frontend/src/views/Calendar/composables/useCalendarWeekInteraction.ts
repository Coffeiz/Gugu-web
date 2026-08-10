import { computed, onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import type { CalendarHourHover, CalendarTimeSelection, CalendarWeekDay } from '../domain/calendarTypes'

interface DateRange { start: string; end: string }
interface RangeSelection { active: boolean; anchor: string | null }

interface WeekInteractionOptions {
  viewMode: Ref<string>
  hourHeight: number
  weekDays: ComputedRef<CalendarWeekDay[]>
  activeRange: ComputedRef<DateRange | null>
  rangeSelect: RangeSelection
  hoverRangeEnd: Ref<string | null>
  selRange: Ref<DateRange | null>
  selectedDate: Ref<string | null>
  clearContext: () => void
  isExternalDragging?: () => boolean
  onSlotSelected: (slot: CalendarTimeSelection, previous: CalendarTimeSelection | null, event: MouseEvent) => void
}

export function useCalendarWeekInteraction(options: WeekInteractionOptions) {
  const { viewMode, hourHeight, weekDays, activeRange, rangeSelect, hoverRangeEnd, selRange, selectedDate, clearContext, isExternalDragging, onSlotSelected } = options
  const wvAllDayGridRef = ref<HTMLElement | null>(null)
  const wvSelCols = computed(() => {
    if (viewMode.value !== 'week' || !activeRange.value) return []
    const range = activeRange.value
    return weekDays.value.map((day, index) => day.iso >= range.start && day.iso <= range.end ? index : -1).filter(index => index >= 0)
  })
  const wvAdHover = ref(-1)
  const wvHover = ref<CalendarHourHover | null>(null)
  const wvDragging = ref(false)
  const wvSelectedSlot = ref<CalendarTimeSelection | null>(null)
  let wvColRect: DOMRect | null = null
  let previousSelectedSlot: CalendarTimeSelection | null = null
  let allDayMove: ((event: MouseEvent) => void) | null = null
  let allDayUp: ((event: MouseEvent) => void) | null = null
  let allDayClickBlocker: ((event: MouseEvent) => void) | null = null

  function setAllDayGridRef(el: Element | { $el?: Element } | null) { wvAllDayGridRef.value = el as HTMLElement | null }
  function isoFromAllDayX(clientX: number) {
    const grid = wvAllDayGridRef.value
    if (!grid) return null
    const rect = grid.getBoundingClientRect()
    const index = Math.max(0, Math.min(6, Math.floor((clientX - rect.left) / rect.width * 7)))
    return weekDays.value[index]?.iso ?? null
  }
  function hourAt(clientY: number, rect: DOMRect) { return Math.max(0, Math.min(23, Math.floor((clientY - rect.top) / hourHeight))) }
  function wvDaySelected(iso: string) {
    const range = activeRange.value
    return range ? iso >= range.start && iso <= range.end : false
  }
  function onAllDayHover(event: MouseEvent) {
    const grid = wvAllDayGridRef.value
    if (!grid) return
    const rect = grid.getBoundingClientRect()
    wvAdHover.value = Math.max(0, Math.min(6, Math.floor((event.clientX - rect.left) / rect.width * 7)))
  }
  function onAllDayLeave() { wvAdHover.value = -1 }
  function onAllDayDown(event: MouseEvent) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.wv-pbar,.wv-allday-ev,.wv-more')) return
    const startIso = isoFromAllDayX(event.clientX)
    if (!startIso) return
    event.preventDefault(); clearContext()
    if (allDayMove && allDayUp) {
      document.removeEventListener('mousemove', allDayMove)
      document.removeEventListener('mouseup', allDayUp)
    }
    let dragging = false
    const move = (moveEvent: MouseEvent) => {
      const iso = isoFromAllDayX(moveEvent.clientX)
      if (!iso) return
      if (!dragging && iso !== startIso) {
        dragging = true; wvSelectedSlot.value = null; rangeSelect.active = true; rangeSelect.anchor = startIso
      }
      if (dragging) hoverRangeEnd.value = iso
    }
    const up = (upEvent: MouseEvent) => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
      allDayMove = null; allDayUp = null
      const endIso = isoFromAllDayX(upEvent.clientX) || startIso
      rangeSelect.active = false; hoverRangeEnd.value = null
      if (dragging && endIso !== startIso) {
        const [start, end] = [startIso, endIso].sort(); selRange.value = { start, end }
        const blockClick = (clickEvent: MouseEvent) => {
          clickEvent.stopPropagation()
          allDayClickBlocker = null
        }
        allDayClickBlocker = blockClick
        document.addEventListener('click', blockClick, { capture: true, once: true })
      } else {
        wvSelectedSlot.value = null; selRange.value = { start: startIso, end: startIso }; selectedDate.value = startIso
      }
    }
    allDayMove = move; allDayUp = up
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  }
  function onColMove(event: MouseEvent, day: CalendarWeekDay) {
    if (wvDragging.value || isExternalDragging?.()) return
    if ((event.target as HTMLElement).closest('.wv-ev')) { wvHover.value = null; return }
    wvHover.value = { iso: day.iso, h: hourAt(event.clientY, (event.currentTarget as HTMLElement).getBoundingClientRect()) }
  }
  function onColLeave() { if (!wvDragging.value) wvHover.value = null }
  function onColDown(event: MouseEvent, day: CalendarWeekDay) {
    if (event.button !== 0) return
    selRange.value = null; wvColRect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const hour = hourAt(event.clientY, wvColRect)
    previousSelectedSlot = wvSelectedSlot.value ? { ...wvSelectedSlot.value } : null
    wvDragging.value = true; wvSelectedSlot.value = { iso: day.iso, h0: hour, h1: hour }; wvHover.value = null
    document.addEventListener('mousemove', onColumnDrag); document.addEventListener('mouseup', onColumnUp); event.preventDefault()
  }
  function onColumnDrag(event: MouseEvent) {
    if (!wvDragging.value || !wvColRect || !wvSelectedSlot.value) return
    event.preventDefault(); wvSelectedSlot.value = { ...wvSelectedSlot.value, h1: hourAt(event.clientY, wvColRect) }
  }
  function onColumnUp(event: MouseEvent) {
    document.removeEventListener('mousemove', onColumnDrag); document.removeEventListener('mouseup', onColumnUp)
    wvDragging.value = false
    const slot = wvSelectedSlot.value
    if (!slot) return
    const selected = { iso: slot.iso, h0: Math.min(slot.h0, slot.h1), h1: Math.max(slot.h0, slot.h1) }
    wvSelectedSlot.value = selected; selectedDate.value = selected.iso
    onSlotSelected(selected, previousSelectedSlot, event); previousSelectedSlot = null
  }
  onUnmounted(() => {
    document.removeEventListener('mousemove', onColumnDrag)
    document.removeEventListener('mouseup', onColumnUp)
    if (allDayMove) document.removeEventListener('mousemove', allDayMove)
    if (allDayUp) document.removeEventListener('mouseup', allDayUp)
    if (allDayClickBlocker) document.removeEventListener('click', allDayClickBlocker, true)
    allDayMove = null; allDayUp = null; allDayClickBlocker = null
  })
  return { wvAllDayGridRef, wvSelCols, wvAdHover, wvHover, wvDragging, wvSelectedSlot, setAllDayGridRef, isoFromAllDayX, hourAt, wvDaySelected, onAllDayDown, onAllDayHover, onAllDayLeave, onColDown, onColMove, onColLeave }
}
