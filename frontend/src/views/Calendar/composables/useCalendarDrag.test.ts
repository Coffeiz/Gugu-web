import { createApp, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useCalendarDrag, type CalendarDragState } from './useCalendarDrag'
import type { CalendarRenderItem } from '../domain/calendarTypes'

const eventItem: CalendarRenderItem = {
  id: 'event-1',
  name: '活动',
  calendarType: 'event',
  accent: '#7ab8c8',
  date: '2026-08-10',
  time: '10:00',
}

function mountDrag() {
  let state!: CalendarDragState
  let dragApi!: ReturnType<typeof useCalendarDrag>
  const dragOverIso = { value: null as string | null }
  const commitDrag = vi.fn()
  const app = createApp({
    setup() {
      state = { active: false, type: null, item: null, offsetDays: 0 }
      dragApi = useCalendarDrag({
        drag: state,
        dragOverIso,
        isoFromPoint: (x, y) => `${x}:${y}`,
        daysBetween: () => 0,
        commitDrag,
        closeMorePopup: vi.fn(),
      })
      return () => null
    },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  return { app, host, state, dragOverIso, commitDrag, dragApi }
}

describe('useCalendarDrag', () => {
  it('mouseup 使用释放位置更新吸附日期，而不是使用按下位置', async () => {
    const ctx = mountDrag()
    ctx.dragApi.startEventDrag(eventItem, new MouseEvent('mousedown', { clientX: 10, clientY: 20 }))

    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 40 }))
    expect(ctx.state.active).toBe(true)
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 80, clientY: 90 }))

    expect(ctx.dragOverIso.value).toBe('80:90')
    expect(ctx.commitDrag).toHaveBeenCalledOnce()

    ctx.app.unmount()
    ctx.host.remove()
    await nextTick()
  })

  it('组件卸载后不会继续响应遗留的鼠标事件', () => {
    const ctx = mountDrag()
    ctx.dragApi.startEventDrag(eventItem, new MouseEvent('mousedown', { clientX: 10, clientY: 20 }))
    ctx.app.unmount()

    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 40 }))
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 80, clientY: 90 }))

    expect(ctx.commitDrag).not.toHaveBeenCalled()
    expect(ctx.state.active).toBe(false)
    ctx.host.remove()
  })
})
