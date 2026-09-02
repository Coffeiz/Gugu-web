import { describe, expect, it } from 'vitest'
import { buildUpcomingList } from './useCalendarUpcoming'
import type { CalendarRenderItem } from '@/views/Calendar/domain/calendarTypes'

function project(id: string, endDate: string, extra: Partial<CalendarRenderItem> = {}): CalendarRenderItem {
  return { id, name: id, calendarType: 'project', accent: '#7b7fb2', status: 'active', startDate: '2026-08-10', endDate, ...extra }
}

function event(id: string, date: string): CalendarRenderItem {
  return { id, name: id, calendarType: 'event', accent: '#7ab8c8', date, time: '' }
}

describe('useCalendarUpcoming', () => {
  it('按截止窗口、完成状态和优先级生成近期节点', () => {
    const result = buildUpcomingList([
      project('done', '2026-08-11', { status: 'done', priority: 'high' }),
      project('urgent', '2026-08-12', { priority: 'low' }),
      project('normal', '2026-08-12', { priority: 'high' }),
      project('outside', '2026-09-01'),
    ], [], new Date('2026-08-10T12:00:00'))

    expect(result.map(item => item.id)).toEqual(['normal', 'urgent', 'done'])
    expect(result.find(item => item.id === 'normal')?.daysLabel).toBe('2天后')
    expect(result.find(item => item.id === 'done')?.daysLeft).toBe(1)
  })

  it('合并事件时按 id 去重并保持输入不变', () => {
    const events = [event('e1', '2026-08-11'), event('e1', '2026-08-11'), event('e2', '2026-08-30')]
    const snapshot = structuredClone(events)
    const result = buildUpcomingList([], events, new Date('2026-08-10T12:00:00'))

    expect(result.map(item => item.id)).toEqual(['e1'])
    expect(events).toEqual(snapshot)
  })
})
