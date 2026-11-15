import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { createPostgresTaskResolver } from '../../src/modules/scheduled-tasks/persistence/task-resolver-postgres.js'

test('提醒提前量按上海墙上时间计算，跨夏令时切换与 Python 一致', async () => {
  const cases = [
    ['1991-07-01', '12:00', '1991-07-01T02:30:00Z', 30],
    ['1991-04-14', '03:30', '1991-04-13T17:30:00Z', 120],
    ['1991-09-15', '02:30', '1991-09-14T16:30:00Z', 60],
  ] as const
  for (const [date, time, instant, expected] of cases) {
    const client = { async query() { return { rows: [{ date, time }], rowCount: 1 } } } as unknown as PoolClient
    const resolve = createPostgresTaskResolver({ async resolveDelivery() { return null }, async revokeFilesystem() {} })
    const result = await resolve(client, 'owner', { event_id: 1 }, {
      schedule_kind: 'once', cron: '', interval_minutes: null, start_at: new Date(instant), end_at: null,
    }, null)
    assert.equal(result.reminder_lead_minutes, expected)
  }
})
