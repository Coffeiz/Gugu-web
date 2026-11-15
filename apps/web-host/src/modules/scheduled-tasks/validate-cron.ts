const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
const weekdays = ['mon','tue','wed','thu','fri','sat','sun']

/** 校验 APScheduler from_crontab 支持的五字段和范围。 */
export function validateTaskCron(expression: string): void {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new RangeError('cron 需要五个字段')
  const limits: Array<[number, number, string[]]> = [[0,59,[]],[0,23,[]],[1,31,[]],[1,12,months],[0,6,weekdays]]
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
