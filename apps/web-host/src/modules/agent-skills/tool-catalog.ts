import type { createAgentToolRegistry } from '../../domains/agent-sessions/tools/agent-tool-registry.js'
import type { UserSkillTool } from './user-list.js'

const NON_SKILL_TOOLS = new Set(['list_skills', 'create_skill', 'update_skill', 'delete_skill', 'send_link_buttons'])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function description(schema: unknown): string {
  if (!record(schema) || !record(schema.function)) return ''
  const value = schema.function.description
  return typeof value === 'string' ? value : ''
}

function shortDescription(value: string, fallback: string): string {
  const first = value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? fallback
  const chars = Array.from(first)
  return chars.length > 100 ? chars.slice(0, 100).join('') : first
}

/** Skill picker derives names and descriptions from the Host's registered Core tool definitions. */
export function createAgentSkillToolCatalog(registry: Pick<ReturnType<typeof createAgentToolRegistry>, 'capabilities'>) {
  return async (ownerId: string): Promise<UserSkillTool[]> => {
    const definitions = await registry.capabilities({ ownerId, sessionId: 'skills-tool-catalog', runId: 'skills-tool-catalog' })
    return definitions
      .filter(item => !NON_SKILL_TOOLS.has(item.name))
      .map(item => {
        const long = description(item.schema)
        return { name: item.name, description_short: shortDescription(long, item.name), category: 'other', enabled: true }
      })
  }
}
