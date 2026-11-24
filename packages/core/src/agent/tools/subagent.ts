import { z } from 'zod'
import type { Json, ToolResult } from '../models.js'
import { SubagentServiceError, type createSubagentService } from '../subagent/service.js'
import type { ToolDefinition, ToolScope } from './contracts.js'

const childId = z.string().regex(/^[0-9a-f]{8}$/u)
const childInput = z.strictObject({ childId })
const inspectInput = z.union([z.strictObject({}), z.strictObject({ childId, round: z.number().int().min(1) }),
  z.strictObject({ childId, lastRounds: z.number().int().min(1).max(5).optional() })])
const text = (limit: number) => z.string().trim().min(1).max(limit)
const sendToParentInput = z.strictObject({ action: z.literal('send'), target: z.literal('parent'), message: text(12_000) })
const messageInput = z.union([
  z.strictObject({ action: z.literal('spawn'), agentId: text(128), task: text(32_000),
    resourceRefs: z.array(text(512)).max(32).optional(), allowBackgroundReport: z.boolean().optional() }),
  z.strictObject({ action: z.literal('send'), childId, message: text(12_000) }),
])

/** 按可信父 Run 注册。工具输入不携带 owner 或父 Run 身份。 */
export function createSubagentServiceTools(service: ReturnType<typeof createSubagentService>, audience: 'parent' | 'child' = 'parent'): ToolDefinition[] {
  function tool<T>(name: string, description: string, schema: z.ZodType<T>, effect: 'read' | 'write',
    invoke: (input: T, scope: ToolScope, callId: string) => Promise<unknown>): ToolDefinition {
    const { $schema: _version, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' })
    return {
      definition: { name, schema: { type: 'function', function: {
        name, description, parameters: JSON.parse(JSON.stringify({ type: 'object', ...inputSchema })) as Json,
      } } },
      effect,
      validate: input => schema.safeParse(input),
      async execute(input, scope, call): Promise<ToolResult> {
        scope.signal.throwIfAborted()
        try {
          const result = await invoke(input as T, scope, call.id)
          return { kind: 'completed', successful: true, mutated: false, value: result }
        } catch (error) {
          if (!(error instanceof SubagentServiceError)) throw error
          return { kind: 'completed', successful: false, mutated: false, value: { error: { code: error.code, message: error.message } } }
        }
      },
    }
  }

  if (audience === 'child') return [
    tool('agent_message', '向委派当前任务的父 Agent 发送消息。', sendToParentInput, 'write',
      (input, scope, id) => service.sendToParent(scope.identity, id, input.message, scope.signal)),
  ]

  return [
    tool('agent_message', '用 spawn 创建目录中的子 Agent（Searcher 的 agentId 为 builtin:searcher），用 send 向短 ID 对应的子运行追加消息。委派文件或目录时，在 resourceRefs 中提供本轮已授权的路径引用键。', messageInput, 'write',
      (input, scope, id) => input.action === 'spawn'
        ? service.spawn(scope.identity, id, input.agentId, { task: input.task, resourceRefs: input.resourceRefs, allowBackgroundReport: input.allowBackgroundReport }, scope.signal)
        : service.send(scope.identity, id, input.childId, input.message, scope.signal)),
    tool('agent_inbox', '检查当前会话的未读子 Agent 消息和报告。立即返回，收件箱为空时也不会等待。', z.strictObject({}), 'read',
      (_input, scope) => service.waitInbox(scope.identity, scope.signal)),
    tool('agent_cancel', '请求取消指定子运行。', childInput, 'write',
      (input, scope) => service.cancel(scope.identity, input.childId)),
    tool('agent_inspect', '列出子运行，或查看指定子运行的当前活动。可用 round 精查单轮，或用 lastRounds 查看最近 1 至 5 轮。', inspectInput, 'read',
      (input, scope) => 'childId' in input ? service.inspect(scope.identity, input.childId, 'round' in input ? input.round : undefined, 'lastRounds' in input ? input.lastRounds : undefined) : service.inspect(scope.identity)),
  ]
}
