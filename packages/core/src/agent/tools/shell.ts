import { z } from 'zod'
import type { ToolCall, ToolResult } from '../models.js'
import type { ToolDefinition, ToolScope } from './contracts.js'

const shellInput = z.object({
  command: z.string().trim().min(1).max(16_384).refine(value => !value.includes('\0')),
  cwd: z.string().max(4096).default('.'),
  timeout: z.number().min(0.1).max(300).default(30),
  max_output_chars: z.number().int().min(1).max(120_000).default(12_000),
  scope: z.enum(['sandbox', 'system']).default('sandbox'),
}).strict()

export type AgentShellInput = z.output<typeof shellInput>
export type AgentShellPort = (input: AgentShellInput, scope: ToolScope, call: ToolCall) => Promise<ToolResult>

/** Host 必须校验可信执行范围和单次确认。模型只提供命令参数。 */
export function createAgentShellTool(execute: AgentShellPort): ToolDefinition {
  return {
    definition: { name: 'shell', schema: { type: 'function', function: {
      name: 'shell', description: '默认在隔离沙盒执行，目录使用沙盒内路径。独立工作目录允许普通写入和输出重定向；写入文件库或真实项目仍受原有权限和确认限制。显式 system 使用 Web Host 服务账号权限，需要双侧开启及逐次确认。',
      parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: {
        command: { type: 'string', minLength: 1, maxLength: 16_384 },
        cwd: { type: 'string', maxLength: 4096, default: '.' },
        timeout: { type: 'number', minimum: 0.1, maximum: 300, default: 30 },
        max_output_chars: { type: 'integer', minimum: 1, maximum: 120_000, default: 12_000 },
        scope: { type: 'string', enum: ['sandbox', 'system'], default: 'sandbox' },
      } },
    } } },
    effect: 'write',
    destructive: true,
    requiresInteraction: true,
    confirmationReplay: true,
    validate: input => shellInput.safeParse(input),
    execute: (input, scope, call) => execute(shellInput.parse(input), scope, call),
  }
}
