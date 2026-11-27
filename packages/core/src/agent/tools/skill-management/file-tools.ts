import { z } from 'zod'
import type { RunIdentity, ToolCall, ToolResult } from '../../models.js'
import type { ToolDefinition, ToolScope } from '../contracts.js'

const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u)
const category = z.enum(['personal', 'productivity', 'research', 'creative', 'other'])
const createInput = z.strictObject({
  skill_name: z.string().min(1).max(120), description_short: z.string().min(1).max(100),
  description_long: z.string().max(500).optional(), category: category.optional(),
  related_tools: z.array(z.string().min(1).max(80)).max(32), body: z.string().min(1).max(20000),
  managed_by: z.enum(['user', 'assistant']),
})
const updateInput = z.strictObject({
  id: slug, skill_name: z.string().min(1).max(120).optional(), description_short: z.string().min(1).max(100).optional(),
  description_long: z.string().max(500).nullable().optional(), category: category.optional(),
  related_tools: z.array(z.string().min(1).max(80)).max(32).optional(), body: z.string().min(1).max(20000).optional(),
  enabled: z.boolean().optional(),
}).refine(value => Object.keys(value).length > 1)

export type FileSkillCreateInput = z.infer<typeof createInput>
export type FileSkillUpdateInput = z.infer<typeof updateInput>
type Action = 'create' | 'update'

/** 宿主负责身份复核、持久收据、文件历史和提交结果恢复；工具参数不能指定 owner 或文件路径。 */
export interface FileSkillManagementPort {
  execute(action: 'create', input: FileSkillCreateInput, scope: ToolScope, call: ToolCall): Promise<ToolResult>
  execute(action: 'update', input: FileSkillUpdateInput, scope: ToolScope, call: ToolCall): Promise<ToolResult>
  reconcile(action: Action, input: FileSkillCreateInput | FileSkillUpdateInput,
    identity: RunIdentity & { readonly roundId: string }, call: ToolCall): Promise<ToolResult>
}

/** 文件技能写入工具只定义公共参数契约，宿主端口负责具有副作用的事务。 */
export function createFileSkillManagementWriteTools(port: FileSkillManagementPort): ToolDefinition[] {
  return [
    {
      definition: { name: 'create_skill', schema: { type: 'function', function: {
        name: 'create_skill', description: '创建可复用的文件技能；关联工具仅作引用，不授予权限。',
        parameters: { type: 'object', properties: {
          skill_name: { type: 'string', minLength: 1, maxLength: 120 },
          description_short: { type: 'string', minLength: 1, maxLength: 100 },
          description_long: { type: 'string', maxLength: 500 }, category: { type: 'string', enum: category.options },
          related_tools: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 80 } },
          body: { type: 'string', minLength: 1, maxLength: 20000 }, managed_by: { type: 'string', enum: ['user', 'assistant'] },
        }, required: ['skill_name', 'description_short', 'related_tools', 'body', 'managed_by'], additionalProperties: false },
      } } },
      effect: 'write', validate: input => createInput.safeParse(input),
      execute: (input, scope, call) => port.execute('create', createInput.parse(input), scope, call),
      reconcile: (input, identity, call) => port.reconcile('create', createInput.parse(input), identity, call),
    },
    {
      definition: { name: 'update_skill', schema: { type: 'function', function: {
        name: 'update_skill', description: '按技能目录标识更新当前用户的文件技能。',
        parameters: { type: 'object', properties: {
          id: { type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$' },
          skill_name: { type: 'string', minLength: 1, maxLength: 120 },
          description_short: { type: 'string', minLength: 1, maxLength: 100 },
          description_long: { type: ['string', 'null'], maxLength: 500 }, category: { type: 'string', enum: category.options },
          related_tools: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 80 } },
          body: { type: 'string', minLength: 1, maxLength: 20000 }, enabled: { type: 'boolean' },
        }, required: ['id'], additionalProperties: false },
      } } },
      effect: 'write', validate: input => updateInput.safeParse(input),
      execute: (input, scope, call) => port.execute('update', updateInput.parse(input), scope, call),
      reconcile: (input, identity, call) => port.reconcile('update', updateInput.parse(input), identity, call),
    },
  ]
}
