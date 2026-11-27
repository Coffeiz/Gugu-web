import assert from 'node:assert/strict'
import test from 'node:test'
import { createScheduledTaskDeleter, ScheduledTaskNotFound } from '@gugu/scheduler/tasks'

test('删除只匹配 owner，未找到时不发布事件', async () => {
  const calls: unknown[][] = []
  const events: unknown[][] = []
  let found = false
  const remove = createScheduledTaskDeleter({
    resolveOwner: owner => owner,
    async deleteOwned(owner, id) { calls.push([id, owner]); return found },
    async publish(...event) { events.push(event) },
  })
  const owner = '11111111-1111-4111-8111-111111111111'
  await assert.rejects(remove(owner, 7, 'client'), ScheduledTaskNotFound)
  assert.deepEqual(events, [])
  found = true
  await remove(owner, 7, 'client')
  assert.deepEqual(calls, [[7, owner], [7, owner]])
  assert.deepEqual(events, [[owner, 7, 'client']])
})
