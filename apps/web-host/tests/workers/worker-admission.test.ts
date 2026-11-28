import assert from 'node:assert/strict'
import test from 'node:test'
import { createSerialWorker, WorkerAdmission } from '../../src/workers/admission.js'

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

test('共享 Run 席位逐个开始任务，并在任务失败后继续处理后续任务', async () => {
  const run = createSerialWorker()
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const started: string[] = []
  const web = run(async () => { started.push('web'); await hold; throw new Error('合成执行失败') })
  const im = run(async () => { started.push('im'); return 'im' })
  const resume = run(async () => { started.push('resume'); return 'resume' })
  await Promise.resolve()
  assert.deepEqual(started, ['web'])
  release()
  await assert.rejects(web, /合成执行失败/)
  assert.deepEqual(await Promise.all([im, resume]), ['im', 'resume'])
  assert.deepEqual(started, ['web', 'im', 'resume'])
})
