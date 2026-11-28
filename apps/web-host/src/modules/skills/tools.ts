import { projectSkillToolCatalog } from '@gugu/core/skills'
import type { createAgentToolRegistry } from '../agent/tools/registry.js'
import type { UserSkillTool } from './routes.js'

/** Skill picker derives names and descriptions from the Host's registered Core tool definitions. */
export function createSkillToolCatalog(registry: Pick<ReturnType<typeof createAgentToolRegistry>, 'catalog'>) {
  return async (_ownerId: string): Promise<UserSkillTool[]> => projectSkillToolCatalog(registry.catalog())
}

export interface SkillToolName { name: string }

const SKILL_MANAGEMENT_TOOLS = new Set(['list_skills', 'create_skill', 'update_skill', 'delete_skill'])

/** Skill 的 related_tools 必须来自当前 owner 实际可用的内置或 MCP 工具。 */
export function createUserSkillToolNameReader(options: {
  builtins(ownerId: string): Promise<readonly SkillToolName[]>
  mcp(ownerId: string): Promise<readonly SkillToolName[]>
}) {
  return async (ownerId: string, relatedTools: readonly string[] = []): Promise<ReadonlySet<string>> => {
    const builtins = await options.builtins(ownerId)
    const mcp = relatedTools.some(name => name.startsWith('mcp_')) ? await options.mcp(ownerId) : []
    return new Set([...builtins, ...mcp]
      .map(tool => tool.name)
      .filter(name => name.length > 0 && !SKILL_MANAGEMENT_TOOLS.has(name)))
  }
}

/** Skill 引用只校验工具是否已注册；运行时授权必须留给真实 Run 身份判定。 */
export function createRegisteredUserSkillToolNameReader(options: {
  registry: { catalog(): readonly SkillToolName[] }
  mcp(ownerId: string): Promise<readonly SkillToolName[]>
}) {
  return createUserSkillToolNameReader({
    async builtins() { return options.registry.catalog() },
    mcp: options.mcp,
  })
}
