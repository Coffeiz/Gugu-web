import { dateKeyInTimeZone, startOfDateKeyInTimeZone } from '../../shared/date-time.js'
import { crontabWeekdayToApscheduler } from './cron-weekday.js'

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const zone = 'Asia/Shanghai'
const minuteMs = 60_000
const dayMs = 86_400_000
const shanghaiParts = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
})

function fieldMatches(expression: string, value: number, min: number, max: number, names: string[] = []): boolean {
  const number = (text: string) => {
    const index = names.indexOf(text.toLowerCase())
    if (index >= 0) return index + min
    if (!/^\d+$/.test(text)) throw new RangeError('cron 字段非法')
    return Number(text)
  }
  let matched = false
  for (const part of expression.split(',')) {
    // APScheduler 的符号范围只消费名称前缀；其后缀不表示数值步长。
    const named = names.length ? /^[a-z]+(?:-[a-z]+)?/iu.exec(part) : null
    const pieces = (named?.[0] ?? part).split('/')
    if (pieces.length > 2 || !pieces[0]) throw new RangeError('cron 字段非法')
    const step = pieces[1] === undefined ? 1 : number(pieces[1])
    if (!Number.isSafeInteger(step) || step < 1) throw new RangeError('cron 步长非法')
    const range = pieces[0].split('-')
    if (range.length > 2) throw new RangeError('cron 范围非法')
    const start = range[0] === '*' ? min : number(range[0])
    const end = range[0] === '*' ? max : range[1] !== undefined ? number(range[1]) : pieces[1] !== undefined ? max : start
    if (start < min || end > max || start > end) throw new RangeError('cron 范围非法')
    if (value >= start && value <= end && (value - start) % step === 0) matched = true
  }
  return matched
}

function values(expression: string, min: number, max: number, names?: string[]): ReadonlySet<number> {
  return new Set(Array.from({ length: max - min + 1 }, (_, index) => min + index)
    .filter(value => fieldMatches(expression, value, min, max, names)))
}

function compile(expression: string) {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) throw new RangeError('cron 需要五个字段')
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string]
  const days = day.split(',')
  const numericDays = days.filter(value => !/^last/iu.test(value))
  const weekdaysAllowed = values(crontabWeekdayToApscheduler(weekday), 0, 6, weekdays)
  return {
    minutes: values(minute, 0, 59),
    hours: values(hour, 0, 23),
    days: numericDays.length ? values(numericDays.join(','), 1, 31) : new Set<number>(),
    lastDay: numericDays.length < days.length,
    months: values(month, 1, 12, months),
    weekdays: weekdaysAllowed,
  }
}

function dateMatches(cron: ReturnType<typeof compile>, date: Date): boolean {
  const month = date.getUTCMonth() + 1
  if (!cron.months.has(month) || !cron.weekdays.has(date.getUTCDay())) return false
  return cron.days.has(date.getUTCDate())
    || cron.lastDay && date.getUTCDate() === new Date(Date.UTC(date.getUTCFullYear(), month, 0)).getUTCDate()
}

function timeMatches(cron: ReturnType<typeof compile>, instant: number): boolean {
  const parts = Object.fromEntries(shanghaiParts.formatToParts(new Date(instant)).map(part => [part.type, part.value]))
  return cron.hours.has(Number(parts.hour)) && cron.minutes.has(Number(parts.minute))
}

/** 判断 UTC 时间所在分钟是否匹配 Asia/Shanghai 的五字段 cron。 */
export function matchesCronMinute(expression: string, instant: number): boolean {
  if (!Number.isFinite(instant)) throw new RangeError('cron 时间非法')
  const cron = compile(expression)
  const local = new Date(dateKeyInTimeZone(new Date(instant), zone))
  return dateMatches(cron, local) && timeMatches(cron, instant)
}

/** 按上海日历日跳过不匹配的日期，仅在候选日内逐分钟处理时区偏移。 */
export function nextCronFire(expression: string, from: number, endAt: number | null): number | null {
  if (!Number.isFinite(from) || endAt !== null && !Number.isFinite(endAt)) throw new RangeError('cron 时间非法')
  if (endAt !== null && from > endAt) return null
  const cron = compile(expression)
  const first = Date.parse(dateKeyInTimeZone(new Date(from), zone))
  // 公历的日期与星期每 400 年循环。没有任何可匹配日期时不会无限查找。
  const calendarEnd = Math.min(first + 146_097 * dayMs, endAt === null ? Infinity : endAt + dayMs)
  for (let day = first; day <= calendarEnd; day += dayMs) {
    const date = new Date(day)
    if (!dateMatches(cron, date)) continue
    const begin = startOfDateKeyInTimeZone(date.toISOString().slice(0, 10), zone).getTime()
    const end = startOfDateKeyInTimeZone(new Date(day + dayMs).toISOString().slice(0, 10), zone).getTime()
    for (let time = Math.ceil(Math.max(begin, from) / minuteMs) * minuteMs;
      time < end && (endAt === null || time <= endAt); time += minuteMs) {
      if (timeMatches(cron, time)) return time
    }
  }
  return null
}
