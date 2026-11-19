import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { createFileModelSnapshotBoundary, type EffectiveModelConfiguration } from './files.js'
import { createAtomicAgentModelSnapshot } from './snapshot.js'
import { bindRecoverableProvider } from './recovery.js'
import type { RecoverableProviderServices } from './recovery.js'
import type { ByokCredential } from '../../byok/store.js'

/** Host 解析当前真实运行配置及访问权限；本工厂负责让选择、凭据、恢复绑定共用一致性边界。 */
export interface WebAgentProviderBindingOptions {
  pool: Pick<Pool, 'connect'>
  configPath: string
  versionSecret: string
  readConfiguration?(path: string): Record<string, unknown>
  resolveEffective(document: Record<string, unknown>, identity: RunIdentity): EffectiveModelConfiguration
  resolveAccessScope(identity: RunIdentity, configVersion: string, credentialVersion: string, permissionIdentity: string): Promise<{ contextScopeKey: string; accessScopeHash: string }>
  decryptCredential(row: ByokCredential): string
  defaultBaseUrl(provider: string, format: string): string
  defaultLimit6h: number | null
}

/**
 * 文件配置读使用与 Host/Python 写路径相同的 POSIX flock；版本由完整有效配置内容计算，
 * 凭据在 PG repeatable-read 快照中读取。未提供有效配置和 scope/access 摘要解析器时拒绝创建。
 */
export function createWebAgentProviderBinding(options: WebAgentProviderBindingOptions) {
  if (!options.configPath || !options.versionSecret || typeof options.resolveEffective !== 'function' || typeof options.resolveAccessScope !== 'function'
    || typeof options.decryptCredential !== 'function' || typeof options.defaultBaseUrl !== 'function') throw new Error('Web Agent 模型绑定配置不完整')

  const permissions = new Map<string, string>()
  const runKey = (identity: RunIdentity) => JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])
  const boundary = createFileModelSnapshotBoundary({
    path: options.configPath,
    versionSecret: options.versionSecret,
    readDocument: options.readConfiguration,
    resolveEffective(document, identity) {
      const effective = options.resolveEffective(document, identity)
      if (effective?.versionMaterial?.permissionIdentity) permissions.set(runKey(identity), effective.versionMaterial.permissionIdentity)
      return effective
    },
    accessScope(identity, configVersion, credentialVersion) {
      const permissionIdentity = permissions.get(runKey(identity))
      permissions.delete(runKey(identity))
      if (!permissionIdentity) throw new Error('模型权限版本不可用')
      return options.resolveAccessScope(identity, configVersion, credentialVersion, permissionIdentity)
    },
  })
  const select = createAtomicAgentModelSnapshot(options.pool, options.versionSecret, boundary, options.defaultLimit6h)
  const services: RecoverableProviderServices = {
    select,
    async verifyCredential(identity, id, version, signal) {
      try { await select.verifyCredential(identity, id, version, signal) }
      finally { permissions.delete(runKey(identity)) }
    },
    decryptCredential: options.decryptCredential,
    defaultBaseUrl: options.defaultBaseUrl,
  }

  const bind = async (identity: RunIdentity, signal: AbortSignal,
    recovery?: { identity: RunIdentity; modelIdentity: string; accessScopeHash: string }, credentialId?: number) => {
    try { return await bindRecoverableProvider(identity, services, options.versionSecret, signal, recovery, credentialId) }
    finally { permissions.delete(runKey(identity)) }
  }

  return {
    /**
     * 在 Web 消息入持久队列前解析可信模型/权限/凭据版本。
     * 只返回不透明摘要并立即释放凭据快照；重建时仍须重新绑定并精确比对。
     */
    async accessVersion(identity: RunIdentity): Promise<string> {
      const bound = await bind(identity, new AbortController().signal)
      try { return bound.contextScopeKey }
      finally { bound.release() }
    },
    async bind(
      identity: RunIdentity,
      signal: AbortSignal,
      recovery?: { identity: RunIdentity; modelIdentity: string; accessScopeHash: string },
      credentialId?: number,
    ) {
      return bind(identity, signal, recovery, credentialId)
    },
  }
}
