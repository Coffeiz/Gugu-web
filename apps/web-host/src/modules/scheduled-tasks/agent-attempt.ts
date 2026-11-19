import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { canonicalToolsUsed, type CanonicalRunContext, type RunIdentity } from '@gugu/core/agent'
import { createScheduledTaskAgentAttempt, createScheduledTaskHarness,
  type ScheduledTaskExecutionPorts } from '@gugu/core/scheduled-task-run-now'
import type { createConfiguredWebAgentProviderBinding } from '../agent/model-config/configured-web-provider-binding.js'
import { withPostgresTransaction } from '../../adapters/postgres-transaction.js'
import { recordAgentUsage } from '../../modules/agent-sessions/persistence/agent-usage-postgres.js'

type AttemptInput = Parameters<ScheduledTaskExecutionPorts<unknown>['attempt']>[0]
type BindProvider = Awaited<ReturnType<typeof createConfiguredWebAgentProviderBinding>>['bind']
type BoundModel = Awaited<ReturnType<BindProvider>>
type HarnessOptions = Parameters<typeof createScheduledTaskHarness>[0]

/** 每次尝试使用独立的 Run 身份，按任务 owner 绑定模型，结束后释放本轮凭据。 */
export function createWebScheduledTaskAgentAttempt(options: {
  bindProvider: BindProvider
  usagePool: Pick<Pool, 'connect'>
  onUsageFailure?: () => void
  prepareHarness(input: AttemptInput & {
    identity: RunIdentity
    model: Omit<BoundModel, 'release'>
  }): Promise<Omit<HarnessOptions, 'identity' | 'leaseToken' | 'provider' | 'assertScheduledLease'> & {
    provider: Omit<HarnessOptions['provider'], 'resolve'>
  }>
}): ScheduledTaskExecutionPorts<unknown>['attempt'] {
  return createScheduledTaskAgentAttempt<CanonicalRunContext>(async input => {
    const identity = Object.freeze({ ownerId: input.task.ownerId,
      sessionId: `scheduled-task:${input.task.id}`, runId: randomUUID() })
    const { release, resolve, ...model } = await options.bindProvider(identity, new AbortController().signal)
    let released = false
    const releaseModel = () => {
      if (released) return
      released = true
      release()
    }
    try {
      const scopedResolve: BoundModel['resolve'] = async (candidate, modelIdentity, signal) => {
        if (released) throw new Error('定时任务模型绑定已释放')
        const selected = await resolve(candidate, modelIdentity, signal)
        if (released) throw new Error('定时任务模型绑定已释放')
        return selected
      }
      const prepared = await options.prepareHarness({
        ...input,
        identity,
        model: { ...model, resolve: scopedResolve },
      })
      const runtime = createScheduledTaskHarness({
        ...prepared, identity, leaseToken: identity.runId, assertScheduledLease: input.assertLease,
        provider: { ...prepared.provider, resolve: scopedResolve },
      })
      return {
        identity, harness: runtime.harness,
        hasUnresolvedToolErrors: runtime.hasUnresolvedToolErrors,
        async recordUsage(checkpoint) {
          const { totalUsage } = checkpoint
          if (!(totalUsage.input || totalUsage.output || totalUsage.cacheRead || totalUsage.cacheWrite)) return
          try {
            await withPostgresTransaction(options.usagePool, client => recordAgentUsage(client, identity,
              totalUsage, model.usageConfig, [], canonicalToolsUsed(checkpoint, []), 'scheduled'))
          } catch {
            if (options.onUsageFailure) options.onUsageFailure()
            else console.warn('定时任务模型用量结算失败')
          }
        },
        async close() {
          try { await runtime.close() } finally { releaseModel() }
        },
      }
    } catch (error) {
      releaseModel()
      throw error
    }
  })
}
