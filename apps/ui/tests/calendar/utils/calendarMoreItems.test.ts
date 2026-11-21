import { describe, expect, it } from 'vitest'
import { resolveCalendarMoreItems } from '@/views/Calendar/utils/calendarMoreItems'
import type { CalendarRenderItem } from '@/views/Calendar/domain/calendarTypes'

const event = (id: number, name: string): CalendarRenderItem => ({
  id, name, date: '2026-10-17', calendarType: 'event', accent: '#7b7fb2',
})

const project = (id: string, name: string): CalendarRenderItem => ({
  id, name, calendarType: 'project', accent: '#7b7fb2', status: 'doing',
})

describe('resolveCalendarMoreItems', () => {
  it('删除活动后立即从已打开的更多列表移除，同时保留项目项', () => {
    const snapshot = [event(1, '已删除活动'), project('p2', '项目')]

    expect(resolveCalendarMoreItems(snapshot, [])).toEqual([project('p2', '项目')])
  })

  it('保留活动时使用当前数据，反映活动更新', () => {
    const snapshot = [event(1, '旧标题')]
    const updated = event(1, '新标题')

    expect(resolveCalendarMoreItems(snapshot, [updated])).toEqual([updated])
  })
})
