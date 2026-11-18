import { createSkillRegistry, type BuiltinSkillDefinition, type SkillDefinition, type SkillListEntry } from '@gugu/core/skills'
import type { UseSkillPorts } from '@gugu/core/tools'

export interface WebAgentSkillProductionOptions {
  ownerId: string
  builtins: readonly BuiltinSkillDefinition[]
  listUser(ownerId: string, signal: AbortSignal): Promise<{ skills: SkillListEntry[] }>
  readUser(ownerId: string, skillId: string): Promise<{ id: string; name: string; body: string; contentDigest: string } | null>
  fingerprint(ownerId: string): string
}

/** 将真实内置资源和 owner scoped 用户 Skill 绑定到单次 Web Run。 */
export async function createWebAgentSkillProductionPorts(options: WebAgentSkillProductionOptions): Promise<UseSkillPorts> {
  const ownerId = options.ownerId.trim()
  if (!ownerId) throw new TypeError('Web Agent Skill owner 无效')
  const builtinIds = new Set(options.builtins.map(skill => skill.id))
  const listed = await options.listUser(ownerId, new AbortController().signal)
  const userDefinitions: SkillDefinition[] = listed.skills
    .filter(skill => skill.source === 'user' && skill.enabled && /^U[1-9]\d*$/.test(skill.id))
    .map(skill => ({
      id: skill.id, name: skill.name, description: skill.description_short,
      description_short: skill.description_short, description_long: undefined,
      category: skill.category, related_tools: skill.related_tools, source: 'user',
      async load(identity, signal) {
        signal.throwIfAborted()
        if (identity.ownerId !== ownerId) throw new Error('技能不存在或未开放')
        const current = await options.readUser(ownerId, skill.id)
        signal.throwIfAborted()
        if (!current || current.id !== skill.id) throw new Error('技能不存在或未开放')
        return { content: current.body, contentDigest: current.contentDigest }
      },
    }))
  const ids = new Set<string>()
  for (const skill of [...options.builtins, ...userDefinitions]) {
    if (ids.has(skill.id)) throw new TypeError('Web Agent Skill ID 重复')
    ids.add(skill.id)
  }
  const skills = createSkillRegistry({
    skills: [...options.builtins, ...userDefinitions],
    async authorize(identity, id) {
      if (identity.ownerId !== ownerId) return false
      if (builtinIds.has(id)) return true
      if (!/^U[1-9]\d*$/.test(id)) return false
      return Boolean(await options.readUser(ownerId, id))
    },
  })
  return {
    skills,
    async origin(identity, id, signal) {
      signal.throwIfAborted()
      if (identity.ownerId !== ownerId) throw new Error('技能来源无效')
      if (builtinIds.has(id)) return { source: 'builtin' }
      const current = await options.readUser(ownerId, id)
      signal.throwIfAborted()
      if (!current || current.id !== id || !/^U[1-9]\d*$/.test(id)) throw new Error('技能来源无效')
      const ownerFingerprint = options.fingerprint(ownerId)
      if (!ownerFingerprint.trim()) throw new Error('技能来源无效')
      return { source: 'user', ownerFingerprint }
    },
  }
}
