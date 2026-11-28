import { localDayKey, parseUtc } from './dateAttribution'
import { effectiveTimezone } from './userTimezone'

/** 文件创建时间统一按查看者时区显示日期；兼容历史缓存中的 date-only 值。 */
export function formatFileCreatedDate(value: string | null | undefined, timeZone = effectiveTimezone()): string {
  if (!value) return ''
  if (!value.includes('T')) return value.slice(0, 10)

  const instant = parseUtc(value)
  return Number.isNaN(instant.getTime()) ? value.slice(0, 10) : localDayKey(instant, timeZone)
}
