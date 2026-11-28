import { builtinSkillKeyPattern, legacyBuiltinSkillKey } from './builtin.js'
import type { RunIdentity } from '../models.js'
import type { LoadedSkill, SkillConfiguration, SkillDefinition, SkillMetadata, SkillRegistry, SkillRegistryOptions } from './contracts.js'

export class SkillRegistryError extends Error {
  constructor(readonly code: 'unavailable' | 'load_failed') {
    super(code === 'unavailable' ? '技能不存在或未开放' : '技能加载失败')
    this.name = 'SkillRegistryError'
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function metadata(definition: SkillMetadata): SkillMetadata {
  const result: Record<string, unknown> = { id: definition.id, name: definition.name, description: definition.description }
  for (const key of ['key', 'path', 'description_short', 'description_long', 'category', 'emoji'] as const) {
    if (definition[key] !== undefined) {
      if (typeof definition[key] !== 'string') throw new Error('技能元数据无效')
      result[key] = definition[key]
    }
  }
  if (definition.source !== undefined) {
    if (definition.source !== 'builtin' && definition.source !== 'user') throw new Error('技能来源无效')
    result.source = definition.source
  }
  if (definition.related_tools !== undefined) {
    if (!Array.isArray(definition.related_tools) || !definition.related_tools.every(name => typeof name === 'string' && name.trim())) throw new Error('技能关联工具无效')
    result.related_tools = Object.freeze([...definition.related_tools])
  }
  return result as unknown as SkillMetadata
}

/** Skill 注册、配置和授权与工具保持独立；正文始终通过可信领域 loader 获取。 */
export function createSkillRegistry(options: SkillRegistryOptions): SkillRegistry {
  if (typeof options.authorize !== 'function') throw new Error('技能授权配置无效')
  const entries = new Map<string, SkillDefinition>()
  const builtinKeys = new Set<string>()
  let enabled = new Map<string, boolean>()

  function register(definition: SkillDefinition): void {
    if (!plainRecord(definition) || typeof definition.id !== 'string' || !definition.id.trim()
      || definition.id !== definition.id.trim() || entries.has(definition.id)
      || typeof definition.name !== 'string' || !definition.name.trim()
      || typeof definition.description !== 'string' || typeof definition.load !== 'function')
      throw new Error('技能定义无效或重复')
    if (definition.key !== undefined && (definition.source !== 'builtin'
      || !builtinSkillKeyPattern.test(definition.key) || builtinKeys.has(definition.key))) throw new Error('内置技能键无效或重复')
    const registered = Object.freeze({ ...metadata(definition), load: definition.load })
    if (registered.key) builtinKeys.add(registered.key)
    entries.set(definition.id, registered)
  }

  function configure(configuration: SkillConfiguration): void {
    if (!plainRecord(configuration) || Object.keys(configuration).some(key => key !== 'skills')
      || (configuration.skills !== undefined && !plainRecord(configuration.skills))) throw new Error('技能配置无效')
    const next = new Map<string, boolean>()
    for (const [id, active] of Object.entries(configuration.skills ?? {})) {
      if (typeof active !== 'boolean') throw new Error('技能配置无效')
      const legacyKey = builtinKeys.size ? legacyBuiltinSkillKey(id) : undefined
      if (legacyKey) {
        if (builtinKeys.has(legacyKey) && !Object.hasOwn(configuration.skills!, legacyKey)) next.set(legacyKey, active)
        continue
      }
      // 已移除技能的稳定键可以保留在配置中。
      if (!(builtinKeys.size && builtinSkillKeyPattern.test(id)) && (!entries.has(id) || entries.get(id)?.key))
        throw new Error('技能配置无效')
      next.set(id, active)
    }
    enabled = next
  }

  async function allowed(identity: RunIdentity, id: string): Promise<boolean> {
    const definition = entries.get(id)
    if (!definition) return false
    const key = definition.key ?? id
    if (enabled.get(key) === false) return false
    try {
      const authorized = await options.authorize(Object.freeze({ ...identity }), id)
      return authorized === true && enabled.get(key) !== false
    } catch { return false }
  }

  for (const skill of options.skills ?? []) register(skill)
  configure(options.configuration ?? {})
  return {
    register,
    configure,
    async catalog(identity) {
      const result: SkillMetadata[] = []
      const trustedIdentity = Object.freeze({ ...identity })
      for (const [id, definition] of entries) {
        if (await allowed(trustedIdentity, id)) result.push(metadata(definition))
      }
      // 逐项异步授权期间可能撤销先前条目的配置。
      return result.filter(item => enabled.get(item.key ?? item.id) !== false)
    },
    async load(id, identity, signal): Promise<LoadedSkill> {
      signal.throwIfAborted()
      const trustedIdentity = Object.freeze({ ...identity })
      const authorized = await allowed(trustedIdentity, id)
      signal.throwIfAborted()
      if (!authorized) throw new SkillRegistryError('unavailable')
      const definition = entries.get(id)!
      try {
        const result = await definition.load(trustedIdentity, signal)
        signal.throwIfAborted()
        // 正文I/O期间权限可能撤销；直接使用注册器也不能绕过发布前判权。
        const publish = await allowed(trustedIdentity, id)
        signal.throwIfAborted()
        if (!publish) throw new SkillRegistryError('unavailable')
        if (!plainRecord(result) || typeof result.content !== 'string' || typeof result.contentDigest !== 'string' || !result.contentDigest)
          throw new SkillRegistryError('load_failed')
        return { id, name: definition.name, content: result.content, contentDigest: result.contentDigest }
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof SkillRegistryError) throw new SkillRegistryError(error.code)
        throw new SkillRegistryError('load_failed')
      }
    },
  }
}
