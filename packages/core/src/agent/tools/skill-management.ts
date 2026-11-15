import { z } from 'zod'
import type { createSkillMetadataReader } from '../skills/user-read.js'
import { CoreError } from '../../contracts/index.js'
import { UserSkillValidationError, type UserSkillInput } from '../skills/user-validation.js'
import type { createUserSkillManager } from '../skills/user-management.js'
import type { ToolDefinition } from './contracts.js'

export type SkillMetadataListPort = ReturnType<typeof createSkillMetadataReader>
/** 管理目录与use_skill正文加载分离；停用项可列出，但不能据此获得执行权限。 */
export function createSkillManagementReadTools(list: SkillMetadataListPort): ToolDefinition[] {
  const schema=z.object({}).passthrough()
  return [{definition:{name:'list_skills',schema:{type:'function',function:{name:'list_skills',description:'列出内置及当前账号的用户技能元数据，包含停用项，不返回正文。',parameters:{type:'object',properties:{}}}}},
    effect:'read',validate:input=>schema.safeParse(input),
    async execute(_input,scope){
      const value=await list(scope.identity.ownerId,scope.signal)
      scope.signal.throwIfAborted()
      return {kind:'completed',successful:true,mutated:false,value}
    },
  }]
}

type SkillManager = ReturnType<typeof createUserSkillManager>
type SkillCreateInput = UserSkillInput & { managed_by: 'user' | 'assistant' }
type SkillUpdateInput = {
  name?: string
  description_short?: string
  description_long?: string | null
  category?: string
  body?: string
  related_tools?: string[]
  enabled?: boolean
}
export type SkillManagementOperations = Pick<SkillManager, 'create' | 'update'>

const createSchema = z.object({
  skill_name: z.string().min(1).max(120),
  description_short: z.string().min(1).max(100),
  description_long: z.string().max(500).optional(),
  category: z.enum(['personal', 'productivity', 'research', 'creative', 'other']).optional(),
  related_tools: z.array(z.string().max(80)).max(32),
  body: z.string().min(1).max(20000),
  managed_by: z.enum(['user', 'assistant']),
}).strict()

const updateSchema = z.object({
  id: z.string().regex(/^U[1-9][0-9]*$/u),
  skill_name: z.string().min(1).max(120).optional(),
  description_short: z.string().min(1).max(100).optional(),
  description_long: z.string().max(500).nullable().optional(),
  category: z.enum(['personal', 'productivity', 'research', 'creative', 'other']).optional(),
  related_tools: z.array(z.string().max(80)).max(32).optional(),
  body: z.string().min(1).max(20000).optional(),
  enabled: z.boolean().optional(),
}).strict()

function operationError(error: unknown): string | null {
  if (error instanceof UserSkillValidationError) return error.message
  if (error instanceof CoreError && error.code === 'not_found') return '技能不存在或不属于当前用户'
  return null
}

/** 与Python BaseSkill 的 create_skill/update_skill 对齐；安全权限由可信注册器负责。 */
export function createSkillManagementWriteTools(operations: SkillManagementOperations): ToolDefinition[] {
  return [
    {
      definition: { name: 'create_skill', schema: { type: 'function', function: {
        name: 'create_skill',
        description: '创建可复用的 Prompt Skill。不能注册工具或扩大权限；关联工具只作引用。',
        parameters: { type: 'object', properties: {
          skill_name: { type: 'string', minLength: 1, maxLength: 120 },
          description_short: { type: 'string', minLength: 1, maxLength: 100 },
          description_long: { type: 'string', maxLength: 500 },
          category: { type: 'string', enum: ['personal', 'productivity', 'research', 'creative', 'other'] },
          related_tools: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 80 } },
          body: { type: 'string', minLength: 1, maxLength: 20000 },
          managed_by: { type: 'string', enum: ['user', 'assistant'] },
        }, required: ['skill_name', 'description_short', 'body', 'related_tools', 'managed_by'], additionalProperties: false },
      } } },
      effect: 'write',
      validate: input => createSchema.safeParse(input),
      async execute(input, scope) {
        const value = input as z.infer<typeof createSchema>
        try {
          const skill = await operations.create(scope.identity.ownerId, {
            name: value.skill_name, description_short: value.description_short,
            description_long: value.description_long ?? null, category: value.category ?? 'personal',
            body: value.body, related_tools: value.related_tools,
            managed_by: value.managed_by,
          } as SkillCreateInput)
          scope.signal.throwIfAborted()
          return { kind: 'completed', successful: true, mutated: true, value: {
            success: true,
            skill: { id: skill.id, name: skill.name, description_short: skill.description_short,
              related_tools: skill.related_tools, enabled: skill.enabled, managed_by: skill.managed_by },
            message: '已创建这个咕咕技能，后续会在需要时按需加载。',
          } }
        } catch (error) {
          scope.signal.throwIfAborted()
          const message = operationError(error)
          if (message !== null) return { kind: 'completed', successful: false, mutated: false, value: { error: message } }
          throw error
        }
      },
    },
    {
      definition: { name: 'update_skill', schema: { type: 'function', function: {
        name: 'update_skill',
        description: '按稳定 Skill ID 更新当前用户的 Prompt Skill。至少提供一个要修改的字段。',
        parameters: { type: 'object', properties: {
          id: { type: 'string', pattern: '^U[1-9][0-9]*$' },
          skill_name: { type: 'string', minLength: 1, maxLength: 120 },
          description_short: { type: 'string', minLength: 1, maxLength: 100 },
          description_long: { type: ['string', 'null'], maxLength: 500 },
          category: { type: 'string', enum: ['personal', 'productivity', 'research', 'creative', 'other'] },
          related_tools: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 80 } },
          body: { type: 'string', minLength: 1, maxLength: 20000 },
          enabled: { type: 'boolean' },
        }, required: ['id'], additionalProperties: false },
      } } },
      effect: 'write',
      validate: input => updateSchema.safeParse(input),
      async execute(input, scope) {
        const { id, skill_name, ...fields } = input as z.infer<typeof updateSchema>
        if (Object.keys(fields).length === 0 && skill_name === undefined)
          return { kind: 'completed', successful: false, mutated: false, value: { error: '至少提供一个要更新的字段' } }
        const patch: SkillUpdateInput = { ...fields, ...(skill_name === undefined ? {} : { name: skill_name }) }
        try {
          const skill = await operations.update(scope.identity.ownerId, id, patch)
          scope.signal.throwIfAborted()
          return { kind: 'completed', successful: true, mutated: true, value: {
            success: true,
            skill: { id: skill.id, name: skill.name, description_short: skill.description_short,
              related_tools: skill.related_tools, enabled: skill.enabled,
              content_digest: skill.content_digest, managed_by: skill.managed_by || 'user' },
            message: '已更新这个咕咕技能。',
          } }
        } catch (error) {
          scope.signal.throwIfAborted()
          const message = operationError(error)
          if (message !== null) return { kind: 'completed', successful: false, mutated: false, value: { error: message } }
          throw error
        }
      },
    },
  ]
}
