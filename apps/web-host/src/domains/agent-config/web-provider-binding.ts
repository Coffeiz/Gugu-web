import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { createFileModelSnapshotBoundary, type EffectiveModelConfiguration } from './file-model-snapshot-boundary.js'
import { createAtomicAgentModelSnapshot } from './atomic-model-snapshot.js'
import { bindRecoverableProvider } from './recoverable-provider.js'
import type { RecoverableProviderServices } from './recoverable-provider.js'
import type { ByokCredential } from './byok.js'
import { agentAccessScopeHash } from './access-scope.js'

/** Host 解析当前真实运行配置及访问权限；本工厂负责让选择、凭据、恢复绑定共用一致性边界。 */
export interface WebAgentProviderBindingOptions {
  pool: Pick<Pool, 'connect'>
  configPath: string
  versionSecret: string
  resolveEffective(document: Record<string, unknown>, identity: RunIdentity): EffectiveModelConfiguration
  decryptCredential(row: ByokCredential): string
  defaultBaseUrl(provider: string, format: string): string
}

/**
 * 文件配置读使用与 Host/Python 写路径相同的 POSIX flock；版本由完整有效配置内容计算，
 * 凭据在 PG repeatable-read 快照中读取。未提供有效配置和权限版本解析器时拒绝创建。
 */
export function createWebAgentProviderBinding(options: WebAgentProviderBindingOptions) {
  if (!options.configPath || !options.versionSecret || typeof options.resolveEffective !== 'function'
    || typeof options.decryptCredential !== 'function' || typeof options.defaultBaseUrl !== 'function') throw new Error('Web Agent 模型绑定配置不完整')

  const permissions = new Map<string, string>()
  const runKey = (identity: RunIdentity) => JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])
  const boundary = createFileModelSnapshotBoundary({
    path: options.configPath,
    versionSecret: options.versionSecret,
    resolveEffective(document, identity) {
      const effective = options.resolveEffective(document, identity)
      if (effective?.versionMaterial?.permissionIdentity) permissions.set(runKey(identity), effective.versionMaterial.permissionIdentity)
      return effective
    },
    accessScope(identity, configVersion, credentialVersion) {
      const permissionIdentity = permissions.get(runKey(identity))
      permissions.delete(runKey(identity))
      if (!permissionIdentity) throw new Error('模型权限版本不可用')
      return Promise.resolve(agentAccessScopeHash(options.versionSecret, identity.ownerId, {
        permissions: permissionIdentity,
        model: configVersion,
        credentials: credentialVersion,
      }))
    },
  })
  const select = createAtomicAgentModelSnapshot(options.pool, options.versionSecret, boundary)
  const services: RecoverableProviderServices = {
    select,
    decryptCredential: options.decryptCredential,
    defaultBaseUrl: options.defaultBaseUrl,
  }

  return {
    async bind(
      identity: RunIdentity,
      signal: AbortSignal,
      recovery?: { identity: RunIdentity; modelIdentity: string; accessScopeHash: string },
    ) {
      return bindRecoverableProvider(identity, services, options.versionSecret, signal, recovery)
    },
  }
}
