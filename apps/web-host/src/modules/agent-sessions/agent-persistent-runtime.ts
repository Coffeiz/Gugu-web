import type { Pool } from 'pg'
import { createAgentRunStateReader, createAgentRuntime, createAgentRuntimeWithContextFactory, type AgentRuntimeOptions, type AgentRuntimeContextFactoryOptions, type CanonicalRunContext, type RunIdentity } from '@gugu/core/agent'
import { createNodeProviderTransportFactory } from '@gugu/core/providers/node'
import type { RedisAgentCancellationCommands } from '../../adapters/cache/redis-events.js'
import type { LiveSubscriptionFactory } from '../../adapters/cache/redis-live-subscription.js'
import { createAgentRunEventStream } from './agent-run-event-stream.js'
import { createPostgresAgentRunStore, type AgentRunStoreOptions } from './persistence/agent-run-store-postgres.js'
import { createPostgresAgentRunLeasePort } from './persistence/agent-run-lease-postgres.js'
import { createRedisAgentRunCancellationPort } from './persistence/agent-run-cancellation-redis.js'
import { applyCanonicalSnapshotEffects } from './persistence/agent-snapshot-effects-postgres.js'
import { createPostgresAgentRunStartupStore } from './persistence/agent-run-startup-postgres.js'
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
  runtime: Omit<AgentRuntimeOptions['runtime'], 'store' | 'leases' | 'cancellation' | 'interactions'> & {
    interactions?: AgentRuntimeOptions['runtime']['interactions']
  }
}

/** 同步/异步入口共用唯一持久化、调度与取消装配，不复制生命周期。 */
function persistentResources(options: Omit<PersistentAgentRuntimeOptions, 'context'>) {
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
  const interactions = options.interactionActivation ? createPostgresInteractionActivator(options.pool, options.interactionActivation) : options.runtime.interactions
  if (!interactions) throw new TypeError('持久运行必须配置真实交互激活服务')
  const runner = {
    observation: options.observation,
    runPreparation: options.runPreparation,
    executor: options.executor,
    provider: {
      ...options.provider,
      ...(!options.provider.transport && !options.provider.createTransport && !options.provider.transportFactory
        ? { transportFactory: createNodeProviderTransportFactory() } : {}),
    },
    runtime: {
      ...options.runtime,
      interactions,
      async publish(event: Parameters<AgentRuntimeOptions['runtime']['publish']>[0], signal?: AbortSignal) {
        await options.runtime.publish(event, signal)
        await events.notify(event.identity)
      },
      store,
      leases: createPostgresAgentRunLeasePort(options.pool, options.scheduling.mode === 'dispatch' ? { dispatchLease: options.scheduling.leaseFor } : {}),
      cancellation,
    },
  }
  return { runner, persistent: { store, cancellation, events, startup } }
}

/** 显式要求事务内历史写入器，不能以空操作伪装持久化成功。 */
export function createPersistentAgentRuntime(options: PersistentAgentRuntimeOptions) {
  const { runner, persistent } = persistentResources(options)
  return { ...createAgentRuntime({ ...runner, context: options.context }), ...persistent }
}

export interface PersistentAgentRuntimeContextFactoryOptions extends Omit<PersistentAgentRuntimeOptions, 'context'> {
  context: AgentRuntimeContextFactoryOptions['context']
}

/** 完整context由同一ProviderRuntime构建；装配失败不创建另一套Run或存储。 */
export async function createPersistentAgentRuntimeWithContextFactory(options: PersistentAgentRuntimeContextFactoryOptions) {
  const { runner, persistent } = persistentResources(options)
  return { ...await createAgentRuntimeWithContextFactory({ ...runner, context: options.context }), ...persistent }
}
