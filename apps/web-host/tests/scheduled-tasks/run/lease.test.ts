import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { createScheduledTaskRedisLease } from '../../../src/modules/scheduled-tasks/run/lease.js'
import { createRedisScheduledTaskCommands } from '../../../src/adapters/cache/redis-events.js'
import { randomInt } from 'node:crypto'
const run = promisify(execFile)
const socket = process.env.GUGU_TEST_REDIS_SOCKET

test('Redis 任务锁跨调用方互斥，错误 token 不能续租或释放', { skip: !socket && '需要隔离 Redis socket' }, async () => {
  const command = async (...args: string[]) => (await run('redis-cli', ['-s', socket!, '--raw', ...args])).stdout.trim()
  const lease = createScheduledTaskRedisLease({
    set: (key, value, ...options) => command('SET', key, value, ...options),
    eval: (script, count, ...args) => command('EVAL', script, String(count), ...args),
    exists: (key) => command('EXISTS', key),
  })
  assert.equal(await lease.acquire('123', 'owner-a', 10000), true)
  assert.equal(await lease.acquire('123', 'owner-b', 10000), false)
  assert.equal(await lease.renew('123', 'owner-b', 10000), false)
  await lease.release('123', 'owner-b')
  assert.equal(await lease.isHeld('123'), true)
  assert.equal(await lease.renew('123', 'owner-a', 10000), true)
  await lease.release('123', 'owner-a')
  assert.equal(await lease.isHeld('123'), false)
})

test('生产 Redis 命令适配器支持任务锁 token 互斥与释放', { skip: !process.env.GUGU_TEST_REDIS_URL && '需要隔离 Redis' }, async () => {
  const lease = createScheduledTaskRedisLease(createRedisScheduledTaskCommands(process.env.GUGU_TEST_REDIS_URL!))
  const id = String(randomInt(1, 2_000_000_000))
  try {
    assert.equal(await lease.acquire(id, 'first', 10_000), true)
    assert.equal(await lease.acquire(id, 'second', 10_000), false)
    assert.equal(await lease.renew(id, 'second', 10_000), false)
    await lease.release(id, 'second')
    assert.equal(await lease.isHeld(id), true)
    assert.equal(await lease.renew(id, 'first', 10_000), true)
    await lease.release(id, 'first')
    assert.equal(await lease.isHeld(id), false)
  } finally { await lease.release(id, 'first') }
})
