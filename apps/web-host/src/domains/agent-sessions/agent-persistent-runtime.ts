import type { Pool } from 'pg'
import type { CanonicalRunContext, RunIdentity } from '@gugu/core/agent'
import type { RedisAgentCancellationCommands } from '../../adapters/redis-events.js'
import type { LiveSubscriptionFactory } from '../../adapters/redis-live-subscription.js'
import { createAgentRuntime, type AgentRuntimeOptions } from './agent-runtime.js'
import { createAgentRunEventStream } from './agent-run-event-stream.js'
import { createPostgresAgentRunStore, type AgentRunStoreOptions } from './persistence/agent-run-store-postgres.js'
import { createPostgresAgentRunLeasePort } from './persistence/agent-run-lease-postgres.js'
import { createRedisAgentRunCancellationPort } from './persistence/agent-run-cancellation-redis.js'
import { applyCanonicalSnapshotEffects } from './persistence/agent-snapshot-effects-postgres.js'
import { createAgentRunStateReader, createPostgresAgentRunStartupStore } from './persistence/agent-run-startup-postgres.js'
import { createPostgresInteractionActivator, type AgentPromptActivationPorts } from './persistence/agent-interaction-activate-postgres.js'

export interface PersistentAgentRuntimeOptions extends Omit<AgentRuntimeOptions, 'runtime'> {
  pool: Pick<Pool, 'query' | 'connect'>
  secretKey: string
  redis: RedisAgentCancellationCommands
  subscribe: LiveSubscriptionFactory
  history: Omit<AgentRunStoreOptions<CanonicalRunContext>, 'applyPreparedContext'>
  interactionActivation?: AgentPromptActivationPorts
  /** 调度路径必须显式提供当前选中租约；直接模式只用于尚未切换的独立调用方。 */
  scheduling: { mode: 'dispatch'; leaseFor(identity: RunIdentity): { token: string; fence: number } | null; readReconstructionStatus(identity: RunIdentity): Promise<'unavailable' | 'version_conflict' | null> } | { mode: 'direct' }
  runtime: Omit<AgentRuntimeOptions['runtime'], 'store' | 'leases' | 'cancellation'>
}

/** 显式要求事务内历史写入器，不能以空操作伪装持久化成功。 */
export function createPersistentAgentRuntime(options: PersistentAgentRuntimeOptions) {
  if (options.scheduling.mode === 'dispatch' && (typeof options.scheduling.leaseFor !== 'function' || typeof options.scheduling.readReconstructionStatus !== 'function'))
    throw new TypeError('持久调度必须提供租约及重建状态读取端口')
  const cancellation = createRedisAgentRunCancellationPort(options.redis, options.subscribe)
  const store = createPostgresAgentRunStore(options.pool, options.secretKey, {
    ...options.history,
    applyPreparedContext: applyCanonicalSnapshotEffects,
  })
  const startup = createPostgresAgentRunStartupStore(options.pool)
  const events = createAgentRunEventStream({
    readEventsAfter: store.readEventsAfter,
    readState: createAgentRunStateReader(store, startup, options.scheduling.mode === 'dispatch' ? options.scheduling : undefined),
  }, options.redis, options.subscribe)
  const result = createAgentRuntime({
    context: options.context,
    runPreparation: options.runPreparation,
    executor: options.executor,
    provider: options.provider,
    runtime: {
      ...options.runtime,
      ...(options.interactionActivation ? { interactions: createPostgresInteractionActivator(options.pool, options.interactionActivation) } : {}),
      async publish(event, signal) {
        await options.runtime.publish(event, signal)
        await events.notify(event.identity)
      },
      store,
      leases: createPostgresAgentRunLeasePort(options.pool, options.scheduling.mode === 'dispatch' ? { dispatchLease: options.scheduling.leaseFor } : {}),
      cancellation,
    },
  })
  return { ...result, store, cancellation, events, startup }
}
