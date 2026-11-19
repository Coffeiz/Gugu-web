import type { createAgentToolRegistry } from '../agent-sessions/tools/agent-tool-registry.js'
import type { UserSkillTool } from './user-list.js'

const NON_SKILL_TOOLS = new Set(['list_skills', 'create_skill', 'update_skill', 'delete_skill', 'send_link_buttons'])

function shortDescription(value: string, fallback: string): string {
  const first = value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? fallback
  const chars = Array.from(first)
  return chars.length > 100 ? chars.slice(0, 100).join('') : first
}

/** Skill picker derives names and descriptions from the Host's registered Core tool definitions. */
export function createSkillToolCatalog(registry: Pick<ReturnType<typeof createAgentToolRegistry>, 'catalog'>) {
  return async (_ownerId: string): Promise<UserSkillTool[]> => {
    return registry.catalog()
      .filter(item => item.enabled && !NON_SKILL_TOOLS.has(item.name))
      .map(item => {
        const long = item.description
        return { name: item.name, description_short: shortDescription(long, item.name), category: 'other', enabled: true }
      })
  }
}
