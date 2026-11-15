import type { Pool, PoolClient } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { ProviderConfig } from '@gugu/core/providers'
import { readPostgresLlmCredentialSnapshot } from './credential-snapshot-postgres.js'
import type { RecoverableModelSnapshot } from './recoverable-provider.js'

/** 只有所有配置写入方共享该锁、并原子更新持久 revision，才能提供此能力。 */
export interface ModelSnapshotBoundary {
  withLockedConfig<T>(work: () => Promise<T>): Promise<T>
  readLockedModel(identity: RunIdentity, ref: string | undefined, signal: AbortSignal): Promise<{ modelRef: string; configVersion: string; config: ProviderConfig; systemPrompt: string; byokEnabled: boolean; localDeployment: boolean; release(): void }>
  accessScope(identity: RunIdentity, configVersion: string, credentialVersion: string): Promise<string>
}

/** 未显式注入可跨进程协调所有写入的边界时拒绝服务，不读取任何默认路径。 */
export function createAtomicAgentModelSnapshot(pool: Pick<Pool, 'connect'>, versionSecret: string, boundary: ModelSnapshotBoundary | null) {
  if (!versionSecret || !boundary) throw new Error('模型配置一致性边界不可用')
  return async (identity: RunIdentity, signal: AbortSignal, ref?: string): Promise<RecoverableModelSnapshot> => boundary.withLockedConfig(async () => {
    signal.throwIfAborted()
    const selected = await boundary.readLockedModel(identity, ref, signal)
    let client: PoolClient | undefined, committed = false, discard = false
    try {
      if (!selected.configVersion || !selected.modelRef || ref !== undefined && ref !== selected.modelRef) throw new Error('模型配置版本不可用')
      client = await pool.connect()
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const credentials = selected.byokEnabled || selected.localDeployment
        ? await readPostgresLlmCredentialSnapshot(client, identity.ownerId, versionSecret)
        : { credential: null, credentialVersion: 'disabled' }
      signal.throwIfAborted()
      const accessScopeHash = await boundary.accessScope(identity, selected.configVersion, credentials.credentialVersion)
      if (!accessScopeHash) throw new Error('模型访问范围不可用')
      await client.query('COMMIT'); committed = true
      return { ...selected, ...credentials, accessScopeHash }
    } catch (error) {
      if (client && !committed) try { await client.query('ROLLBACK') } catch { discard = true }
      selected.release()
      throw error
    } finally { client?.release(discard) }
  })
}
