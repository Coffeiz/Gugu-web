import type { RunIdentity } from '../models.js'
import type { ToolDefinition } from './contracts.js'

/** 可信 Host 绑定共享只读查询及平台能力；身份来自当前运行，不由模型指定。 */
export interface ScheduledTaskListPort {
  list(identity: RunIdentity, signal: AbortSignal): Promise<readonly unknown[]>
}

export function createListScheduledTasksTool(port: ScheduledTaskListPort): ToolDefinition {
  return {
    definition: { name: 'list_scheduled_tasks', schema: { type: 'function', function: {
      name: 'list_scheduled_tasks', description: '列出全部独立定时任务，不包含日历活动提醒。',
      parameters: { type: 'object', properties: {} },
    } } },
    effect: 'read',
    validate(input) {
      return input !== null && typeof input === 'object' && !Array.isArray(input)
        ? { success: true, data: {} } : { success: false }
    },
    async execute(_input, scope) {
      scope.signal.throwIfAborted()
      const value = await port.list(scope.identity, scope.signal)
      scope.signal.throwIfAborted()
      return { kind: 'completed', value, successful: true, mutated: false }
    },
  }
}
