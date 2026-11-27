import { z } from 'zod'
import { dataContext } from '../../../contracts/index.js'
import type { SqlDataRuntime } from '../../../data/runtime.js'
import type { CalendarEventReadPort } from '../../../calendar/application/event-read.js'
import type { ToolDefinition } from '../contracts.js'
import { readToolClock, type ToolClock } from '../time/index.js'

const upcomingInput = z.object({ days: z.number().int().min(1).max(366).optional() })

/** 组合既有项目与日历领域读端口，不新增数据库查询或自行解释平台权限。 */
export function createUpcomingTool(options: { core: SqlDataRuntime; events: CalendarEventReadPort; time: ToolClock }): ToolDefinition {
  return {
    definition: { name: 'get_upcoming', schema: { type: 'function', function: {
      name: 'get_upcoming', description: '汇总近期（默认 7 天内）要截止的项目与日历事件，按日期排序。用于回答「最近要忙什么」。若结果跨至少 3 个日期且有至少 4 项安排，首轮答复默认附 Mermaid timeline；只展示返回的日期和事项，不推断持续时间。',
      parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 366 } } },
    } } },
    effect: 'read',
    validate(input) { return upcomingInput.safeParse(input) },
    async execute(input, scope) {
      const { days = 7 } = input as z.infer<typeof upcomingInput>
      const { date: from } = await readToolClock(options.time, scope.identity, scope.signal)
      const end = new Date(`${from}T00:00:00Z`)
      end.setUTCDate(end.getUTCDate() + days)
      if (end.getUTCFullYear() > 9999) throw new RangeError('日期超出范围')
      const to = end.toISOString().slice(0, 10)
      const context = dataContext(scope.identity.ownerId)
      const projects = await options.core.transaction(context, data => data.projects.list(false), { signal: scope.signal })
      scope.signal.throwIfAborted()
      const events = await options.events.list(context.ownerId, undefined, scope.signal)
      scope.signal.throwIfAborted()
      const items = [
        ...projects.filter(project => project.status !== 'done' && project.deadline && project.deadline >= from && project.deadline <= to)
          .map(project => ({ kind: 'project_deadline', date: project.deadline!, title: project.name, project_id: project.id, status: project.status })),
        ...events.filter(event => event.date >= from && event.date <= to)
          .map(event => ({ kind: event.type, date: event.date, title: event.title, event_id: event.id, project_id: event.project_id })),
      ].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
      return { kind: 'completed', successful: true, mutated: false, value: { from, to, count: items.length, items } }
    },
  }
}
