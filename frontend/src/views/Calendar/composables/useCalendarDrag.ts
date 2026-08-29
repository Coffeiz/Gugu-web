import { onUnmounted } from 'vue'
import type { Ref } from 'vue'
import type { CalendarRenderItem } from '../domain/calendarTypes'
import { canDrag } from '../domain/calendarRules'

export type CalendarDragType = 'event' | 'proj-chip' | 'proj-bar' | 'proj-resize-start' | 'proj-resize-end'

export interface CalendarDragState {
  active: boolean
  type: CalendarDragType | null
  item: CalendarRenderItem | null
  offsetDays: number
}

interface UseCalendarDragOptions {
  drag: CalendarDragState
  dragOverIso: Ref<string | null>
  isoFromPoint: (x: number, y: number) => string | null
  daysBetween: (a: string, b: string) => number
  commitDrag: () => void
  closeMorePopup: () => void
}

export function useCalendarDrag({ drag, dragOverIso, isoFromPoint, daysBetween, commitDrag, closeMorePopup }: UseCalendarDragOptions) {
  const cleanups = new Set<() => void>()

  function startDrag(type: CalendarDragType, item: CalendarRenderItem, e: MouseEvent, offsetDays = 0, onActivate: (() => void) | null = null) {
    const startX = e.clientX
    const startY = e.clientY
    let activated = false

    const mm = (ev: MouseEvent) => {
      if (!activated) {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (Math.sqrt(dx * dx + dy * dy) < 5) return
        activated = true
        drag.active = true
        drag.type = type
        drag.item = item
        drag.offsetDays = offsetDays
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
        onActivate?.()
      }
      dragOverIso.value = isoFromPoint(ev.clientX, ev.clientY)
    }

    const mu = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', mm)
      document.removeEventListener('mouseup', mu)
      if (activated) {
        dragOverIso.value = isoFromPoint(ev.clientX, ev.clientY)
        commitDrag()
        document.addEventListener('click', ce => ce.stopPropagation(), { capture: true, once: true })
        setTimeout(() => {
          drag.active = false
          drag.type = null
          drag.item = null
          dragOverIso.value = null
        }, 30)
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      cleanups.delete(cleanup)
    }

    const cleanup = () => {
      document.removeEventListener('mousemove', mm)
      document.removeEventListener('mouseup', mu)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      cleanups.delete(cleanup)
    }

    document.addEventListener('mousemove', mm)
    document.addEventListener('mouseup', mu)
    cleanups.add(cleanup)
  }

  function startEventDrag(item: CalendarRenderItem, e: MouseEvent) {
    startDrag('event', item, e)
  }

  function startProjectChipDrag(item: CalendarRenderItem, e: MouseEvent) {
    if (!canDrag(item)) return
    startDrag('proj-chip', item, e)
  }

  function startMoreItemDrag(item: CalendarRenderItem, e: MouseEvent) {
    if (!canDrag(item)) return
    if (item.calendarType === 'project') startDrag('proj-chip', item, e, 0, closeMorePopup)
    else if (item.calendarType === 'event') startDrag('event', item, e, 0, closeMorePopup)
  }

  function startBarDrag(item: CalendarRenderItem, e: MouseEvent) {
    if (!canDrag(item)) return
    const anchorIso = isoFromPoint(e.clientX, e.clientY) ?? item.startDate
    if (!item.startDate || !anchorIso) return
    const offsetDays = daysBetween(item.startDate, anchorIso)
    startDrag('proj-bar', item, e, offsetDays)
  }

  function startBarResize(item: CalendarRenderItem, edge: 'start' | 'end', e: MouseEvent) {
    if (!canDrag(item)) return
    startDrag(edge === 'start' ? 'proj-resize-start' : 'proj-resize-end', item, e)
  }

  onUnmounted(() => {
    cleanups.forEach(cleanup => cleanup())
    cleanups.clear()
  })

  return { startDrag, startEventDrag, startProjectChipDrag, startMoreItemDrag, startBarDrag, startBarResize }
}
