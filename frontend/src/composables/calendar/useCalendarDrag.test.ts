import { createApp, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useCalendarDrag, type CalendarDragState } from './useCalendarDrag'
import type { CalendarRenderItem } from '@/views/Calendar/domain/calendarTypes'

const eventItem: CalendarRenderItem = {
  id: 'event-1',
  name: '活动',
  calendarType: 'event',
  accent: '#7ab8c8',
  date: '2026-08-10',
  time: '10:00',
}

const doneProjectItem: CalendarRenderItem = {
  id: 'p1',
  name: '已完成项目',
  calendarType: 'project',
  accent: '#7b7fb2',
  status: 'done',
  startDate: '2026-08-10',
  endDate: '2026-08-12',
}

function mountDrag() {
  let state!: CalendarDragState
  let dragApi!: ReturnType<typeof useCalendarDrag>
  const dragOverIso = ref<string | null>(null)
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

  it('已完成项目不会启动移动或缩放预览', () => {
    const ctx = mountDrag()
    ctx.dragApi.startProjectChipDrag(doneProjectItem, new MouseEvent('mousedown', { clientX: 10, clientY: 20 }))
    ctx.dragApi.startBarDrag(doneProjectItem, new MouseEvent('mousedown', { clientX: 10, clientY: 20 }))
    ctx.dragApi.startBarResize(doneProjectItem, 'end', new MouseEvent('mousedown', { clientX: 10, clientY: 20 }))

    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 40 }))
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: 80, clientY: 90 }))

    expect(ctx.state.active).toBe(false)
    expect(ctx.commitDrag).not.toHaveBeenCalled()
    ctx.app.unmount()
    ctx.host.remove()
  })
})
