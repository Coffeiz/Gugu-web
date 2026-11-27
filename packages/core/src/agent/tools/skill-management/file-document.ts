import { createUserSkillDocument, patchSkillDocument, type SkillDocumentPatch } from '../../skills/bundle.js'
import { UserSkillValidationError } from '../../skills/user-validation.js'
import type { FileSkillCreateInput, FileSkillUpdateInput } from './file-tools.js'

/** 把 Agent 创建参数转换为共享文档，关联工具仅作元数据。 */
export function createAgentSkillDocument(input: FileSkillCreateInput, knownTools: ReadonlySet<string>) {
  return createUserSkillDocument({ name: input.skill_name, description_short: input.description_short,
    description_long: input.description_long ?? null, category: input.category ?? 'personal',
    related_tools: input.related_tools, body: input.body, managed_by: input.managed_by }, knownTools)
}

/** 只更新 Agent 显式传入的字段，保留第三方 frontmatter。 */
export function updateAgentSkillDocument(source: string, input: FileSkillUpdateInput, knownTools: ReadonlySet<string>) {
  const patch: SkillDocumentPatch = {}
  if (input.skill_name !== undefined) patch.name = input.skill_name
  if (input.description_short !== undefined) patch.description = input.description_short
  if (input.description_long !== undefined) patch.descriptionLong = input.description_long
  if (input.category !== undefined) patch.category = input.category
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.body !== undefined) {
    if (!input.body.trim() || [...input.body].length > 20000) throw new UserSkillValidationError('Skill 正文不能为空且最多 20000 个字符')
    patch.body = input.body
  }
  if (input.related_tools !== undefined) {
    const tools = [...new Set(input.related_tools.map(value => value.trim()).filter(Boolean))]
    const missing = tools.filter(name => !knownTools.has(name) && !name.startsWith('mcp_'))
    if (missing.length) throw new UserSkillValidationError(`Skill 关联了未知工具：${missing.join(', ')}`)
    patch.relatedTools = tools
  }
  return patchSkillDocument(source, patch)
}
