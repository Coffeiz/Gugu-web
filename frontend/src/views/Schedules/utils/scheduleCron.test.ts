import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildCron,
  combineScheduleDateTime,
  cronLabel,
  parseCron,
  scheduleDateTimeValue,
  splitScheduleDateTime,
} from './scheduleCron'
import { setLocale } from '@/i18n'

beforeEach(() => setLocale('zh-CN'))

describe('scheduleCron', () => {
  it('生成并解析间隔任务', () => {
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 5 })).toBe('*/5 * * * *')
    expect(parseCron('*/5 * * * *')).toEqual({
      mode: 'interval', time: '09:00', intervalMinutes: 5,
    })
    expect(cronLabel('*/5 * * * *')).toBe('每 5 分钟')
  })

  it('生成每日、工作日和周末任务', () => {
    expect(buildCron({ mode: 'daily', time: '09:05' })).toBe('5 9 * * *')
    expect(buildCron({ mode: 'weekday', time: '09:05' })).toBe('5 9 * * 1-5')
    expect(buildCron({ mode: 'weekend', time: '09:05' })).toBe('5 9 * * 0,6')
    expect(parseCron('5 9 * * 1,2,3,4,5').mode).toBe('weekday')
    expect(parseCron('5 9 * * 6,0').mode).toBe('weekend')
  })

  it('限制间隔分钟并对非法 Cron 使用默认规则', () => {
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 0 })).toBe('*/5 * * * *')
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 120 })).toBe('*/60 * * * *')
    expect(parseCron('')).toEqual({ mode: 'daily', time: '09:00' })
    expect(parseCron('not-a-cron')).toEqual({ mode: 'daily', time: '09:00' })
  })

  it('覆盖最小和最大间隔，并保持同一输入结果稳定', () => {
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 1 })).toBe('*/1 * * * *')
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 60 })).toBe('*/60 * * * *')
    const input = { mode: 'weekday' as const, time: '09:05' }
    expect(buildCron(input)).toBe(buildCron(input))
    expect(parseCron(buildCron(input))).toEqual({ mode: 'weekday', time: '09:05' })
  })

  it('对空值、不完整格式和未知日期规则使用稳定默认值', () => {
    const fallback = { mode: 'daily', time: '09:00' }
    expect(parseCron('')).toEqual(fallback)
    expect(parseCron('*/5 * *')).toEqual(fallback)
    expect(parseCron('5 9 * * 2')).toEqual({ mode: 'daily', time: '09:05' })
  })

  it('构造和解析时间范围时按 Asia/Shanghai 与 API UTC 契约转换', () => {
    expect(combineScheduleDateTime('2026-09-05', '18:30')).toBe('2026-09-05T18:30:00')
    expect(combineScheduleDateTime('2026-09-05', '')).toBeNull()
    expect(splitScheduleDateTime('2026-09-05T10:30:00Z')).toEqual({ date: '2026-09-05', time: '18:30' })
    expect(scheduleDateTimeValue('2026-09-05', '18:30')).toBeLessThan(scheduleDateTimeValue('2026-09-05', '19:30')!)
  })
})
