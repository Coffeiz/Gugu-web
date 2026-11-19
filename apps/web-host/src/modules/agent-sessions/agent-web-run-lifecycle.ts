import { randomUUID } from 'node:crypto'
import { createAgentDispatchRuntime, createAgentRunStateReader } from '@gugu/core/agent'
import type { CanonicalRunContext, RunIdentity } from '@gugu/core/agent'
import type { Pool } from 'pg'
import { createRedisAgentCancellationCommands } from '../../adapters/cache/redis-events.js'
import { createRedisLiveSubscription } from '../../adapters/cache/redis-live-subscription.js'
import type { AgentChatInput, AgentChatService } from './agent-chat-route.js'
import { createAgentRunEventStream } from './agent-run-event-stream.js'
import { createPostgresAgentDispatch, type AgentDispatchLease } from './persistence/agent-run-dispatch-postgres.js'
import { createRedisAgentRunCancellationPort } from './persistence/agent-run-cancellation-redis.js'
import { createPostgresAgentRunStore } from './persistence/agent-run-store-postgres.js'
import { createPostgresAgentRunStartupStore } from './persistence/agent-run-startup-postgres.js'
import { createPostgresWebAgentChatPreparation } from './persistence/agent-web-chat-preparation.js'

/**
 * Web Agent 的持久 Chat/dispatch 生命周期。业务上下文、Provider、工具授权与执行能力
 * 由调用方提供的 Reconstructor 负责；本模块只组合既有 Core Harness 与 PG/Redis 端口。
 */
export function createWebAgentRunLifecycle(options: {
  pool: Pick<Pool, 'query' | 'connect'>
  secretKey: string
  redisUrl: string
  dispatchTtlSeconds: number
  accessVersion(identity: RunIdentity): Promise<string>
  reconstruct: ReturnType<typeof import('./agent-web-reconstructor.js').createWebAgentReconstructor>
  project(event: import('@gugu/core/agent').RunEvent): Promise<readonly import('./agent-chat-route.js').AgentChatEvent[]>
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
    dispatchSecret: options.secretKey,
    dispatchTtlSeconds: options.dispatchTtlSeconds,
  })
  return createAgentDispatchRuntime<CanonicalRunContext, AgentDispatchLease, AgentChatInput>({
    dispatch,
    worker: { reconstruct: options.reconstruct },
    supervisor: { publish: redis.publish, subscribe, diagnose: options.diagnose },
    chat: {
      cancellation: createRedisAgentRunCancellationPort(redis, subscribe),
      async prepare(ownerId, input, origin) {
        const runId = randomUUID()
        const result = await preparation(ownerId, input, runId, {
          mode: 'dispatch', origin: origin ?? null,
          accessVersion: identity => options.accessVersion(identity),
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
