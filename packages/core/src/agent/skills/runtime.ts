import type { RunIdentity } from '../models.js'
import { createSkillRegistry } from './registry.js'
import type { SkillDefinition, SkillRegistry } from './contracts.js'
import type { BuiltinSkillDefinition } from './builtin.js'
import type { SkillListEntry } from './user-read.js'

export interface AgentSkillRuntimePorts {
  readonly skills: SkillRegistry
  origin(identity: RunIdentity, id: string, signal: AbortSignal): Promise<
    { source: 'builtin' } | { source: 'user'; ownerFingerprint: string }
  >
}

export interface AgentSkillRuntimeOptions {
  /** 由可信 Host 从当前 Run 租约注入，绝不从工具参数或 Skill 正文读取。 */
  readonly ownerId: string
  readonly builtins: readonly BuiltinSkillDefinition[]
  readonly listUser: (ownerId: string, signal: AbortSignal) => Promise<{ skills: readonly SkillListEntry[] }>
  readonly readUser: (ownerId: string, skillId: string) => Promise<{
    id: string
    name: string
    body: string
    contentDigest: string
  } | null>
  readonly fingerprint: (ownerId: string) => string
}

/**
 * 组合单个 Agent Run 可见的内置与用户 Skill。
 * 数据读取、owner 事实和安全指纹由可信 Host 端口提供，目录筛选、来源判定及注册器策略属于共享运行时。
 */
export async function createAgentSkillRuntimePorts(options: AgentSkillRuntimeOptions): Promise<AgentSkillRuntimePorts> {
  const ownerId = options.ownerId.trim()
  if (!ownerId) throw new TypeError('Agent Skill owner 无效')
  const builtinIds = new Set(options.builtins.map(skill => skill.id))
  const listed = await options.listUser(ownerId, new AbortController().signal)
  const userDefinitions: SkillDefinition[] = listed.skills
    .filter(skill => skill.source === 'user' && skill.enabled && /^U[1-9]\d*$/.test(skill.id))
    .map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description_short,
      description_short: skill.description_short,
      category: skill.category,
      related_tools: skill.related_tools,
      source: 'user',
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
    if (ids.has(skill.id)) throw new TypeError('Agent Skill ID 重复')
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
