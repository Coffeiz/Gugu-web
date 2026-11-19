import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { stableJson, type RunIdentity } from '@gugu/core/agent'
import { createModelStrategy, type ModelSettingsSnapshot } from './model-strategy.js'
import { createPosixConfigFileLock } from '../../../adapters/posix-config-lock.js'
import type { ModelSnapshotBoundary } from './atomic-model-snapshot.js'

/** 必须由 Host 解析完文件、默认值和环境值；versionMaterial 必须包含实际生效的密钥身份。 */
export interface EffectiveModelConfiguration extends Omit<ModelSettingsSnapshot, 'accessScopeHash' | 'contextScopeKey'> {
  readonly versionMaterial: {
    /** 当前和仍可使用的历史密钥，键为版本；禁用 BYOK 时可为空对象。 */
    readonly credentialsMasterKeys: Readonly<Record<string, string>>
    readonly permissionIdentity: string
    readonly environment: Readonly<Record<string, unknown>>
  }
}
export interface FileModelBoundaryOptions {
  readonly path: string
  readonly versionSecret: string
  /** Host 可将缺省配置解析为可信默认文档；默认仍要求实际文件存在。 */
  readonly readDocument?: (path: string) => Record<string, unknown>
  /** 返回完整、已验证的运行配置，不能遗漏生效参数或密钥身份。 */
  resolveEffective(document: Record<string, unknown>, identity: RunIdentity): EffectiveModelConfiguration
  accessScope(identity: RunIdentity, configVersion: string, credentialVersion: string): Promise<{ contextScopeKey: string; accessScopeHash: string }>
}
function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('有效模型配置不可序列化')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('有效模型配置不可序列化')
  seen.add(value)
  for (const entry of Array.isArray(value) ? value : Object.values(value)) assertJson(entry, seen)
  seen.delete(value)
}
function readDocument(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new Error('模型配置不存在或格式无效') }
}
/** 实现内容版本，而非单调 revision；A→B→A 会恢复同一版本。 */
export function createFileModelSnapshotBoundary(options: FileModelBoundaryOptions): ModelSnapshotBoundary {
  if (!options.path || !options.versionSecret || typeof options.resolveEffective !== 'function' || typeof options.accessScope !== 'function') throw new Error('模型配置一致性边界不可用')
  const lock = createPosixConfigFileLock(), lockPath = join(dirname(options.path), `.${basename(options.path)}.lock`)
  let inside = false, current: EffectiveModelConfiguration | null = null
  const select = createModelStrategy(async () => {
    if (!current) throw new Error('模型配置未锁定')
    return { ...current, contextScopeKey: 'not-used', accessScopeHash: 'not-used' }
  })
  return {
    async withLockedConfig(work) {
      return lock.withExclusive(lockPath, async () => {
        if (inside) throw new Error('模型配置锁不可重入')
        inside = true
        try { return await work() } finally { current = null; inside = false }
      })
    },
    async readLockedModel(identity, ref, signal) {
      if (!inside) throw new Error('模型配置未锁定')
      signal.throwIfAborted()
      let effective: EffectiveModelConfiguration
      try { effective = options.resolveEffective(options.readDocument?.(options.path) ?? readDocument(options.path), identity) }
      catch { throw new Error('无法解析有效模型配置') }
      if (!effective || !effective.ai || typeof effective.ai.model !== 'string' || !effective.ai.model.trim() || typeof effective.byokEnabled !== 'boolean' || typeof effective.systemPrompt !== 'string' || !effective.versionMaterial || typeof effective.versionMaterial !== 'object' || !effective.versionMaterial.credentialsMasterKeys || typeof effective.versionMaterial.credentialsMasterKeys !== 'object' || Array.isArray(effective.versionMaterial.credentialsMasterKeys) || Object.values(effective.versionMaterial.credentialsMasterKeys).some(key => typeof key !== 'string' || !key) || (effective.byokEnabled || effective.ai.deployment_mode === 'local') && !Object.keys(effective.versionMaterial.credentialsMasterKeys).length || typeof effective.versionMaterial.permissionIdentity !== 'string' || !effective.versionMaterial.permissionIdentity || !effective.versionMaterial.environment || typeof effective.versionMaterial.environment !== 'object' || Array.isArray(effective.versionMaterial.environment)) throw new Error('有效模型配置不完整')
      let version: string
      try {
        assertJson(effective)
        version = createHmac('sha256', options.versionSecret).update(stableJson(['agent-model-content-v1', effective])).digest('hex')
        current = structuredClone(effective)
      } catch { throw new Error('有效模型配置无效') }
      try {
        const selected = await select(identity.ownerId, signal, ref)
        return { ...selected, configVersion: version }
      } finally { current = null }
    },
    accessScope: options.accessScope,
  }
}
