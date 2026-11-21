import { createSerialWorker, type SerialWorker } from '../../../workers/admission.js'
import { randomUUID } from 'node:crypto'
import { createAgentDispatchRuntime, createAgentRunStateReader } from '@gugu/core/agent'
import type { AgentObservationPort, CanonicalRunContext, RunIdentity } from '@gugu/core/agent'
import type { Pool } from 'pg'
import { createRedisAgentCancellationCommands } from '../../../adapters/cache/redis-events.js'
import { createRedisLiveSubscription } from '../../../adapters/cache/redis-live-subscription.js'
import type { AgentChatInput, AgentChatService } from '../chat/routes.js'
import { createAgentRunEventStream } from './stream.js'
import { createPostgresAgentDispatch, type AgentDispatchLease, type RunModelPin } from './dispatch.js'
import { createRedisAgentRunCancellationPort } from './cancel.js'
import { createPostgresAgentRunStore } from './store.js'
import { createPostgresAgentRunStartupStore } from './start.js'
import { createPostgresWebAgentChatPreparation } from '../chat/web.js'

/**
 * Web Agent 的持久 Chat/dispatch 生命周期。业务上下文、Provider、工具授权与执行能力
 * 由调用方提供的 Reconstructor 负责；本模块只组合既有 Core Harness 与 PG/Redis 端口。
 */
export function createWebAgentRunLifecycle(options: {
  pool: Pick<Pool, 'query' | 'connect'>
  secretKey: string
  observation?: AgentObservationPort
  runAgent?: SerialWorker
  storageRoot?: string
  redisUrl: string
  dispatchTtlSeconds: number
  accessVersion(identity: RunIdentity): Promise<string>
  pin?(identity: RunIdentity, credentialId?: number | null): Promise<RunModelPin & { accessVersion: string }>
  reconstruct: ReturnType<typeof import('./reconstruct.js').createWebAgentReconstructor>
  project(event: import('@gugu/core/agent').RunEvent): Promise<readonly import('../chat/routes.js').AgentChatEvent[]>
  diagnose(code: 'scan_failed' | 'worker_failed' | 'subscription_failed'): void
}): { service: AgentChatService; start(): Promise<void>; close(): Promise<void> } {
  if (!options.redisUrl.trim()) throw new TypeError('Web Agent 持久运行需要 Redis')
  if (!options.secretKey.trim()) throw new TypeError('Web Agent 持久运行密钥未配置')
  const redis = createRedisAgentCancellationCommands(options.redisUrl)
  const subscribe = createRedisLiveSubscription(options.redisUrl)
  const dispatch = createPostgresAgentDispatch(options.pool, options.secretKey)
  const startup = createPostgresAgentRunStartupStore(options.pool)
  // 该 store 仅为事件读取提供解密和 owner 约束；实际提交由每个 Reconstructor
  // 的绑定 history writer 执行，避免从全局默认值推断模型用量配置。
  const eventStore = createPostgresAgentRunStore<CanonicalRunContext>(options.pool, options.secretKey, {
    async writeHistory() { throw new Error('只读 Agent event store 不接受历史写入') },
  })
  const events = createAgentRunEventStream({
    readEventsAfter: eventStore.readEventsAfter,
    readState: createAgentRunStateReader({ read: dispatch.readStreamCheckpoint }, startup, dispatch),
  }, redis, subscribe)
  const preparation = createPostgresWebAgentChatPreparation(options.pool, {
    storageRoot: options.storageRoot,
    dispatchSecret: options.secretKey,
    dispatchTtlSeconds: options.dispatchTtlSeconds,
    observation: options.observation,
  })
  return createAgentDispatchRuntime<CanonicalRunContext, AgentDispatchLease, AgentChatInput>({
    dispatch,
    worker: { reconstruct: options.reconstruct, runExclusive: options.runAgent ?? createSerialWorker() },
    supervisor: { concurrency: 1, publish: redis.publish, subscribe, diagnose: options.diagnose },
    chat: {
      cancellation: createRedisAgentRunCancellationPort(redis, subscribe),
      async prepare(ownerId, input, origin) {
        const runId = randomUUID()
        const result = await preparation(ownerId, input, runId, {
          mode: 'dispatch', origin: origin ?? null,
          accessVersion: identity => options.accessVersion(identity),
          pin: options.pin,
          ttlSeconds: options.dispatchTtlSeconds,
        })
        return { identity: { ownerId, sessionId: String(result.sessionId), runId }, userMessageId: result.userMessageId }
      },
      events,
      project: options.project,
      async failStart(identity) { await startup.failStart(identity) },
    },
  })
}
