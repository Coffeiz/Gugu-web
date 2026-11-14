import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createRedisFilesystemAuthorizationCommands } from '../../src/adapters/redis-events.js'
import { createFilesystemAuthorizationConfirmationStore } from '../../src/domains/agent-sessions/filesystem-authorization-confirmations.js'

const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL

test('真实 Redis 执行确认码 Lua 协议并验证一次性兑换与 owner 隔离', {
  skip: !redisUrl && '需要显式隔离 Redis：设置 GUGU_WEBUI_TEST_REDIS_URL',
}, async () => {
  const ownerId = `codex-test-${randomUUID()}`
  const summary = `合成确认测试 ${randomUUID()}`
  const identity = `session:filesystem:${randomUUID()}`
  const store = createFilesystemAuthorizationConfirmationStore(
    createRedisFilesystemAuthorizationCommands(redisUrl!),
  )
  try {
    const code = await store.createPending(ownerId, summary, identity, 1)
    assert.match(code ?? '', /^[a-f0-9]{12}$/)
    assert.equal(await store.hasGrant(ownerId, summary, identity), false)
    assert.equal(await store.redeem(`other-${ownerId}`, code!), false)
    assert.equal(await store.redeem(ownerId, code!), true)
    assert.equal(await store.hasGrant(ownerId, summary, identity), true)
    assert.equal(await store.redeem(ownerId, code!), false)
  } finally {
    await store.revoke(ownerId, summary, identity)
  }
})
