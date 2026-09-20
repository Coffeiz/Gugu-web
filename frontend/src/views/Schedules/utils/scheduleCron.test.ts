// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildCron,
  combineScheduleDateTime,
  cronLabel,
  normalizeWeeklyDays,
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

  it('生成并解析每周任务（含旧版工作日/周末/单日 cron）', () => {
    expect(buildCron({ mode: 'daily', time: '09:05' })).toBe('5 9 * * *')
    expect(buildCron({ mode: 'weekly', time: '09:05', weeklyDays: [1, 2, 3, 4, 5] })).toBe('5 9 * * 1,2,3,4,5')
    expect(buildCron({ mode: 'weekly', time: '09:05', weeklyDays: [0, 6] })).toBe('5 9 * * 0,6')
    expect(buildCron({ mode: 'weekly', time: '09:05', weeklyDays: [5] })).toBe('5 9 * * 5')
    // 全选 7 天等价于每日
    expect(buildCron({ mode: 'weekly', time: '09:05', weeklyDays: [0, 1, 2, 3, 4, 5, 6] })).toBe('5 9 * * *')
    expect(parseCron('5 9 * * 1,2,3,4,5')).toEqual({ mode: 'weekly', time: '09:05', weeklyDays: [1, 2, 3, 4, 5] })
    expect(parseCron('5 9 * * 1-5')).toEqual({ mode: 'weekly', time: '09:05', weeklyDays: [1, 2, 3, 4, 5] })
    expect(parseCron('5 9 * * 6,0')).toEqual({ mode: 'weekly', time: '09:05', weeklyDays: [0, 6] })
    // 单个周几此前被误判为每日，必须解析为每周
    expect(parseCron('0 20 * * 5')).toEqual({ mode: 'weekly', time: '20:00', weeklyDays: [5] })
  })

  it('weekly 标签对人可读：单日「每周五」、多日斜杠分隔', () => {
    expect(cronLabel('0 20 * * 5')).toBe('每周五 20:00')
    expect(cronLabel('0 20 * * 1,3,5')).toBe('每周一/三/五 20:00')
    expect(cronLabel('5 9 * * *')).toBe('每日 09:05')
  })

  it('normalizeWeeklyDays 去重、7 归并为周日并拒绝非法值', () => {
    expect(normalizeWeeklyDays([5, 5, 3])).toEqual([3, 5])
    expect(normalizeWeeklyDays([7])).toEqual([0])
    expect(normalizeWeeklyDays([0, 7])).toEqual([0])
    expect(normalizeWeeklyDays([9, -1])).toBeNull()
    expect(normalizeWeeklyDays(undefined)).toBeNull()
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
    const input = { mode: 'weekly' as const, time: '09:05', weeklyDays: [5] }
    expect(buildCron(input)).toBe(buildCron(input))
    expect(parseCron(buildCron(input))).toEqual({ mode: 'weekly', time: '09:05', weeklyDays: [5] })
  })

  it('对空值、不完整格式和未知日期规则使用稳定默认值', () => {
    const fallback = { mode: 'daily', time: '09:00' }
    expect(parseCron('')).toEqual(fallback)
    expect(parseCron('*/5 * *')).toEqual(fallback)
    expect(parseCron('5 9 * * 1-x')).toEqual({ mode: 'daily', time: '09:05' })
  })

  it('构造和解析时间范围时按 Asia/Shanghai 与 API UTC 契约转换', () => {
    expect(combineScheduleDateTime('2026-09-05', '18:30')).toBe('2026-09-05T18:30:00')
    expect(combineScheduleDateTime('2026-09-05', '')).toBeNull()
    expect(splitScheduleDateTime('2026-09-05T10:30:00Z')).toEqual({ date: '2026-09-05', time: '18:30' })
    expect(scheduleDateTimeValue('2026-09-05', '18:30')).toBeLessThan(scheduleDateTimeValue('2026-09-05', '19:30')!)
  })
})
