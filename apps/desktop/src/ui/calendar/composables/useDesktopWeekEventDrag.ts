import { onUnmounted, shallowRef } from 'vue'
import type { CalendarRenderItem } from '@/views/Calendar/domain/calendarTypes'

type EventTiming = { date: string; time: string; endTime: string }
type Edge = 'start' | 'end' | null
const DAY_MINUTES = 24 * 60
const STEP_MINUTES = 30

function minutes(time: string) {
  const [hour = 0, minute = 0] = time.split(':').map(Number)
  return hour * 60 + minute
}

function timeLabel(value: number) {
  const minute = value % DAY_MINUTES
  return [Math.floor(minute / 60), minute % 60].map(part => String(part).padStart(2, '0')).join(':')
}

function edgeAt(event: MouseEvent, anchor: HTMLElement): Edge {
  const { top, height } = anchor.getBoundingClientRect()
  const edgeHeight = Math.min(7, height / 3)
  if (event.clientY - top <= edgeHeight) return 'start'
  if (top + height - event.clientY <= edgeHeight) return 'end'
  return null
}

export function useDesktopWeekEventDrag(options: {
  hourHeight: number
  weekDates: () => string[]
  blocked: () => boolean
  open: (item: CalendarRenderItem, event: MouseEvent, anchor: HTMLElement) => void
  commit: (item: CalendarRenderItem, timing: EventTiming) => Promise<void>
}) {
  const preview = shallowRef<{ id: CalendarRenderItem['id']; timing: EventTiming } | null>(null)
  let cancel: (() => void) | undefined

  function hover(event: MouseEvent) {
    if (!(event.currentTarget instanceof HTMLElement)) return
    event.currentTarget.style.cursor = edgeAt(event, event.currentTarget) ? 'ns-resize' : 'grab'
  }

  function start(item: CalendarRenderItem, press: MouseEvent) {
    const target = press.currentTarget
    if (press.button !== 0 || options.blocked() || !item.time || !item.date || !(target instanceof HTMLElement)) return
    const anchor = target
    const grid = anchor.closest('.wv-grid')
    if (!grid) return

    cancel?.()
    press.preventDefault()
    const edge = edgeAt(press, anchor)
    const date = item.date
    const startMin = minutes(item.time)
    const rawEnd = item.endTime ? minutes(item.endTime) : Math.min(DAY_MINUTES, startMin + 60)
    const endMin = rawEnd <= startMin ? rawEnd + DAY_MINUTES : rawEnd
    const duration = endMin - startMin
    const columns = Array.from(grid.querySelectorAll('.wv-col'))
    const dates = options.weekDates()
    let moved = false

    function move(event: MouseEvent) {
      if (!moved && Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) < 5) return
      moved = true
      const index = columns.findIndex(column => {
        const rect = column.getBoundingClientRect()
        return event.clientX >= rect.left && event.clientX < rect.right
      })
      const targetDate = dates[index]
      if (!targetDate) {
        preview.value = null
        return
      }
      const delta = Math.round((event.clientY - press.clientY) * 60 / options.hourHeight / STEP_MINUTES) * STEP_MINUTES
      let nextStart = startMin
      let nextEnd = endMin
      if (edge === 'start' && delta) {
        nextStart = Math.min(Math.max(0, startMin + delta), DAY_MINUTES - 1, endMin - Math.min(duration, STEP_MINUTES))
      } else if (edge === 'end' && delta) {
        nextEnd = Math.max(startMin + Math.min(duration, STEP_MINUTES), Math.min(DAY_MINUTES, Math.min(DAY_MINUTES, endMin) + delta))
      } else if (!edge && delta) {
        const latestStart = endMin > DAY_MINUTES ? DAY_MINUTES - STEP_MINUTES : DAY_MINUTES - duration
        nextStart = Math.max(0, Math.min(latestStart, startMin + delta))
        nextEnd = nextStart + duration
      }
      const nextDate = edge ? date : targetDate
      preview.value = nextDate === date && nextStart === startMin && nextEnd === endMin ? null : {
        id: item.id,
        timing: { date: nextDate, time: timeLabel(nextStart), endTime: timeLabel(nextEnd) },
      }
    }

    function cleanup() {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', finish)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', cleanup)
      preview.value = null
      cancel = undefined
    }

    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') cleanup()
    }

    function finish(event: MouseEvent) {
      if (event.button !== 0) return
      move(event)
      const finalPreview = preview.value
      cleanup()
      if (!moved) options.open(item, event, anchor)
      else if (finalPreview) {
        preview.value = finalPreview
        void options.commit(item, finalPreview.timing).finally(() => {
          if (preview.value === finalPreview) preview.value = null
        })
      }
    }

    cancel = cleanup
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', finish)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', cleanup)
  }

  onUnmounted(() => cancel?.())
  return { start, hover, preview }
}
