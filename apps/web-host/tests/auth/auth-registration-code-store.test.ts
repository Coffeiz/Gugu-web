import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import {
  createRedisRegistrationCodeStore,
  type RegistrationCodeRedisCommands,
} from '../../src/domains/auth/persistence/registration-codes.js'

const secret = 'synthetic-registration-code-secret'
const email = 'person@example.test'
const code = '042731'
const emailHash = createHash('sha256').update(email).digest('hex')
const codeDigest = createHmac('sha256', secret).update(`${email}\0${code}`).digest('hex')

function fakeRedis(options: { failCodeWrite?: boolean } = {}) {
  const values = new Map<string, string>()
  const ttls = new Map<string, number>()
  const calls: Array<[string, ...Array<string | number>]> = []
  const commands: RegistrationCodeRedisCommands = {
    async set(key, value, ...args) {
      calls.push(['set', key, value, ...args])
      if (args.includes('NX') && values.has(key)) return null
      if (key.startsWith('regverify:code:') && options.failCodeWrite)
        throw new Error('synthetic Redis write failure')
      values.set(key, value)
      if (args.includes('EX')) ttls.set(key, Number(args[args.indexOf('EX') + 1]) * 1000)
      if (args.includes('PX')) ttls.set(key, Number(args[args.indexOf('PX') + 1]))
      return 'OK'
    },
    async get(key) {
      calls.push(['get', key])
      return values.get(key) ?? null
    },
    async incr(key) {
      calls.push(['incr', key])
      const value = Number(values.get(key) ?? 0) + 1
      values.set(key, String(value))
      return value
    },
    async expire(key, seconds) {
      calls.push(['expire', key, seconds])
      ttls.set(key, seconds * 1000)
      return 1
    },
    async del(...keys) {
      calls.push(['del', ...keys])
      return keys.reduce((count, key) => count + Number(values.delete(key)), 0)
    },
    async pttl(key) {
      calls.push(['pttl', key])
      return ttls.get(key) ?? -2
    },
    async eval(_script, keyCount, ...args) {
      calls.push(['eval', keyCount, ...args])
      const key = String(args[0])
      const digest = String(args[1])
      if (values.get(key) !== digest) return 0
      values.delete(key)
      ttls.delete(key)
      return 1
    },
  }
  return { commands, values, ttls, calls }
}

test('Redis registration code reservation stores only an HMAC digest with cooldown and validity TTLs', async () => {
  const redis = fakeRedis()
  const store = createRedisRegistrationCodeStore(redis.commands, secret, () => code)

  assert.equal(store.createCode(), code)
  assert.equal(await store.reserve(email, code), true)
  assert.equal(await store.reserve(email, code), false)

  const codeKey = `regverify:code:${emailHash}`
  const cooldownKey = `regverify:cooldown:${emailHash}`
  assert.equal(redis.values.get(codeKey), codeDigest)
  assert.ok(![...redis.values.values()].includes(code))
  assert.equal(redis.ttls.get(codeKey), 600_000)
  assert.equal(redis.ttls.get(cooldownKey), 60_000)
  assert.deepEqual(redis.calls.filter(([operation, key]) => operation === 'set' && key === cooldownKey), [
    ['set', cooldownKey, '1', 'EX', '60', 'NX'],
    ['set', cooldownKey, '1', 'EX', '60', 'NX'],
  ])
  assert.deepEqual(redis.calls.filter(([operation, key]) => operation === 'set' && key === codeKey), [
    ['set', codeKey, codeDigest, 'EX', '600'],
  ])
})

test('registration code verification counts wrong attempts and refuses guesses after five', async () => {
  const redis = fakeRedis()
  const store = createRedisRegistrationCodeStore(redis.commands, secret, () => code)
  await store.reserve(email, code)

  assert.equal(await store.verify(email, code), true)
  for (let attempt = 0; attempt < 5; attempt += 1)
    assert.equal(await store.verify(email, '999999'), false)
  assert.equal(await store.verify(email, code), false)
  assert.equal(redis.values.get(`regverify:attempts:${emailHash}`), '7')
  assert.equal(redis.ttls.get(`regverify:attempts:${emailHash}`), 600_000)
})

test('code consumption is exact and atomic; rollback restoration uses remaining TTL and never overwrites a new code', async () => {
  const redis = fakeRedis()
  const store = createRedisRegistrationCodeStore(redis.commands, secret, () => code)
  await store.reserve(email, code)
  assert.equal(await store.remainingTtlMs(email), 600_000)
  assert.equal(await store.consume(email, '999999'), false)
  assert.equal(await store.consume(email, code), true)
  assert.equal(await store.consume(email, code), false)

  await store.restore(email, code, 12_345)
  assert.equal(redis.values.get(`regverify:code:${emailHash}`), codeDigest)
  assert.equal(redis.ttls.get(`regverify:code:${emailHash}`), 12_345)
  const replacementDigest = createHmac('sha256', secret).update(`${email}\0${'888888'}`).digest('hex')
  await redis.commands.set(`regverify:code:${emailHash}`, replacementDigest, 'EX', '600')
  await store.restore(email, code, 9_000)
  assert.equal(redis.values.get(`regverify:code:${emailHash}`), replacementDigest)
  assert.equal(redis.ttls.get(`regverify:code:${emailHash}`), 600_000)
})

test('failed code persistence removes its cooldown so the user can retry', async () => {
  const redis = fakeRedis({ failCodeWrite: true })
  const store = createRedisRegistrationCodeStore(redis.commands, secret, () => code)

  await assert.rejects(store.reserve(email, code), /synthetic Redis write failure/)
  assert.equal(redis.values.has(`regverify:cooldown:${emailHash}`), false)
  assert.deepEqual(redis.calls.at(-1), ['del', `regverify:cooldown:${emailHash}`])
})
