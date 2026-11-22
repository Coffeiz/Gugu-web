import { z } from 'zod'
import type { Json, ToolResult } from '../models.js'
import { SubagentServiceError, type createSubagentService } from '../subagent/service.js'
import type { ToolDefinition, ToolScope } from './contracts.js'

const childId = z.string().regex(/^[0-9a-f]{8}$/u)
const childInput = z.strictObject({ childId })
const waitInput = z.union([childInput, z.strictObject({})])
const inspectInput = z.union([z.strictObject({}), z.strictObject({ childId, round: z.number().int().min(1).optional() })])
const text = (limit: number) => z.string().trim().min(1).max(limit)
const sendToParentInput = z.strictObject({ action: z.literal('send'), target: z.literal('parent'), message: text(12_000) })
const messageInput = z.union([
  z.strictObject({ action: z.literal('start'), agentId: text(128), task: text(32_000),
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
      ...(name === 'agent_wait' ? { requiresInteraction: true } : {}),
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
    tool('agent_message', '启动目录中的子 Agent，或向短 ID 对应的子运行追加消息。委派文件时在 resourceRefs 中提供本轮已授权的引用键，Web 文件库使用文件 ID 的字符串形式，路径引用使用引用键，Web 文件库目录使用 folder:目录ID（只读）。', messageInput, 'write',
      (input, scope, id) => input.action === 'start'
        ? service.start(scope.identity, id, input.agentId, { task: input.task, resourceRefs: input.resourceRefs, allowBackgroundReport: input.allowBackgroundReport }, scope.signal)
        : service.send(scope.identity, id, input.childId, input.message, scope.signal)),
    tool('agent_wait', '先推进独立工作。当前工作确实需要子 Agent 的结果或收件箱消息才能继续时，传 childId 等待该子 Run 的最终回复，或留空等待当前 Run 的收件箱更新。', waitInput, 'read',
      (input, scope) => 'childId' in input ? service.wait(scope.identity, input.childId, scope.signal) : service.waitInbox(scope.identity, scope.signal)),
    tool('agent_cancel', '请求取消指定子运行。', childInput, 'write',
      (input, scope) => service.cancel(scope.identity, input.childId)),
    tool('agent_inspect', '列出子运行，或查看指定子运行的当前活动或轮次。', inspectInput, 'read',
      (input, scope) => 'childId' in input ? service.inspect(scope.identity, input.childId, input.round) : service.inspect(scope.identity)),
  ]
}
