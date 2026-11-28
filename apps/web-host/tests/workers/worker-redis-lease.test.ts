import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COMPLETE_MESSAGE_SCRIPT,
  CLAIM_MESSAGE_SCRIPT,
  RENEW_MESSAGE_SCRIPT,
  RedisMessageLeaseStore,
  messageStateKey,
} from '../../src/workers/redis-message-lease.js'
import type { RedisEvalClient } from '../../src/workers/redis-message-lease.js'

class MemoryRedis implements RedisEvalClient {
  readonly values = new Map<string, { value: string; ttl: number }>()

  async eval(script: string, keyCount: number, key: string, ...args: Array<string | number>) {
    assert.equal(keyCount, 1)
    const current = this.values.get(key)
    if (script === CLAIM_MESSAGE_SCRIPT) {
      const [owner, ttl] = args as [string, number]
      if (current?.value === 'completed') return 2
      if (current) return 0
      this.values.set(key, { value: owner, ttl })
      return 1
    }
    if (script === RENEW_MESSAGE_SCRIPT) {
      const [owner, ttl] = args as [string, number]
      if (current?.value !== owner) return 0
      this.values.set(key, { value: owner, ttl })
      return 1
    }
    if (script === COMPLETE_MESSAGE_SCRIPT) {
      const [owner, ttl] = args as [string, number]
      if (current?.value === 'completed') return 1
      if (current?.value !== owner) return 0
      this.values.set(key, { value: 'completed', ttl })
      return 1
    }
    throw new Error('未知 Redis 脚本')
  }
}

test('消息状态键使用 Redis Cluster hash tag 保持同消息位于同一 slot', () => {
  assert.equal(messageStateKey('synthetic-1'), 'imstate:{synthetic-1}')
})

test('消息认领只在空状态成功，完成消息重领返回已完成', async () => {
  const redis = new MemoryRedis(), store = new RedisMessageLeaseStore(redis)
  const key = messageStateKey('synthetic-2')

  assert.equal(await store.claim(key, 'owner-a', 120), 'claimed')
  assert.equal(await store.claim(key, 'owner-b', 120), 'busy')
  assert.equal(await store.complete(key, 'owner-a', 3600), true)
  assert.equal(await store.claim(key, 'owner-b', 120), 'completed')
  assert.deepEqual(redis.values.get(key), { value: 'completed', ttl: 3600 })
})

test('续期仅允许当前 owner 延长 TTL，旧 owner 不能夺回租约', async () => {
  const redis = new MemoryRedis(), store = new RedisMessageLeaseStore(redis)
  const key = messageStateKey('synthetic-3')
  await store.claim(key, 'owner-a', 120)

  assert.equal(await store.renew(key, 'owner-a', 120), true)
  assert.equal(await store.renew(key, 'owner-b', 240), false)
  assert.deepEqual(redis.values.get(key), { value: 'owner-a', ttl: 120 })
})

test('仅当前 owner 可写入完成状态，完成状态允许幂等确认', async () => {
  const redis = new MemoryRedis(), store = new RedisMessageLeaseStore(redis)
  const key = messageStateKey('synthetic-4')
  await store.claim(key, 'owner-a', 120)

  assert.equal(await store.complete(key, 'owner-b', 3600), false)
  assert.equal(await store.complete(key, 'owner-a', 3600), true)
  assert.equal(await store.complete(key, 'owner-b', 3600), true)
  assert.deepEqual(redis.values.get(key), { value: 'completed', ttl: 3600 })
})
