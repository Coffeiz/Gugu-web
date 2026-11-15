import { z } from 'zod'
import { strip } from '../../shared/values.js'
import { asciiDecimalDigits } from '../../shared/unicode-decimal.js'
import type { createAgentCalendarReader } from '../../calendar/application/event-read.js'
import type { ToolDefinition } from './contracts.js'

const schema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  type: z.enum(['event', 'deadline']).optional() }).passthrough()

/** 日历组工具委托共享活动+提醒用例，模型不提供owner或平台投递凭据。 */
export function createListEventsTool(list: ReturnType<typeof createAgentCalendarReader>): ToolDefinition {
  return {
    definition: { name: 'list_events', schema: { type: 'function', function: { name: 'list_events',
      description: '查询日历事件，可按日期范围和类型筛选；from/to 传日期字符串。每个活动都会带 reminders 数组，元素可直接用于 update_event 的完整提醒配置。用户查看日程且结果跨至少 3 个日期并有至少 4 项活动时，首轮答复默认附 Mermaid timeline；单日或少量活动用清单，图表日期和时间必须来自查询结果。',
      parameters: { type: 'object', properties: { from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        type: { type: 'string', enum: ['event', 'deadline'], 'x-empty-string': 'omit' } } } } } },
    effect: 'read', validate(input) { return schema.safeParse(input) },
    async execute(input, scope) {
      const args = input as z.infer<typeof schema>
      const raw = args.limit === undefined ? 50 : args.limit
      const text = typeof raw === 'string' ? asciiDecimalDigits(strip(raw)) : null
      const limit = typeof raw === 'boolean' ? Number(raw) : typeof raw === 'number' ? Math.trunc(raw) : text !== null && /^[+-]?\d(?:_?\d)*$/u.test(text) ? Number(text.replaceAll('_', '')) : NaN
      if (!Number.isSafeInteger(limit)) throw new Error('活动条数无效')
      const value = await list(scope.identity.ownerId, { from: args.from, to: args.to, type: args.type, limit }, scope.signal)
      scope.signal.throwIfAborted()
      return { kind: 'completed', successful: true, mutated: false, value }
    },
  }
}
