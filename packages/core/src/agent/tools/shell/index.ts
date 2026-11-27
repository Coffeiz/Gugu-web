import { z } from 'zod'
import { MAX_SHELL_DESCRIPTION_LENGTH, shellOperationDescription } from '../../shell-activity.js'
import type { ToolCall, ToolResult } from '../../models.js'
import type { ToolDefinition, ToolScope } from '../contracts.js'

const shellInput = z.object({
  command: z.string().trim().min(1).max(16_384).refine(value => !value.includes('\0')),
  description: z.string().refine(value => Boolean(shellOperationDescription({ description: value }))).transform(value => value.trim()).optional(),
  cwd: z.string().max(4096).default('.'),
  timeout: z.number().min(0.1).max(300).default(30),
  max_output_chars: z.number().int().min(1).max(120_000).default(12_000),
  scope: z.enum(['sandbox', 'system']).default('sandbox'),
}).strict()

export type AgentShellInput = z.output<typeof shellInput>
export type AgentShellPort = (input: AgentShellInput, scope: ToolScope, call: ToolCall) => Promise<ToolResult>

const readOnlyGuidance = '每次调用请在 description 中用用户的语言写一句简短的操作目的，例如「检查项目目录」。不要写实际命令、完整路径或敏感信息。工具分别返回 stdout 和 stderr。只读环境检查请直接查询，省略 2>/dev/null 和 2>&1，避免重定向触发不必要的确认。可将相关的只读查询合并在一次调用中。按实际回执汇报，避免对沙盒不允许的读取反复换写法重试。'

/** Host 必须校验可信执行范围和单次确认。模型只提供命令参数。 */
export function createAgentShellTool(execute: AgentShellPort, description?: string, exposeScope = true): ToolDefinition {
  const inputSchema = exposeScope ? shellInput : shellInput.omit({ scope: true }).extend({
    // 已保存的旧版桌面调用仍可在隔离环境恢复。
    scope: z.literal('sandbox').default('sandbox'),
  })
  return {
    definition: { name: 'shell', schema: { type: 'function', function: {
      name: 'shell', description: (description ?? '默认在隔离沙盒执行，目录使用沙盒内路径。独立工作目录允许普通写入和输出重定向；写入文件库或真实项目仍受原有权限和确认限制。显式 system 使用 Web Host 服务账号权限，需要管理员和用户双侧开启；危险命令在普通模式下逐次确认，自动模式下可跳过操作确认。') + readOnlyGuidance,
      parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: {
        command: { type: 'string', minLength: 1, maxLength: 16_384 },
        description: { type: 'string', minLength: 1, maxLength: MAX_SHELL_DESCRIPTION_LENGTH, description: '用用户的语言简短说明本次操作的目的。只写一行，不写命令、完整路径、凭据或其他敏感信息。' },
        cwd: { type: 'string', maxLength: 4096, default: '.' },
        timeout: { type: 'number', minimum: 0.1, maximum: 300, default: 30 },
        max_output_chars: { type: 'integer', minimum: 1, maximum: 120_000, default: 12_000 },
        ...(exposeScope ? { scope: { type: 'string', enum: ['sandbox', 'system'], default: 'sandbox' } } : {}),
      } },
    } } },
    effect: 'write',
    destructive: true,
    requiresInteraction: true,
    confirmationReplay: true,
    validate: input => inputSchema.safeParse(input),
    execute: (input, scope, call) => execute(inputSchema.parse(input), scope, call),
  }
}
