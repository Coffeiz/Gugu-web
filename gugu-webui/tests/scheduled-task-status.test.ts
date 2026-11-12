import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTaskEnded,
  scheduleStatus,
  taskScheduleKind,
} from '../src/domains/scheduled-tasks/schedule-status.js'

const now = Date.parse('2026-09-05T12:00:00.000Z')

function task(overrides: Record<string, unknown> = {}) {
  return { schedule_kind: 'interval', end_at: null, enabled: true, ...overrides }
}

test('once schedules do not become ended based on end_at', () => {
  assert.equal(isTaskEnded(task({ schedule_kind: 'once', end_at: '2020-01-01T00:00:00Z' }), now), false)
  assert.equal(scheduleStatus(task({ schedule_kind: 'once', enabled: false }), now), 'disabled')
})

test('repeating schedule end is inclusive and naive timestamps mean UTC', () => {
  assert.equal(isTaskEnded(task({ end_at: '2026-09-05T12:00:00' }), now), true)
  assert.equal(isTaskEnded(task({ end_at: '2026-09-05T12:00:01' }), now), false)
  assert.equal(scheduleStatus(task({ end_at: '2026-09-05T12:00:00', enabled: false }), now), 'ended')
})

test('task schedule kind rejects invalid persisted values with Python-compatible field error', () => {
  assert.equal(taskScheduleKind(task({ schedule_kind: 'cron' })), 'cron')
  assert.throws(
    () => taskScheduleKind(task({ schedule_kind: 'weekly' })),
    (error: unknown) => error instanceof Error &&
      error.message === '数据库中的 schedule_kind 非法' &&
      'field' in error && error.field === 'schedule_kind',
  )
})
