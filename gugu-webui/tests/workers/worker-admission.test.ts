import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerAdmission } from '../../src/workers/admission.js'

test('未确认和防抖缓冲消息持续占用有界容量直到确认', () => {
  const admission = new WorkerAdmission(1)
  assert.equal(admission.capacity, 2)
  assert.equal(admission.claim(['m1', 'm2', 'm3']), 2)
  admission.buffer('m1')
  admission.dispatchFinished('m1')
  assert.equal(admission.claim(['m3']), 0)
  admission.acknowledge('m1')
  assert.equal(admission.claim(['m3']), 1)
})

test('本地仍在处理的过期认领不会重复派发', () => {
  const admission = new WorkerAdmission(2)
  admission.claim(['active', 'other'])
  admission.acknowledge('other')
  assert.equal(admission.claim(['active', 'new']), 1)
  assert.deepEqual(admission.pendingIds, ['active', 'new'])
})

test('提高并发上限后增加队列准入容量', () => {
  const admission = new WorkerAdmission(1)
  admission.claim(['first', 'second'])
  assert.equal(admission.claim(['third']), 0)
  admission.setConcurrency(2)
  assert.equal(admission.claim(['third', 'fourth']), 2)
})
