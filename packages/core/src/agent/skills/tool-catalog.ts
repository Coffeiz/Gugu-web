const MANAGEMENT_TOOLS = new Set(['list_skills', 'create_skill', 'update_skill', 'delete_skill', 'send_link_buttons'])

/** 从宿主已注册的能力派生技能选择项，关联本身不授予执行权限。 */
export function projectSkillToolCatalog(
  tools: readonly { name: string; description: string; enabled: boolean }[],
) {
  return tools.filter(tool => tool.enabled && !MANAGEMENT_TOOLS.has(tool.name)).map(tool => {
    const first = tool.description.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? tool.name
    return {
      name: tool.name,
      description_short: Array.from(first).slice(0, 100).join(''),
      category: 'other',
      enabled: true,
    }
  })
}

type SkillTool = ReturnType<typeof projectSkillToolCatalog>[number]

/** 保留 MCP 服务的短描述与分组，同名工具以已注册的第一项为准。 */
export function mergeSkillToolCatalog(
  builtins: readonly SkillTool[],
  mcp: readonly Pick<SkillTool, 'name' | 'description_short'>[],
): SkillTool[] {
  const catalog = new Map(builtins.map(tool => [tool.name, tool]))
  for (const { name, description_short } of mcp) {
    if (!catalog.has(name)) catalog.set(name, { name, description_short, category: 'mcp', enabled: true })
  }
  return [...catalog.values()]
}
