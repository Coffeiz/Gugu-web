import assert from 'node:assert/strict'
import test from 'node:test'
import { updateScheduledTask } from '../../src/modules/scheduled-tasks/task-update.js'

test('切换调度类型不沿用旧字段，验证失败不写入或发布', async () => {
  const current = { schedule_kind: 'cron', cron: '0 9 * * *', interval_minutes: null, start_at: null, end_at: null, event_id: null }
  let writes = 0, publishes = 0, reject = true
  const deps = {
    validateCron() {},
    async validate() { if (reject) throw new Error('目标不存在') },
    async transaction(_owner: string, _id: number, update: (row: typeof current) => Promise<any>) { const result = await update(current); writes++; return result },
    async publish() { publishes++ },
  }
  const patch = { schedule_kind: 'interval', interval_minutes: 15 }
  await assert.rejects(updateScheduledTask(deps, 'owner', 1, patch, null, 0))
  assert.equal(writes, 0)
  reject = false
  const result = await updateScheduledTask(deps, 'owner', 1, patch, null, 0)
  assert.equal(result.schedule.cron, '*/15 * * * *')
  assert.equal(publishes, 1)
})
