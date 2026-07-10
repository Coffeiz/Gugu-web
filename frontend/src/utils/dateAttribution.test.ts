import { describe, it, expect } from 'vitest'
import { parseUtc, localDayKey, isSameLocalDay, isToday, isThisWeek, fmtLocalDateTime } from './dateAttribution'

// 全程显式传 tz + 注入 now，不依赖测试机时区，保证确定性。

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
