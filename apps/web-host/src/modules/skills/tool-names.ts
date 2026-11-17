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
