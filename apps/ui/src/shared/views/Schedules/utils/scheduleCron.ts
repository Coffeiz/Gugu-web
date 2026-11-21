import { i18n } from '@/i18n'

export type RepeatMode = 'once' | 'interval' | 'daily' | 'weekly'

export interface ParsedCron {
  mode: RepeatMode
  time: string
  intervalMinutes?: number
  /** weekly 模式选中的周几（0=周日 … 6=周六），升序去重 */
  weeklyDays?: number[]
}

export interface BuildCronInput {
  mode: Exclude<RepeatMode, 'once'>
  time: string
  intervalMinutes?: number
  weeklyDays?: number[]
}

export interface ScheduleDateTimeParts {
  date: string
  time: string
}

const SCHEDULE_TIME_ZONE = 'Asia/Shanghai'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function timeParts(time: string): [number, number] {
  const [hours, minutes] = time.split(':').map(Number)
  return [hours, minutes]
}

/** 规整周几集合：去重、7 归并为 0（周日）、只保留 0-6、升序；全选 7 天视为每天。 */
export function normalizeWeeklyDays(days: number[] | undefined | null): number[] | null {
  const set = new Set((days || [])
    .map(day => Number(day))
    .filter(day => Number.isInteger(day))
    .map(day => (day === 7 ? 0 : day))
    .filter(day => day >= 0 && day <= 6))
  if (set.size === 0 || set.size === 7) return null
  return [...set].sort((a, b) => a - b)
}

function expandDayField(field: string): number[] {
  const days: number[] = []
  for (const part of field.split(',')) {
    const range = part.match(/^(\d+)-(\d+)$/)
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])]
      for (let day = start; day <= end; day++) days.push(day)
    } else if (/^\d+$/.test(part)) {
      days.push(Number(part))
    } else {
      return []
    }
  }
  return days
}

export function buildCron(input: BuildCronInput): string {
  if (input.mode === 'interval') {
    const minutes = Math.min(60, Math.max(1, Math.round(Number(input.intervalMinutes) || 5)))
    return `*/${minutes} * * * *`
  }

  const [hours, minutes] = timeParts(input.time)
  if (input.mode === 'weekly') {
    const days = normalizeWeeklyDays(input.weeklyDays)
    if (days) return `${minutes} ${hours} * * ${days.join(',')}`
    return `${minutes} ${hours} * * *`
  }
  return `${minutes} ${hours} * * *`
}

export function parseCron(cron: string): ParsedCron {
  cron = cron || ''

  const parts = cron.split(' ')
  if (parts.length !== 5) return { mode: 'daily', time: '09:00' }

  const [minute, hour, , , dayOfWeek] = parts
  const interval = minute.match(/^\*\/(\d+)$/)
  if (interval && hour === '*' && dayOfWeek === '*') {
    return {
      mode: 'interval',
      time: '09:00',
      intervalMinutes: Number(interval[1]),
    }
  }

  const time = `${pad(Number(hour))}:${pad(Number(minute))}`
  if (dayOfWeek && dayOfWeek !== '*') {
    const days = normalizeWeeklyDays(expandDayField(dayOfWeek))
    if (days) return { mode: 'weekly', time, weeklyDays: days }
  }
  return { mode: 'daily', time }
}

/** 将 API 返回的 UTC 时间转换为定时任务表单使用的项目时区（Asia/Shanghai）。 */
export function splitScheduleDateTime(iso: string | null | undefined): ScheduleDateTimeParts {
  if (!iso) return { date: '', time: '' }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return { date: '', time: '' }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHEDULE_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  }
}

/** API 接收的是不带时区的本地 ISO；后端按 Asia/Shanghai 解释后保存为 UTC。 */
export function combineScheduleDateTime(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null
  return `${date}T${time}:00`
}

export function scheduleDateTimeValue(date: string, time: string): number | null {
  const iso = combineScheduleDateTime(date, time)
  if (!iso) return null
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const value = Date.UTC(year, month - 1, day, hour - 8, minute)
  return Number.isFinite(value) ? value : null
}

function weekdayNames(): string[] {
  const names = (i18n.global.tm as (key: string) => unknown)('sharedUi.weekdays')
  return Array.isArray(names) ? names.map(name => String(name)) : []
}

export function cronLabel(cron: string): string {
  const t = i18n.global.t
  const parsed = parseCron(cron)
  if (parsed.mode === 'once') return t('schedules.once')
  if (parsed.mode === 'interval') return t('schedules.everyMinutes', { minutes: parsed.intervalMinutes })

  if (parsed.mode === 'weekly' && parsed.weeklyDays?.length) {
    const names = weekdayNames()
    const label = parsed.weeklyDays.map(day => names[day] ?? String(day)).join('/')
    return t('schedules.weeklyLabel', { days: label, time: parsed.time })
  }
  return `${t('schedules.daily')} ${parsed.time}`
}
