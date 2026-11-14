import type { CancellationPort, RunIdentity } from '@gugu/core/harness'
import type { RedisAgentCancellationCommands } from '../../../adapters/redis-events.js'
import type { LiveSubscriptionFactory } from '../../../adapters/redis-live-subscription.js'

const DEFAULT_CANCEL_TTL_SECONDS = 300
const CHANNEL_PREFIX = 'agent-run-cancel:v1'
const KEY_PREFIX = 'agent-run-cancel:v1'

function validateIdentity(identity: RunIdentity): void {
  if (!identity.ownerId || identity.ownerId.length > 128 || /[\r\n]/.test(identity.ownerId)
    || !/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(Number(identity.sessionId))
    || !identity.runId || identity.runId.length > 128 || /[\r\n]/.test(identity.runId))
    throw new TypeError('Agent run cancellation identity invalid')
}

function keyPart(value: string): string {
  return encodeURIComponent(value)
}

function ownerChannel(ownerId: string): string {
  return `${CHANNEL_PREFIX}:${keyPart(ownerId)}`
}

function runKey(identity: RunIdentity): string {
  return `${KEY_PREFIX}:${keyPart(identity.ownerId)}:${identity.sessionId}:${keyPart(identity.runId)}`
}

function matchesMessage(data: string, identity: RunIdentity): boolean {
  try {
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const message = value as Record<string, unknown>
    return message.ownerId === identity.ownerId
      && message.sessionId === identity.sessionId
      && message.runId === identity.runId
  } catch {
    return false
  }
}

/** Redis cancellation is run-scoped; the durable marker is written before its wake-up publish. */
export function createRedisAgentRunCancellationPort(
  redis: RedisAgentCancellationCommands,
  subscribe: LiveSubscriptionFactory,
  ttlSeconds = DEFAULT_CANCEL_TTL_SECONDS,
): CancellationPort {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
    throw new RangeError('Agent run cancellation TTL invalid')

  return {
    async isRequested(identity) {
      validateIdentity(identity)
      return (await redis.get(runKey(identity))) === identity.runId
    },

    async request(identity) {
      validateIdentity(identity)
      if (!await redis.set(runKey(identity), identity.runId, ttlSeconds))
        throw new Error('Agent run cancellation marker was not stored')
    },

    async notify(identity) {
      validateIdentity(identity)
      await redis.publish(ownerChannel(identity.ownerId), JSON.stringify({
        ownerId: identity.ownerId,
        sessionId: identity.sessionId,
        runId: identity.runId,
      }))
    },

    async subscribe(identity, listener) {
      validateIdentity(identity)
      const channel = ownerChannel(identity.ownerId)
      const subscription = await subscribe([channel])
      const controller = new AbortController()
      const consume = async () => {
        while (!controller.signal.aborted) {
          const message = await subscription.next(controller.signal)
          if (!message) return
          if (message.channel === channel && matchesMessage(message.data, identity))
            listener()
        }
      }
      const task = consume().catch(() => {
        if (!controller.signal.aborted)
          console.error('gugu-webui Agent cancellation subscription failed')
      })
      return () => {
        controller.abort()
        void subscription.close().catch(() => {
          console.error('gugu-webui Agent cancellation subscription close failed')
        })
        void task
      }
    },
  }
}
