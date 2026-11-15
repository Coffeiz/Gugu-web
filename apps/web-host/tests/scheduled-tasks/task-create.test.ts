import assert from 'node:assert/strict'
import test from 'node:test'
import { createScheduledTask } from '../../src/modules/scheduled-tasks/task-create.js'

test('验证失败不写入；活动提醒重复提交复用事务记录且不重复发布', async () => {
  let inserts = 0, published = 0, reject = true, created = true
  const deps = {
    validateCron() {},
    async validate() { if (reject) throw new Error('工作区不存在'); return {} },
    async insert() { inserts++; return { task: { id: 3 }, created } },
    async publish() { published++ },
  }
  const input = { name: '提醒', schedule_kind: 'once', start_at: '2026-01-02T08:00:00', event_id: 1 }
  await assert.rejects(createScheduledTask(deps, 'owner', input, 'ctx', null, 0))
  assert.equal(inserts, 0)
  reject = false
  await createScheduledTask(deps, 'owner', input, 'ctx', null, 0)
  created = false
  await createScheduledTask(deps, 'owner', input, 'ctx', null, 0)
  assert.equal(inserts, 2)
  assert.equal(published, 1)
})
