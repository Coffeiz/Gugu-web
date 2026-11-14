import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  createFilesystemAuthorizationConfirmationStore,
  type FilesystemAuthorizationRedisCommands,
} from '../../src/domains/agent-sessions/filesystem-authorization-confirmations.js'

class MemoryConfirmationRedis implements FilesystemAuthorizationRedisCommands {
  readonly values = new Map<string, string>()
  readonly evalCalls: Array<{ script: string; keyCount: number; args: string[] }> = []

  async get(key: string) { return this.values.get(key) ?? null }
  async del(...keys: string[]) {
    let removed = 0
    for (const key of keys) if (this.values.delete(key)) removed += 1
    return removed
  }

  async eval(script: string, keyCount: number, ...args: string[]): Promise<string | null> {
    this.evalCalls.push({ script, keyCount, args })
    if (script.includes("local current = redis.call('GET', KEYS[1])")) {
      const [requestKey, codeKey, code, record, ttl] = args
      assert.equal(keyCount, 2)
      assert.ok(requestKey && codeKey && code && record && ttl)
      const current = this.values.get(requestKey!)
      if (current) return current
      this.values.set(requestKey!, code!)
      this.values.set(codeKey!, record!)
      return code!
    }
    const [codeKey, ownerId] = args
    assert.equal(keyCount, 1)
    const raw = this.values.get(codeKey!)
    if (!raw) return ''
    const record = JSON.parse(raw) as { s?: unknown; i?: unknown; ttl_minutes?: unknown }
    if (typeof record.s !== 'string' || !record.s) return ''
    const identity = typeof record.i === 'string' ? record.i : ''
    this.values.set(`agent:confirm-grant:${ownerId}:${record.s}:${identity}`, '1')
    this.values.delete(codeKey!)
    return '1'
  }
}

function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

test('Redis 确认码与 Python 键协议兼容、按 owner 和会话身份隔离且只能兑换一次', async () => {
  const redis = new MemoryConfirmationRedis()
  const store = createFilesystemAuthorizationConfirmationStore(redis, () => 'a1b2c3d4e5f6')
  const owner = 'owner-1'
  const otherOwner = 'owner-2'
  const summary = '允许会话「合成会话」读写整个用户沙箱（包含 /workspace、/personal、/project）'
  const identity = 'session:filesystem:42'
  const code = await store.createPending(owner, summary, identity, 10)
  assert.equal(code, 'a1b2c3d4e5f6')
  assert.equal(await store.createPending(owner, summary, identity, 10), code)
  const reqKey = `agent:confirm-req:${owner}:${hash(summary)}:${hash(identity)}`
  const codeKey = `agent:confirm-code:${owner}:${code}`
  assert.equal(await redis.get(reqKey), code)
  assert.deepEqual(JSON.parse((await redis.get(codeKey))!), {
    s: hash(summary), i: hash(identity), ttl_minutes: 10,
  })
  assert.equal(redis.evalCalls[0]?.args[4], '600')
  assert.equal(await store.hasGrant(owner, summary, identity), false)

  assert.equal(await store.redeem(otherOwner, code!), false)
  assert.equal(await store.redeem(owner, code!), true)
  assert.equal(await store.hasGrant(owner, summary, identity), true)
  assert.equal(await store.hasGrant(otherOwner, summary, identity), false)
  assert.equal(await store.hasGrant(owner, summary, 'session:filesystem:43'), false)
  assert.equal(await store.redeem(owner, code!), false)

  assert.equal(await store.revoke(owner, summary, identity), true)
  assert.equal(await store.hasGrant(owner, summary, identity), false)
  assert.equal(await redis.get(reqKey), null)
})

test('Redis 故障或无效确认码 fail closed', async () => {
  const unavailable: FilesystemAuthorizationRedisCommands = {
    async get() { throw new Error('redis unavailable') },
    async del() { throw new Error('redis unavailable') },
    async eval() { throw new Error('redis unavailable') },
  }
  const store = createFilesystemAuthorizationConfirmationStore(unavailable)
  const summary = 'synthetic summary'
  assert.equal(await store.revoke('owner', summary, 'session:filesystem:1'), false)
  assert.equal(await store.createPending('owner', summary, 'session:filesystem:1', 10), null)
  assert.equal(await store.redeem('owner', 'invalid'), false)
  assert.equal(await store.hasGrant('owner', summary, 'session:filesystem:1'), false)
})
