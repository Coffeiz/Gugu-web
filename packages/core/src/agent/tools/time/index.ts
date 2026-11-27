import type { RunIdentity } from '../../models.js'
import type { ToolDefinition } from '../contracts.js'

export interface ToolClock { now(): Date; timezone(identity: RunIdentity): Promise<string> }

/** 当前请求的可信本地时间；时间与近期待办工具共用同一时区规则。 */
export async function readToolClock(options: ToolClock, identity: RunIdentity, signal: AbortSignal) {
  const timezone = await options.timezone(identity)
  signal.throwIfAborted()
  const current = options.now()
  // Python 本机固定偏移名包含 UTC 前缀；Intl 的偏移标识不接受该前缀。
  const intlTimezone = /^UTC[+-]\d{2}:\d{2}$/u.test(timezone) ? timezone.slice(3) : timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: intlTimezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(current)
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const weekdays: Record<string, string> = { Mon: '一', Tue: '二', Wed: '三', Thu: '四', Fri: '五', Sat: '六', Sun: '日' }
  const date = `${fields.year}-${fields.month}-${fields.day}`
  const time = `${fields.hour}:${fields.minute}:${fields.second}`
  return {
    date, weekday: `星期${weekdays[fields.weekday!]}`, time, datetime: `${date} ${time}`, timezone,
  }
}

/** 时钟与用户时区来自可信请求上下文，不能由模型参数覆盖。 */
export function createTimeTool(options: ToolClock): ToolDefinition {
  return {
    definition: { name: 'get_current_time', schema: { type: 'function', function: {
      name: 'get_current_time', description: '获取当前日期、星期和时间。',
      parameters: { type: 'object', properties: {} },
    } } },
    effect: 'read',
    validate(input) {
      return input !== null && typeof input === 'object' && !Array.isArray(input)
        ? { success: true, data: {} } : { success: false }
    },
    async execute(_input, scope) {
      return { kind: 'completed', successful: true, mutated: false, value: await readToolClock(options, scope.identity, scope.signal) }
    },
  }
}
