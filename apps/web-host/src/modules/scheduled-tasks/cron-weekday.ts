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
