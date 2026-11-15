import { z } from 'zod'
import type { createSkillMetadataReader } from '../skills/user-read.js'
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
