import assert from 'node:assert/strict'
import test from 'node:test'
import { createRedisProviderContinuationStore } from '../../src/modules/agent/run/continuation.js'

test('重建实例可读取未过期的原生续接，密文绑定原运行、模型和授权范围', async () => {
  const values = new Map<string, string>()
  const redis = {
    async get(key: string) { return values.get(key) ?? null },
    async saveIfAbsent(key: string, value: string, seconds: number) {
      assert.equal(seconds, 900)
      if (values.has(key)) return false
      values.set(key, value)
      return true
    },
  }
  const scope = { identity: { ownerId: 'owner', sessionId: '1', runId: 'run' }, modelIdentity: 'model', accessScopeHash: 'access' }
  const reference = 'provider:synthetic'
  const native = { round: 1, areaDigest: 'digest', value: { signature: 'synthetic-private-signature' } }
  const first = createRedisProviderContinuationStore(redis, 'synthetic-key')
  await first.save(scope, reference, native, 900_000)
  await assert.rejects(first.save(scope, reference, native, 900_000))
  const [address, ciphertext] = [...values][0]!
  assert.equal(Buffer.from(ciphertext, 'base64').includes('synthetic-private-signature'), false)

  const resumed = createRedisProviderContinuationStore(redis, 'synthetic-key')
  assert.deepEqual(await resumed.read(scope, reference), native)
  assert.equal(await resumed.read({ ...scope, modelIdentity: 'another' }, reference), null)
  assert.equal(await resumed.read({ ...scope, accessScopeHash: 'another' }, reference), null)
  assert.equal(await resumed.read({ ...scope, identity: { ...scope.identity, runId: 'another' } }, reference), null)
  const replayed = createRedisProviderContinuationStore({ ...redis, get: async () => ciphertext }, 'synthetic-key')
  assert.equal(await replayed.read({ ...scope, identity: { ...scope.identity, ownerId: 'another' } }, reference), null)
  values.delete(address)
  assert.equal(await resumed.read(scope, reference), null)
})
