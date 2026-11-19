import { createAgentRunEventStream as createCoreRunEventStream, type AgentRunEventReader, type RunIdentity } from '@gugu/core/agent'
import type { LiveSubscriptionFactory } from '../../adapters/redis-live-subscription.js'

interface Publisher { publish(channel: string, value: string): Promise<number> }
function channel(identity: RunIdentity): string {
  if (!identity.ownerId || !identity.runId || !/^[1-9]\d*$/.test(identity.sessionId)) throw new TypeError('Agent run 身份无效')
  return `agent-run-events:v1:${encodeURIComponent(identity.ownerId)}:${identity.sessionId}:${encodeURIComponent(identity.runId)}`
}

/** Web Host 将可信 Run 身份映射到 Redis 唤醒频道。 */
export function createAgentRunEventStream(reader: AgentRunEventReader, redis: Publisher, subscribe: LiveSubscriptionFactory, pollMs?: number) {
  return createCoreRunEventStream(reader, {
    async notify(identity) { await redis.publish(channel(identity), '1') },
    subscribe: identity => subscribe([channel(identity)]),
  }, pollMs)
}
