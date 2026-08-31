import { beforeEach, describe, expect, it } from 'vitest'
import { buildCron, cronLabel, parseCron } from './scheduleCron'
import { setLocale } from '@/i18n'

beforeEach(() => setLocale('zh-CN'))

describe('scheduleCron', () => {
  it('生成并解析间隔任务', () => {
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 5 })).toBe('*/5 * * * *')
    expect(parseCron('*/5 * * * *')).toEqual({
      mode: 'interval', time: '09:00', startDate: '', intervalMinutes: 5,
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

  it('保留单次任务日期和补零时间', () => {
    const cron = buildCron({ mode: 'custom', time: '9:05', startDate: '2026-08-12' })
    expect(cron).toBe('@once:2026-08-12T09:05')
    expect(parseCron(cron)).toEqual({
      mode: 'custom', time: '09:05', startDate: '2026-08-12',
    })
    expect(cronLabel(cron)).toBe('2026-08-12 09:05')
  })

  it('单次任务没有日期时选择今天或明天', () => {
    const beforeTime = new Date(2026, 7, 11, 8, 0, 0)
    const afterTime = new Date(2026, 7, 11, 10, 0, 0)
    expect(buildCron({ mode: 'custom', time: '09:00', now: beforeTime }))
      .toBe('@once:2026-08-11T09:00')
    expect(buildCron({ mode: 'custom', time: '09:00', now: afterTime }))
      .toBe('@once:2026-08-12T09:00')
  })

  it('限制间隔分钟并对非法 Cron 使用默认规则', () => {
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 0 })).toBe('*/5 * * * *')
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 120 })).toBe('*/60 * * * *')
    expect(parseCron('')).toEqual({ mode: 'daily', time: '09:00', startDate: '' })
    expect(parseCron('not-a-cron')).toEqual({ mode: 'daily', time: '09:00', startDate: '' })
  })

  it('覆盖最小和最大间隔，并保持同一输入结果稳定', () => {
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 1 })).toBe('*/1 * * * *')
    expect(buildCron({ mode: 'interval', time: '09:00', intervalMinutes: 60 })).toBe('*/60 * * * *')
    const input = { mode: 'weekday' as const, time: '09:05' }
    expect(buildCron(input)).toBe(buildCron(input))
    expect(parseCron(buildCron(input))).toEqual({ mode: 'weekday', time: '09:05', startDate: '' })
  })

  it('对空值、不完整格式和未知日期规则使用稳定默认值', () => {
    const fallback = { mode: 'daily', time: '09:00', startDate: '' }
    expect(parseCron('')).toEqual(fallback)
    expect(parseCron('*/5 * *')).toEqual(fallback)
    expect(parseCron('5 9 * * 2')).toEqual({ mode: 'daily', time: '09:05', startDate: '' })
    expect(parseCron('@once:2026-08-12')).toEqual({
      mode: 'custom', time: '09:00', startDate: '2026-08-12',
    })
  })
})
