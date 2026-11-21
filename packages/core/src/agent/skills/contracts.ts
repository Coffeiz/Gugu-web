import type { RunIdentity } from '../models.js'

export interface SkillMetadata {
  readonly id: string
  readonly key?: string
  readonly name: string
  readonly description: string
  readonly description_short?: string
  readonly description_long?: string
  readonly category?: string
  readonly emoji?: string
  readonly source?: 'builtin' | 'user'
  readonly related_tools?: readonly string[]
}

/** 正文与摘要由可信 Host loader 提供，不接收模型指定的 owner 或物理路径。 */
export interface SkillDefinition extends SkillMetadata {
  load(identity: RunIdentity, signal: AbortSignal): Promise<{
    readonly content: string
    readonly contentDigest: string
  }>
}

export interface LoadedSkill {
  readonly id: string
  readonly name: string
  readonly content: string
  readonly contentDigest: string
}

export interface SkillConfiguration {
  readonly skills?: Readonly<Record<string, boolean>>
}

export interface SkillRegistryOptions {
  readonly skills?: readonly SkillDefinition[]
  readonly configuration?: SkillConfiguration
  authorize(identity: RunIdentity, id: string): Promise<boolean>
}

export interface SkillRegistry {
  register(definition: SkillDefinition): void
  configure(configuration: SkillConfiguration): void
  catalog(identity: RunIdentity): Promise<SkillMetadata[]>
  load(id: string, identity: RunIdentity, signal: AbortSignal): Promise<LoadedSkill>
}
