import type { SkillMetadata } from './contracts.js'
import type { SkillStorageSource } from './bundle.js'

export interface SkillListEntry {
  id: string; name: string; description_short: string; category: string; related_tools: string[]
  enabled: boolean; source: 'builtin' | 'user'; storage_source?: SkillStorageSource; managed_by?: string; path?: string
}
/** 内置技能目录不依赖用户数据库。 */
export function createBuiltinSkillMetadataReader(builtins: readonly SkillMetadata[]) {
  const builtinEntries: SkillListEntry[] = builtins.map(row=>({id:row.id,name:row.name,description_short:row.description_short??row.description,
    category:row.category??'',related_tools:[...(row.related_tools??[])],enabled:true,source:'builtin'}))
  return async (_ownerId: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const skills = builtinEntries.map(skill => ({ ...skill, related_tools: [...skill.related_tools] }))
    return { count: skills.length, skills }
  }
}
