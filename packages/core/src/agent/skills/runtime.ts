import type { RunIdentity } from '../models.js'
import { createSkillRegistry } from './registry.js'
import type { SkillDefinition, SkillRegistry } from './contracts.js'
import type { BuiltinSkillDefinition } from './builtin.js'
import type { SkillStorageSource } from './bundle.js'

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
  readonly fileSkills?: readonly SkillDefinition[]
  readonly isFileSkillEnabled?: (ownerId: string, skillId: string, source?: SkillStorageSource) => Promise<boolean>
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
  const fileIds = new Set((options.fileSkills ?? []).map(skill => skill.id))
  if (fileIds.size && !options.isFileSkillEnabled) throw new TypeError('文件技能授权端口无效')
  const ids = new Set<string>()
  for (const skill of [...options.builtins, ...(options.fileSkills ?? [])]) {
    if (ids.has(skill.id)) throw new TypeError('Agent Skill ID 重复')
    ids.add(skill.id)
  }
  const skills = createSkillRegistry({
    skills: [...options.builtins, ...(options.fileSkills ?? [])],
    async authorize(identity, id) {
      if (identity.ownerId !== ownerId) return false
      if (builtinIds.has(id)) return true
      const skill = options.fileSkills?.find(item => item.id === id)
      return fileIds.has(id) && !!skill && await options.isFileSkillEnabled!(ownerId, id, skill.storage_source)
    },
  })
  return {
    skills,
    async origin(identity, id, signal) {
      signal.throwIfAborted()
      if (identity.ownerId !== ownerId) throw new Error('技能来源无效')
      if (builtinIds.has(id)) return { source: 'builtin' }
      const skill = options.fileSkills?.find(item => item.id === id)
      if (!fileIds.has(id) || !skill || !await options.isFileSkillEnabled!(ownerId, id, skill.storage_source)) throw new Error('技能来源无效')
      signal.throwIfAborted()
      const ownerFingerprint = options.fingerprint(ownerId)
      if (!ownerFingerprint.trim()) throw new Error('技能来源无效')
      return { source: 'user', ownerFingerprint }
    },
  }
}
