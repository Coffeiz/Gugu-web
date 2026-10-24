// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { browserDayKey, buildCalendarMonthDays, parseUtc, localDayKey, localDateTimeToUtcIso, isSameLocalDay, isToday, isThisWeek, fmtLocalDateTime } from '@/utils/dateAttribution'

// 全程显式传 tz + 注入 now，不依赖测试机时区，保证确定性。

describe('browserDayKey — 日期选择保持浏览器本地日历日期', () => {
  it.each([
    [new Date(2026, 0, 1, 0, 1), '2026-01-01'],
    [new Date(2026, 11, 31, 23, 59), '2026-12-31'],
    [new Date(2024, 1, 29, 12), '2024-02-29'],
    [new Date(2026, 0, 0, 12), '2025-12-31'],
  ])('保留本地日期 %s 为 %s', (date, expected) => {
    expect(browserDayKey(date)).toBe(expected)
  })
})

describe('buildCalendarMonthDays — 日期选择与月视图共用网格', () => {
  it('周日起始月在周一视图补齐前六天，周日视图不增加空白周', () => {
    const monday = buildCalendarMonthDays(new Date(2026, 1, 10), 1)
    const sunday = buildCalendarMonthDays(new Date(2026, 1, 10), 0)
    expect(monday).toHaveLength(35)
    expect(monday[0]).toMatchObject({ iso: '2026-01-26', date: 26, other: true, dow: 0 })
    expect(monday.at(-1)).toMatchObject({ iso: '2026-03-01', other: true, dow: 6 })
    expect(sunday).toHaveLength(28)
    expect(sunday[0]).toMatchObject({ iso: '2026-02-01', other: false, dow: 6 })
    expect(sunday.at(-1)?.iso).toBe('2026-02-28')
  })

  it.each([0, 1] as const)('起始星期 %s 下保留闰月全部日期、跨月补齐与稳定唯一 key', weekStart => {
    const days = buildCalendarMonthDays(new Date(2024, 1, 1), weekStart)
    expect(days.filter(day => !day.other)).toHaveLength(29)
    expect(days.find(day => day.iso === '2024-02-29')).toMatchObject({ date: 29, other: false })
    expect(days.length % 7).toBe(0)
    expect(new Set(days.map(day => day.key)).size).toBe(days.length)
    expect(new Set(days.map(day => day.iso)).size).toBe(days.length)
  })
})

describe('parseUtc — naive UTC 串不能被当本地时间', () => {
  it('无时区标记 → 当 UTC 解析', () => {
    expect(parseUtc('2026-07-11T08:00:00').getTime()).toBe(Date.parse('2026-07-11T08:00:00Z'))
  })
  it('带 Z → 原样', () => {
    expect(parseUtc('2026-07-11T08:00:00Z').getTime()).toBe(Date.parse('2026-07-11T08:00:00Z'))
  })
  it('带偏移 → 原样（换算成 UTC）', () => {
    expect(parseUtc('2026-07-11T08:00:00+08:00').getTime()).toBe(Date.parse('2026-07-11T00:00:00Z'))
  })
  it('纯日期 → UTC 零点', () => {
    expect(parseUtc('2026-07-11').getTime()).toBe(Date.parse('2026-07-11T00:00:00Z'))
  })
  it('空 → NaN', () => {
    expect(Number.isNaN(parseUtc('').getTime())).toBe(true)
    expect(Number.isNaN(parseUtc(null).getTime())).toBe(true)
  })
})

describe('localDayKey — 跨午夜按时区归属，不按 UTC', () => {
  it('UTC 20:00 在东八区是次日', () => {
    expect(localDayKey(new Date('2026-07-11T20:00:00Z'), 'Asia/Shanghai')).toBe('2026-07-12')
  })
  it('UTC 02:00 在纽约是前一日', () => {
    expect(localDayKey(new Date('2026-07-11T02:00:00Z'), 'America/New_York')).toBe('2026-07-10')
  })
  it('UTC 下即 UTC 日', () => {
    expect(localDayKey(new Date('2026-07-11T08:00:00Z'), 'UTC')).toBe('2026-07-11')
  })
})

describe('localDateTimeToUtcIso — 编辑记录日期时保留所选本地日', () => {
  it.each(['Asia/Tokyo', 'Pacific/Auckland', 'Pacific/Kiritimati'])(
    '%s 的本地中午换算后仍归属所选日期', (tz) => {
      const iso = localDateTimeToUtcIso('2026-10-15', tz)
      expect(iso).toMatch(/Z$/)
      expect(localDayKey(parseUtc(iso), tz)).toBe('2026-10-15')
    },
  )

  it('使用本地中午，且拒绝不存在的日历日期', () => {
    const iso = localDateTimeToUtcIso('2026-10-15', 'Pacific/Auckland')
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(parseUtc(iso))
    expect(parts.find(part => part.type === 'hour')?.value).toBe('12')
    expect(parts.find(part => part.type === 'minute')?.value).toBe('00')
    expect(() => localDateTimeToUtcIso('2026-02-30', 'UTC')).toThrow(RangeError)
  })
})

describe('isToday / isSameLocalDay — 时区正确性', () => {
  // 两个时刻都在 UTC 07-11，但东八区分属 07-11 / 07-12 → 不是同一天
  const nearMidnightPrev = new Date('2026-07-11T15:00:00Z')  // 上海 07-11 23:00
  const afterMidnight    = new Date('2026-07-11T16:30:00Z')  // 上海 07-12 00:30
  it('东八区跨午夜 → 不同一天（naive UTC 会误判为同一天）', () => {
    expect(isToday(nearMidnightPrev, 'Asia/Shanghai', afterMidnight)).toBe(false)
    expect(isSameLocalDay(nearMidnightPrev, afterMidnight, 'Asia/Shanghai')).toBe(false)
  })
  it('同样两个时刻在 UTC 口径下算同一天', () => {
    expect(isToday(nearMidnightPrev, 'UTC', afterMidnight)).toBe(true)
  })
})

describe('isThisWeek — 周一为起点（本地周）', () => {
  // 2026-07-06(一)…07-12(日) 是同一周；07-05(上周日)、07-13(下周一)在外
  const now = new Date('2026-07-08T12:00:00Z')  // 周三
  const at = (d: string) => new Date(`2026-07-${d}T12:00:00Z`)
  it('同周内为 true（含周一与周六）', () => {
    expect(isThisWeek(at('06'), 'UTC', now)).toBe(true)
    expect(isThisWeek(at('11'), 'UTC', now)).toBe(true)
  })
  it('上周日 / 下周一为 false', () => {
    expect(isThisWeek(at('05'), 'UTC', now)).toBe(false)
    expect(isThisWeek(at('13'), 'UTC', now)).toBe(false)
  })
})

describe('fmtLocalDateTime — 后端 ISO → 浏览器本地时间串', () => {
  it('格式 YYYY-MM-DD HH:MM', () => {
    expect(fmtLocalDateTime('2026-07-11T08:00:00Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
  it('seconds 选项带 :SS', () => {
    expect(fmtLocalDateTime('2026-07-11T08:00:00Z', { seconds: true })).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
  it('naive ISO 也当 UTC（与带 Z 同一时刻）', () => {
    expect(fmtLocalDateTime('2026-07-11T08:00:00')).toBe(fmtLocalDateTime('2026-07-11T08:00:00Z'))
  })
  it('空 / 无效 → 空串', () => {
    expect(fmtLocalDateTime(null)).toBe('')
    expect(fmtLocalDateTime('')).toBe('')
    expect(fmtLocalDateTime('garbage')).toBe('')
  })
})
