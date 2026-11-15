import { crontabWeekdayToApscheduler } from './cron-weekday.js'

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const shanghaiParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', weekday: 'short', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
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
    const pieces = part.split('/')
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

/** 判断 UTC 时间所在分钟是否匹配 Asia/Shanghai 的五字段 cron。 */
export function matchesCronMinute(expression: string, instant: number): boolean {
  if (!Number.isFinite(instant)) throw new RangeError('cron 时间非法')
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new RangeError('cron 需要五个字段')
  const parts = Object.fromEntries(shanghaiParts.formatToParts(new Date(instant)).map(part => [part.type, part.value]))
  // 即使前面的字段不匹配，也检查所有字段，避免非法表达式被短路隐藏。
  const matches = [
    fieldMatches(fields[0], Number(parts.minute), 0, 59),
    fieldMatches(fields[1], Number(parts.hour), 0, 23),
    fieldMatches(fields[2], Number(parts.day), 1, 31),
    fieldMatches(fields[3], Number(parts.month), 1, 12, months),
    fieldMatches(crontabWeekdayToApscheduler(fields[4]), weekdays.indexOf(parts.weekday.toLowerCase()), 0, 6, weekdays),
  ]
  return matches.every(Boolean)
}
