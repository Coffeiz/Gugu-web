import { describe, expect, it } from 'vitest'
import type { CalendarRenderItem } from '../domain/calendarTypes'
import {
  capWeekBars,
  dayLayout,
  maxSlots,
  timedLayoutFor,
  weekBars,
  type CalendarLayoutConstants,
} from './calendarLayout'

const constants: CalendarLayoutConstants = {
  headerHeight: 32,
  cellTop: 31,
  bottomPadding: 8,
  barHeight: 20,
  hourHeight: 48,
}

function project(id: string, startDate: string, endDate: string, extra: Partial<CalendarRenderItem> = {}): CalendarRenderItem {
  return {
    id,
    name: id,
    accent: '#7b7fb2',
    calendarType: 'project',
    status: 'active',
    startDate,
    endDate,
    ...extra,
  }
}

function event(id: string, date: string, time: string, endTime: string): CalendarRenderItem {
  return { id, name: id, date, time, endTime, accent: '#7ab8c8', calendarType: 'event' }
}

const week = [1, 2, 3, 4, 5, 6, 7].map(day => ({ iso: `2026-08-0${day}` }))

describe('calendarLayout', () => {
  it('计算跨天项目分行并保持输入不变', () => {
    const input = [
      project('a', '2026-08-01', '2026-08-03'),
      project('b', '2026-08-02', '2026-08-04'),
    ]
    const snapshot = structuredClone(input)

    const result = weekBars(input, week)

    expect(input).toEqual(snapshot)
    expect(result.map(item => [item.id, item.colStart, item.colEnd, item.row])).toEqual([
      ['a', 0, 2, 0],
      ['b', 1, 3, 1],
    ])
    expect(weekBars(input, week)).toEqual(result)
  })

  it('按最大行数截断项目条', () => {
    const bars = weekBars([
      project('a', '2026-08-01', '2026-08-03'),
      project('b', '2026-08-02', '2026-08-04'),
    ], week)
    expect(maxSlots(80, constants)).toBe(2)
    expect(capWeekBars(bars, 1).map(item => item.id)).toEqual(['a'])
  })

  it('布局单日 chip 和隐藏项目时返回更多项', () => {
    const bars = weekBars([
      project('a', '2026-08-01', '2026-08-03'),
      project('b', '2026-08-02', '2026-08-04'),
    ], week)
    const result = dayLayout(
      '2026-08-02',
      capWeekBars(bars, 1),
      bars,
      [project('single', '2026-08-02', '2026-08-02')],
      [event('event', '2026-08-02', '', '')],
      2,
      constants,
    )

    expect(result.paddingTop).toBe(21)
    expect(result.moreCount).toBe(3)
    expect(result.moreItems.map(item => item.id)).toEqual(['b', 'single', 'event'])
  })

  it('按重叠聚簇计算周视图时间活动列', () => {
    const input = [
      event('a', '2026-08-02', '09:00', '10:00'),
      event('b', '2026-08-02', '09:30', '10:30'),
      event('c', '2026-08-02', '11:00', '12:00'),
    ]
    const snapshot = structuredClone(input)
    const result = timedLayoutFor(input, '2026-08-02', 48)

    expect(input).toEqual(snapshot)
    expect(result.map(item => [item.ev.id, item.leftPct, item.widthPct])).toEqual([
      ['a', 0, 50],
      ['b', 50, 50],
      ['c', 0, 100],
    ])
    expect(timedLayoutFor(input, '2026-08-02', 48)).toEqual(result)
  })
})
