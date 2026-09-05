import { i18n } from '@/i18n'

export type RepeatMode = 'once' | 'interval' | 'daily' | 'weekday' | 'weekend'

export interface ParsedCron {
  mode: RepeatMode
  time: string
  intervalMinutes?: number
}

export interface BuildCronInput {
  mode: Exclude<RepeatMode, 'once'>
  time: string
  intervalMinutes?: number
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

export function buildCron(input: BuildCronInput): string {
  if (input.mode === 'interval') {
    const minutes = Math.min(60, Math.max(1, Math.round(Number(input.intervalMinutes) || 5)))
    return `*/${minutes} * * * *`
  }

  const [hours, minutes] = timeParts(input.time)
  const daysOfWeek: Record<Exclude<RepeatMode, 'interval' | 'once'>, string> = {
    daily: '*',
    weekday: '1-5',
    weekend: '0,6',
  }
  return `${minutes} ${hours} * * ${daysOfWeek[input.mode] ?? '*'}`
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
  const mode: RepeatMode = dayOfWeek === '1-5' || dayOfWeek === '1,2,3,4,5'
    ? 'weekday'
    : dayOfWeek === '0,6' || dayOfWeek === '6,0'
      ? 'weekend'
      : 'daily'
  return { mode, time }
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

export function cronLabel(cron: string): string {
  const t = i18n.global.t
  const parsed = parseCron(cron)
  if (parsed.mode === 'once') return t('schedules.once')
  if (parsed.mode === 'interval') return t('schedules.everyMinutes', { minutes: parsed.intervalMinutes })

  const labels: Record<Exclude<RepeatMode, 'interval' | 'once'>, string> = {
    daily: t('schedules.daily'),
    weekday: t('schedules.weekday'),
    weekend: t('schedules.weekend'),
  }
  return `${labels[parsed.mode] ?? t('schedules.daily')} ${parsed.time}`
}
