import { strip } from '../../shared/values.js'
import type { ToolCall, ToolResult } from '../models.js'
import type { ToolDefinition } from './contracts.js'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

const adapterIssues = {
  'call_tool.arguments 必须是 JSON object': { path: 'arguments', rule: 'type' },
  'call_tool.arguments 是必填字段': { path: 'arguments', rule: 'required' },
  'call_tool.tool_name 必须是字符串': { path: 'tool_name', rule: 'type' },
  'call_tool 嵌套层数超过限制': { path: 'tool_name', rule: 'max_depth' },
} as const

export function rejectAdapterCall(error: string): ToolResult {
  const issue = Object.hasOwn(adapterIssues, error) ? adapterIssues[error as keyof typeof adapterIssues] : null
  return {
    kind: 'completed', successful: false, mutated: false, executed: false,
    value: issue ? {
      error: 'tool_call_invalid',
      issues: [{ ...issue, message: error }],
      usage_hint: '工具调用协议不正确。工具名必须是字符串，arguments 必须是 JSON object。',
      next_action: issue.path === 'tool_name'
        ? '请传入实际工具名称，并把业务参数放入 arguments 对象。'
        : '请先获取目标工具的完整 Schema，再通过 arguments 传入全部业务参数。',
    } : { error },
  }
}

/** 在计划前解析最终调用，保留 Provider 分配的调用 ID。 */
export function resolveCallTool(call: ToolCall): { call: ToolCall } | { error: string } {
  if (call.name !== 'call_tool') return { call }
  if (call.parseError) return { error: '工具参数不是合法的 JSON 对象，请修正参数后重试' }
  let args = call.input
  for (let depth = 0; depth < 4; depth++) {
    if (!object(args)) return { error: 'call_tool.arguments 必须是 JSON object' }
    const raw = Object.hasOwn(args, 'tool_name') ? args.tool_name : args.name
    const name = typeof raw === 'string' ? strip(raw) : ''
    if (!name) return { error: 'call_tool.tool_name 必须是字符串' }
    if (Object.hasOwn(args, 'arguments')) {
      if (!object(args.arguments)) return { error: 'call_tool.arguments 必须是 JSON object' }
      args = args.arguments
    } else {
      const { tool_name: _toolName, name: _name, ...fields } = args
      if (!Object.keys(fields).length) return { error: 'call_tool.arguments 是必填字段' }
      args = fields
    }
    if (name !== 'call_tool') return { call: { id: call.id, name, input: args } }
  }
  return { error: 'call_tool 嵌套层数超过限制' }
}

/** Registry 提供模型声明与独立拒绝路径。执行由 Core Run 在计划前解析。 */
export function createCallToolAdapter(): ToolDefinition {
  return {
    definition: { name: 'call_tool', schema: { type: 'function', function: {
      name: 'call_tool', description: '调用当前已授权的业务工具。',
      parameters: { type: 'object', properties: {
        tool_name: { type: 'string', minLength: 1, maxLength: 80 }, arguments: { type: 'object' },
      }, required: ['tool_name', 'arguments'], additionalProperties: false },
    } } },
    effect: 'read', validate: input => ({ success: true, data: input }),
    async execute() { return rejectAdapterCall('当前运行不支持工具转发') },
  }
}
