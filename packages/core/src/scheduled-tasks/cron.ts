import { dateKeyInTimeZone, startOfDateKeyInTimeZone } from '../shared/date-time.js'

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
    if (range.length > 2 || range[0] === undefined) throw new RangeError('cron 范围非法')
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

const CRONTAB_WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const CRONTAB_WEEKDAY_NUMBERS: Readonly<Record<string, bigint>> = {
  sun: 0n,
  mon: 1n,
  tue: 2n,
  wed: 3n,
  thu: 4n,
  fri: 5n,
  sat: 6n,
}

const WEEKDAY_EXPRESSION = /^(\d+|sun|mon|tue|wed|thu|fri|sat)(?:-(\d+|sun|mon|tue|wed|thu|fri|sat))?$/

function integer(value: string): bigint {
  if (!/^[+-]?\d+$/.test(value)) throw new RangeError('星期步长必须是整数')
  return BigInt(value)
}

function weekdayNumber(value: string): bigint {
  if (/^\d+$/.test(value)) return BigInt(value)
  return CRONTAB_WEEKDAY_NUMBERS[value]!
}

function weekdayName(value: bigint): typeof CRONTAB_WEEKDAY_NAMES[number] {
  const index = Number(((value % 7n) + 7n) % 7n)
  return CRONTAB_WEEKDAY_NAMES[index]!
}

function appendRange(
  output: string[],
  start: bigint,
  endExclusive: bigint,
  step: bigint,
): void {
  if (step === 0n) throw new RangeError('星期步长不能为零')
  if (step > 0n) {
    for (let day = start; day < endExclusive; day += step) output.push(weekdayName(day))
    return
  }
  for (let day = start; day > endExclusive; day += step) output.push(weekdayName(day))
}

/**
 * 把标准 crontab 星期字段（0=周日）转换为 APScheduler 的星期名称。
 * 未识别的扩展语法原样保留，由调用方的 CronTrigger 负责校验。
 */
export function crontabWeekdayToApscheduler(crontabField: string): string {
  const translated: string[] = []
  for (const item of crontabField.toLowerCase().split(',')) {
    const slash = item.indexOf('/')
    const hasStep = slash >= 0
    const base = hasStep ? item.slice(0, slash) : item
    const stepText = hasStep ? item.slice(slash + 1) : ''

    if (base === '*') {
      if (!hasStep) {
        translated.push('*')
      } else {
        appendRange(translated, 0n, 7n, integer(stepText))
      }
      continue
    }

    const match = WEEKDAY_EXPRESSION.exec(base)
    if (!match) {
      translated.push(item)
      continue
    }

    const start = weekdayNumber(match[1]!)
    const end = match[2] === undefined
      ? (hasStep ? 6n : start)
      : weekdayNumber(match[2])
    appendRange(translated, start, end + 1n, hasStep ? integer(stepText) : 1n)
  }

  return [...new Set(translated)].join(',')
}

const validMonths = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']

const validWeekdays = ['mon','tue','wed','thu','fri','sat','sun']

/** 校验 APScheduler from_crontab 支持的五字段和范围。 */
export function validateTaskCron(expression: string): void {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new RangeError('cron 需要五个字段')
  const limits: Array<[number, number, string[]]> = [[0,59,[]],[0,23,[]],[1,31,[]],[1,12,validMonths],[0,6,validWeekdays]]
  fields.forEach((field, index) => {
    const [min, max, names] = limits[index]!
    const number = (value: string) => {
      const named = names.indexOf(value.toLowerCase())
      if (named >= 0) return named + min
      if (!/^\d+$/.test(value)) throw new RangeError('cron 字段非法')
      return Number(value)
    }
    for (const item of field.split(',')) {
      if (index === 2 && /^last/i.test(item)) continue
      // APScheduler 的名称字段解析器匹配前缀；后缀不参与步长解析。
      if (names.length) {
        const named = /^([a-z]+)(?:-([a-z]+))?/i.exec(item)
        if (named) {
          const first = names.indexOf(named[1]!.toLowerCase())
          const last = named[2] ? names.indexOf(named[2].toLowerCase()) : first
          if (first < 0 || last < 0 || first > last) throw new RangeError('cron 名称范围非法')
          continue
        }
      }
      const pieces = item.split('/')
      if (pieces.length > 2 || !pieces[0]) throw new RangeError('cron 字段非法')
      const range = pieces[0].split('-')
      if (range.length > 2 || !range[0]) throw new RangeError('cron 范围非法')
      const first = range[0] === '*' ? min : number(range[0])
      const last = range[0] === '*' ? max : range.length === 2 ? number(range[1]!) : pieces.length === 2 ? max : first
      if (range[0] === '*' && range.length > 1 || first < min || last > max || first > last) throw new RangeError('cron 范围非法')
      if (pieces.length === 2) {
        if (!/^\d+$/.test(pieces[1]!)) throw new RangeError('cron 步长非法')
        const step = Number(pieces[1])
        if (!Number.isSafeInteger(step) || step < 1 || step > (last || max) - first) throw new RangeError('cron 步长非法')
      }
    }
  })
}
