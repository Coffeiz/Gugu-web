import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveSubscription, LiveSubscriptionFactory, LiveSubscriptionMessage } from '../../src/adapters/redis-live-subscription.js'
import { createRedisAgentRunCancellationPort } from '../../src/domains/agent-sessions/persistence/agent-run-cancellation-redis.js'

const identity = { ownerId: 'owner-1', sessionId: '17', runId: 'run-1' }

class QueueSubscription implements LiveSubscription {
  closed = false
  private readonly messages: LiveSubscriptionMessage[] = []
  private readonly waiters: Array<(message: LiveSubscriptionMessage | null) => void> = []

  async next(signal: AbortSignal): Promise<LiveSubscriptionMessage | null> {
    if (this.messages.length) return this.messages.shift()!
    if (this.closed || signal.aborted) return null
    return new Promise((resolve) => {
      const done = (message: LiveSubscriptionMessage | null) => {
        signal.removeEventListener('abort', aborted)
        resolve(message)
      }
      const aborted = () => {
        const index = this.waiters.indexOf(done)
        if (index >= 0) this.waiters.splice(index, 1)
        done(null)
      }
      this.waiters.push(done)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    for (const resolve of this.waiters.splice(0)) resolve(null)
  }

  push(message: LiveSubscriptionMessage): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(message)
    else this.messages.push(message)
  }
}

function makeRedis() {
  const values = new Map<string, string>()
  const calls: string[][] = []
  return {
    values,
    calls,
    get: async (key: string) => { calls.push(['GET', key]); return values.get(key) ?? null },
    set: async (key: string, value: string, ttlSeconds: number) => {
      calls.push(['SET', key, value, String(ttlSeconds)])
      values.set(key, value)
      return true
    },
    publish: async (channel: string, value: string) => {
      calls.push(['PUBLISH', channel, value])
      return 1
    },
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('run cancellation stores an owner/session/run marker before publishing a run-scoped wake-up', async () => {
  const redis = makeRedis()
  const subscriptions: string[][] = []
  const factory: LiveSubscriptionFactory = async (channels) => {
    subscriptions.push([...channels])
    return new QueueSubscription()
  }
  const port = createRedisAgentRunCancellationPort(redis, factory)

  assert.equal(await port.isRequested(identity), false)
  await port.request(identity)
  await port.notify(identity)

  assert.equal(await port.isRequested(identity), true)
  assert.deepEqual(redis.calls.map(([operation]) => operation), ['GET', 'SET', 'PUBLISH', 'GET'])
  assert.deepEqual(redis.calls[1], ['SET', 'agent-run-cancel:v1:owner-1:17:run-1', 'run-1', '300'])
  assert.deepEqual(redis.calls[2], [
    'PUBLISH', 'agent-run-cancel:v1:owner-1',
    JSON.stringify({ ownerId: 'owner-1', sessionId: '17', runId: 'run-1' }),
  ])

  const otherRun = { ...identity, runId: 'run-2' }
  assert.equal(await port.isRequested(otherRun), false)
  assert.deepEqual(redis.calls.at(-1), ['GET', 'agent-run-cancel:v1:owner-1:17:run-2'])
  assert.deepEqual(subscriptions, [])
})

test('run cancellation subscription wakes only the exact owner, session, and run', async () => {
  const redis = makeRedis()
  const subscription = new QueueSubscription()
  let subscribedChannels: readonly string[] = []
  const factory: LiveSubscriptionFactory = async (channels) => {
    subscribedChannels = [...channels]
    return subscription
  }
  const port = createRedisAgentRunCancellationPort(redis, factory)
  let wakeups = 0
  const close = await port.subscribe(identity, () => { wakeups += 1 })

  const channel = 'agent-run-cancel:v1:owner-1'
  subscription.push({ channel, data: JSON.stringify({ ...identity, runId: 'another-run' }) })
  await tick()
  assert.equal(wakeups, 0)

  subscription.push({ channel, data: JSON.stringify(identity) })
  await tick()
  assert.equal(wakeups, 1)

  subscription.push({ channel: 'agent-run-cancel:v1:other-owner', data: JSON.stringify(identity) })
  await tick()
  assert.equal(wakeups, 1)
  assert.deepEqual(subscribedChannels, [channel])

  close()
  await tick()
  assert.equal(subscription.closed, true)
})

test('run cancellation rejects malformed identities before touching Redis', async () => {
  const redis = makeRedis()
  const port = createRedisAgentRunCancellationPort(redis, async () => new QueueSubscription())
  await assert.rejects(
    port.request({ ...identity, sessionId: '0' }),
    /Agent run cancellation identity invalid/,
  )
  assert.deepEqual(redis.calls, [])
})

test('run cancellation never publishes when the durable marker write is rejected', async () => {
  const base = makeRedis()
  const redis = {
    ...base,
    set: async (key: string, value: string, ttlSeconds: number) => {
      base.calls.push(['SET', key, value, String(ttlSeconds)])
      return false
    },
  }
  const port = createRedisAgentRunCancellationPort(redis, async () => new QueueSubscription())

  await assert.rejects(port.request(identity), /Agent run cancellation marker was not stored/)
  assert.deepEqual(redis.calls.map(([operation]) => operation), ['SET'])
})
