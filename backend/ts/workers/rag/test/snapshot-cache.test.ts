import assert from 'node:assert/strict'
import test from 'node:test'

import { RagSnapshotCache } from '../src/snapshot-cache.ts'

test('RAG snapshot cache 在相同 scope/revision 下复用并刷新访问 TTL', () => {
  let now = 0
  let builds = 0
  const cache = new RagSnapshotCache({ ttlMs: 100, now: () => now })
  const create = () => ({ build: ++builds })

  assert.deepEqual(cache.getOrCreate('owner:1', 'r1', create), {
    value: { build: 1 }, hit: false, reason: 'miss',
  })
  now = 90
  assert.deepEqual(cache.getOrCreate('owner:1', 'r1', create), {
    value: { build: 1 }, hit: true, reason: 'hit',
  })
  now = 200
  assert.deepEqual(cache.getOrCreate('owner:1', 'r1', create), {
    value: { build: 2 }, hit: false, reason: 'expired',
  })
  assert.equal(builds, 2)
})

test('RAG snapshot cache 在 revision 改变时重建且不同 scope 不共享', () => {
  let builds = 0
  const cache = new RagSnapshotCache({ now: () => 1 })
  const create = () => ++builds

  assert.equal(cache.getOrCreate('owner:1', 'r1', create).value, 1)
  assert.equal(cache.getOrCreate('owner:1', 'r2', create).value, 2)
  assert.equal(cache.getOrCreate('owner:2', 'r2', create).value, 3)
  assert.equal(cache.size(), 2)
  cache.invalidate('owner:1')
  assert.equal(cache.size(), 1)
})
