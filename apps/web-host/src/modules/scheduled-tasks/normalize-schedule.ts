import { ScheduleValidationError } from './schedule-status.js'

export interface ScheduleInput { schedule_kind: string; cron?: string | null; interval_minutes?: number | null; start_at?: string | null; end_at?: string | null }
export interface ScheduleSpec { schedule_kind: string; cron: string; interval_minutes: number | null; start_at: Date | null; end_at: Date | null }
const preciseTimestamp = Symbol('scheduleTimestamp')
const preciseMicroseconds = Symbol('scheduleMicroseconds')
type PreciseDate = Date & { [preciseTimestamp]?: string; [preciseMicroseconds]?: bigint }
const micros = (value: Date) => (value as PreciseDate)[preciseMicroseconds] ?? BigInt(value.getTime()) * 1000n
export const scheduleMicroseconds = micros
const shanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
/** 将 UTC 瞬间投影为上海墙上时间的 UTC 数值，供比较本地日历时间。 */
export function shanghaiWallMilliseconds(value: Date): number {
  const parts = Object.fromEntries(shanghai.formatToParts(value).map(part => [part.type, Number(part.value)]))
  const wall = new Date(0)
  wall.setUTCFullYear(parts.year!, parts.month! - 1, parts.day!)
  wall.setUTCHours(parts.hour!, parts.minute!, parts.second!, value.getUTCMilliseconds())
  return wall.getTime()
}
function shanghaiWallTime(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const wall = new Date(0)
  wall.setUTCFullYear(year, month - 1, day)
  wall.setUTCHours(hour, minute, second, 0)
  const target = wall.getTime()
  const offsetAt = (at: number) => {
    const parts = Object.fromEntries(shanghai.formatToParts(new Date(at)).map(part => [part.type, Number(part.value)]))
    const projected = new Date(0)
    projected.setUTCFullYear(parts.year!, parts.month! - 1, parts.day!)
    projected.setUTCHours(parts.hour!, parts.minute!, parts.second!, 0)
    return projected.getTime() - at
  }
  const before = offsetAt(target - 172_800_000), after = offsetAt(target + 172_800_000)
  const candidates = [...new Set([before, after])].map(offset => target - offset).filter(at => at + offsetAt(at) === target)
  // Python 的 fold=0 在重叠时取较早瞬间，在缺口中沿用转换前偏移。
  return candidates.length ? Math.min(...candidates) : target - before
}
/** PostgreSQL 参数保留输入微秒，避免 Date 的毫秒精度丢失。 */
export function scheduleTimestamp(value: Date | null): string | null {
  if (!value) return null
  return (value as PreciseDate)[preciseTimestamp] ?? value.toISOString().replace('.000Z', 'Z')
}

/** cron 校验由完整 APScheduler 兼容实现注入，不以部分解析器静默接受表达式。 */
export function normalizeSchedule(input: ScheduleInput, validateCron: (cron: string) => void, now = Date.now()): ScheduleSpec {
  const kind = input.schedule_kind
  if (!['once', 'cron', 'interval'].includes(kind)) throw new ScheduleValidationError('schedule_kind 只能是 cron、interval 或 once', 'schedule_kind')
  const date = (value: string | null | undefined, field: string) => {
    if (value == null || value === '') return null
    if (typeof value !== 'string') throw new ScheduleValidationError(`${field} 必须是合法的 ISO 日期时间`, field)
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:\d{2})?$/i.exec(value)
    if (!match) throw new ScheduleValidationError(`${field} 必须是合法的 ISO 日期时间`, field)
    const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', offset] = match
    const check = new Date(0)
    check.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
    if (Number(year) < 1 || check.getUTCFullYear() !== Number(year) || check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)
      throw new ScheduleValidationError(`${field} 必须是合法的 ISO 日期时间`, field)
    const normalized = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? `.${fraction.slice(0, 3)}` : ''}${offset ?? 'Z'}`
    const time = offset ? Date.parse(normalized) : shanghaiWallTime(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second)) + Number(`${fraction}000`.slice(0, 3))
    if (!Number.isFinite(time)) throw new ScheduleValidationError(`${field} 必须是合法的 ISO 日期时间`, field)
    const result = new Date(time) as PreciseDate
    const micro = `${fraction}000000`.slice(0, 6)
    const iso = result.toISOString()
    const precise = micro === '000000' ? iso.replace('.000Z', 'Z') : `${iso.slice(0, 20)}${micro}Z`
    Object.defineProperty(result, preciseTimestamp, { value: precise })
    Object.defineProperty(result, preciseMicroseconds, { value: BigInt(time) * 1000n + BigInt(micro.slice(3)) })
    return result
  }
  const start = date(input.start_at, 'start_at'), end = date(input.end_at, 'end_at')
  if (start && end && micros(end) < micros(start)) throw new ScheduleValidationError('end_at 不能早于 start_at', 'end_at')
  if (kind === 'once') {
    if (input.cron) throw new ScheduleValidationError('once 类型不能设置 cron', 'cron')
    if (input.interval_minutes != null) throw new ScheduleValidationError('once 类型不能设置 interval_minutes', 'interval_minutes')
    if (!start) throw new ScheduleValidationError('once 类型必须设置 start_at', 'start_at')
    if (micros(start) <= BigInt(Math.trunc(now)) * 1000n) throw new ScheduleValidationError('once 任务的 start_at 必须晚于当前时间', 'start_at')
    if (end) throw new ScheduleValidationError('once 类型不能设置 end_at', 'end_at')
    return { schedule_kind: kind, cron: `@once:${scheduleTimestamp(start)!.replace('Z', '+00:00')}`, interval_minutes: null, start_at: start, end_at: null }
  }
  if (kind === 'cron') {
    if (input.interval_minutes != null) throw new ScheduleValidationError('cron 类型不能设置 interval_minutes', 'interval_minutes')
    if (!input.cron) throw new ScheduleValidationError('cron 类型必须设置 cron', 'cron')
    try { validateCron(input.cron) } catch { throw new ScheduleValidationError('cron 表达式非法（格式“分 时 日 月 周”）', 'cron') }
    if (end && micros(end) <= BigInt(Math.trunc(now)) * 1000n && !start) throw new ScheduleValidationError('仅设置 end_at 时，end_at 必须晚于当前时间', 'end_at')
    return { schedule_kind: kind, cron: input.cron, interval_minutes: null, start_at: start, end_at: end }
  }
  if (input.cron) throw new ScheduleValidationError('interval 类型不能设置 cron', 'cron')
  const interval = input.interval_minutes
  if (!Number.isInteger(interval)) throw new ScheduleValidationError('interval_minutes 必须是整数', 'interval_minutes')
  if (interval! < 1 || interval! > 60) throw new ScheduleValidationError('interval_minutes 必须在 1 到 60 之间', 'interval_minutes')
  if (end && micros(end) <= BigInt(Math.trunc(now)) * 1000n && !start) throw new ScheduleValidationError('仅设置 end_at 时，end_at 必须晚于当前时间', 'end_at')
  return { schedule_kind: kind, cron: `*/${interval} * * * *`, interval_minutes: interval!, start_at: start, end_at: end }
}
