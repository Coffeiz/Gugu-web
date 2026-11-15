import type { Pool } from 'pg'
import type { CanonicalRunContext, AgentRunner, RunStore } from '@gugu/core/agent'
import { createPostgresInteractionResumeQueue } from './persistence/agent-interaction-resume-postgres.js'
import { createInteractionRecoveryWorker } from './agent-interaction-worker.js'

/** 由 Host 生命周期显式管理；恢复仍使用运行时已有 Harness 和租约。 */
export function createPersistentInteractionWorker(options: {
  pool: Pick<Pool, 'query'>
  store: Pick<RunStore<CanonicalRunContext>, 'read'>
  harness: Pick<AgentRunner<CanonicalRunContext>, 'resume'>
  invalidateCredential(ownerId: string, serverId: string): Promise<void>
  diagnose(): void
  intervalMs?: number
}) {
  const queue = createPostgresInteractionResumeQueue(options.pool)
  return createInteractionRecoveryWorker({ queue, read: identity => options.store.read(identity),
    resume: (identity, resolution) => options.harness.resume(identity, resolution),
    invalidateCredential: options.invalidateCredential, diagnose: options.diagnose }, options.intervalMs)
}
