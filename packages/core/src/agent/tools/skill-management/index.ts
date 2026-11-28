import { z } from 'zod'
import type { SkillListEntry } from '../../skills/user-read.js'
import type { ToolDefinition } from '../contracts.js'

export type SkillMetadataListPort = (ownerId: string, signal: AbortSignal) => Promise<{
  count: number
  skills: readonly SkillListEntry[]
}>

/** 通过宿主提供的文件目录列出技能元数据，不读取技能正文。 */
export function createSkillManagementReadTools(list: SkillMetadataListPort): ToolDefinition[] {
  const schema = z.object({}).passthrough()
  return [{
    definition: {
      name: 'list_skills',
      schema: { type: 'function', function: {
        name: 'list_skills',
        description: '列出内置及当前账号的文件技能元数据，包含停用项，不返回正文。',
        parameters: { type: 'object', properties: {} },
      } },
    },
    effect: 'read',
    validate: input => schema.safeParse(input),
    async execute(_input, scope) {
      const value = await list(scope.identity.ownerId, scope.signal)
      scope.signal.throwIfAborted()
      return { kind: 'completed', successful: true, mutated: false, value }
    },
  }]
}
