import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageLeaseCoordinator } from '../../src/workers/message-lease.js'
import type { MessageLeaseStore } from '../../src/workers/message-lease.js'

test('处理中的重复消息不确认，已完成的重复消息只确认而不重放', async () => {
  const events: string[] = []
  const store: MessageLeaseStore = {
    claim: async key => key === 'processing-key' ? 'busy' : 'completed',
    complete: async () => true,
  }
  const coordinator = new MessageLeaseCoordinator(store, async id => { events.push(`ack:${id}`) })

  assert.equal(await coordinator.claim('processing-id', 'processing-key', 'owner-a'), 'busy')
  assert.deepEqual(events, [])
  assert.equal(await coordinator.claim('completed-id', 'completed-key', 'owner-a'), 'completed')
  assert.deepEqual(events, ['ack:completed-id'])
})

test('只有租约所有者能先持久完成再确认队列消息', async () => {
  const events: string[] = []
  const store: MessageLeaseStore = {
    claim: async () => 'claimed',
    complete: async (_key, owner) => {
      events.push(`complete:${owner}`)
      return owner === 'owner-a'
    },
  }
  const coordinator = new MessageLeaseCoordinator(store, async id => { events.push(`ack:${id}`) })

  assert.equal(await coordinator.acknowledge('msg-a', 'state-a', 'owner-b'), false)
  assert.deepEqual(events, ['complete:owner-b'])
  assert.equal(await coordinator.acknowledge('msg-a', 'state-a', 'owner-a'), true)
  assert.deepEqual(events, ['complete:owner-b', 'complete:owner-a', 'ack:msg-a'])
})
