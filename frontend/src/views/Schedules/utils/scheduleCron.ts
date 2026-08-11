export type RepeatMode = 'interval' | 'daily' | 'weekday' | 'weekend' | 'custom'

export interface ParsedCron {
  mode: RepeatMode
  time: string
  startDate: string
  intervalMinutes?: number
}

export interface BuildCronInput {
  mode: RepeatMode
  time: string
  startDate?: string
  intervalMinutes?: number
  now?: Date
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dateIso(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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
  if (input.mode === 'custom') {
    const now = input.now ?? new Date()
    let date = input.startDate || ''
    if (!date) {
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0)
      if (next <= now) next.setDate(next.getDate() + 1)
      date = dateIso(next)
    }
    return `@once:${date}T${pad(hours)}:${pad(minutes)}`
  }

  const daysOfWeek: Record<Exclude<RepeatMode, 'interval' | 'custom'>, string> = {
    daily: '*',
    weekday: '1-5',
    weekend: '0,6',
  }
  return `${minutes} ${hours} * * ${daysOfWeek[input.mode] ?? '*'}`
}

export function parseCron(cron: string): ParsedCron {
  cron = cron || ''
  if (cron.startsWith('@once:')) {
    const iso = cron.slice(6)
    const [datePart, timePart] = iso.split('T')
    const [hours, minutes] = (timePart ?? '09:00').split(':')
    return {
      mode: 'custom',
      time: `${pad(Number(hours))}:${pad(Number(minutes))}`,
      startDate: datePart ?? '',
    }
  }

  const parts = cron.split(' ')
  if (parts.length !== 5) return { mode: 'daily', time: '09:00', startDate: '' }

  const [minute, hour, , , dayOfWeek] = parts
  const interval = minute.match(/^\*\/(\d+)$/)
  if (interval && hour === '*' && dayOfWeek === '*') {
    return {
      mode: 'interval',
      time: '09:00',
      startDate: '',
      intervalMinutes: Number(interval[1]),
    }
  }

  const time = `${pad(Number(hour))}:${pad(Number(minute))}`
  const mode: RepeatMode = dayOfWeek === '1-5' || dayOfWeek === '1,2,3,4,5'
    ? 'weekday'
    : dayOfWeek === '0,6' || dayOfWeek === '6,0'
      ? 'weekend'
      : 'daily'
  return { mode, time, startDate: '' }
}

export function cronLabel(cron: string): string {
  const parsed = parseCron(cron)
  if (parsed.mode === 'custom') return `${parsed.startDate} ${parsed.time}`
  if (parsed.mode === 'interval') return `每 ${parsed.intervalMinutes} 分钟`

  const labels: Record<Exclude<RepeatMode, 'interval' | 'custom'>, string> = {
    daily: '每天',
    weekday: '工作日',
    weekend: '周末',
  }
  return `${labels[parsed.mode] ?? '每天'} ${parsed.time}`
}
