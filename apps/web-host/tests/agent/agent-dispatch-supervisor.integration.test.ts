import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createRedisAgentCancellationCommands } from '../../src/adapters/redis-events.js'
import { createRedisLiveSubscription } from '../../src/adapters/redis-live-subscription.js'
import { createAgentDispatchSupervisor } from '../../src/domains/agent-sessions/agent-dispatch-supervisor.js'
const url = process.env.GUGU_WEBUI_TEST_REDIS_URL

test('Redis 唤醒跨实例扫描，通知丢失时定期扫描仍恢复', { skip: !url && '需要隔离 Redis', timeout: 10000 }, async () => {
  const owner = randomUUID(), commands = createRedisAgentCancellationCommands(url!), calls: string[] = []
  let ready: Array<{ ownerId: string; sessionId: string }> = [], started!: () => void, observed!: () => void
  const firstScan = new Promise<void>(resolve => { started = resolve })
  let next = new Promise<void>(resolve => { observed = resolve })
  const make = () => createAgentDispatchSupervisor({ async listReady() { started(); const rows = ready; ready = []; return rows }, async kick(o, s) { calls.push(`${o}:${s}`); observed() }, publish: commands.publish, subscribe: createRedisLiveSubscription(url!), diagnose: () => {}, recoveryIntervalMs: 1000 })
  const receiver = make(), sender = make(), running = await receiver.start()
  try {
    await firstScan
    ready = [{ ownerId: owner, sessionId: '1' }]
    await sender.notify(); await next
    assert.deepEqual(calls, [`${owner}:1`])
    next = new Promise<void>(resolve => { observed = resolve })
    ready = [{ ownerId: owner, sessionId: '2' }]
    await next
    assert.deepEqual(calls, [`${owner}:1`, `${owner}:2`])
  } finally { await running.stop(); await running.drain() }
})
