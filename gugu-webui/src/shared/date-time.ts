/** 将日期格式化为指定时区下的 YYYY-MM-DD 日期键。 */
export function dateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year!.padStart(4, '0')}-${values.month!}-${values.day!}`
}

/** 按 UTC 日历日移动 YYYY-MM-DD 日期键。 */
export function addUtcDaysToDateKey(dateKey: string, days: number): string {
  const shifted = new Date(`${dateKey}T00:00:00.000Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

/** 获取日期键在指定时区中的本地零点。 */
export function startOfDateKeyInTimeZone(dateKey: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number)
  const target = Date.UTC(year!, month! - 1, day!)
  let guess = target
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess))
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]))
    guess += target - Date.UTC(
      values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!,
    )
  }
  return new Date(guess)
}

/** 将时间格式化为 UTC ISO 字符串（+00:00 后缀）。 */
export function toUtcIsoWithOffset(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new Error('invalid timestamp')
  return date.toISOString().replace(/Z$/, '+00:00')
}
