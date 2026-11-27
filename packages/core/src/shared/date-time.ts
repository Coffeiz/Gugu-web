export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
    return true
  } catch {
    return false
  }
}

export { dateKeyInTimeZone, startOfDateKeyInTimeZone } from '@gugu/scheduler/date-time'

/** 按 UTC 日历日移动 YYYY-MM-DD 日期键。 */
export function addUtcDaysToDateKey(dateKey: string, days: number): string {
  const shifted = new Date(`${dateKey}T00:00:00.000Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

/** 将时间格式化为 UTC ISO 字符串（+00:00 后缀）。 */
export function toUtcIsoWithOffset(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error('invalid timestamp')
  return date.toISOString().replace(/Z$/, '+00:00')
}
