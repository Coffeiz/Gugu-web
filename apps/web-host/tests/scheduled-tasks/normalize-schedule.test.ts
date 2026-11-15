import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSchedule } from '@gugu/core/scheduled-task-schedule'
import { validateTaskCron } from '../../src/modules/scheduled-tasks/validate-cron.js'

test('一次性时间按上海时区解析，并拒绝过去时间和冲突字段', () => {
  const once = normalizeSchedule({ schedule_kind: 'once', start_at: '2026-01-02T08:00:00' }, () => {}, Date.parse('2026-01-01Z'))
  assert.equal(once.cron, '@once:2026-01-02T00:00:00+00:00')
  assert.throws(() => normalizeSchedule({ schedule_kind: 'once', start_at: '2026-01-01T08:00:00' }, () => {}, Date.parse('2026-01-01Z')))
  assert.throws(() => normalizeSchedule({ schedule_kind: 'once', start_at: '2026-01-02T08:00:00', cron: '* * * * *' }, () => {}, 0))
  assert.throws(() => normalizeSchedule({ schedule_kind: 'once', start_at: '2026-02-30T08:00:00' }, () => {}, 0))
})

test('cron 校验保留 APScheduler 月末、名称与字段范围语义', () => {
  for (const value of ['0 0 last * *', '0 0 lastfoo * *', '0 0 * jan/99 mon/99', '0-0/1 * * * *', '0 0 * jan mon-fri', '5/2 * * * *']) assert.doesNotThrow(() => validateTaskCron(value))
  for (const value of ['0 0 * * 7', '*/100 * * * *', '1-4/9 * * * *', '0 0 1st_mon * *']) assert.throws(() => validateTaskCron(value))
})

test('间隔边界与 cron 完整校验由注入器执行', () => {
  assert.equal(normalizeSchedule({ schedule_kind: 'interval', interval_minutes: 60 }, () => {}, 0).cron, '*/60 * * * *')
  assert.throws(() => normalizeSchedule({ schedule_kind: 'interval', interval_minutes: 61 }, () => {}, 0))
  assert.throws(() => normalizeSchedule({ schedule_kind: 'cron', cron: 'bad' }, () => { throw new Error('bad') }, 0))
})

test('同时存在过期结束时间和非法调度时优先报告调度字段', () => {
  const end_at = '2020-01-01T00:00:00Z'
  const now = Date.parse('2021-01-01T00:00:00Z')
  assert.throws(() => normalizeSchedule({ schedule_kind: 'cron', cron: 'bad', end_at }, () => { throw new Error('bad') }, now), { field: 'cron' })
  assert.throws(() => normalizeSchedule({ schedule_kind: 'interval', interval_minutes: 61, end_at }, () => {}, now), { field: 'interval_minutes' })
})

test('无时区历史时间按上海夏令时和 Python fold=0 解释', () => {
  for (const [local, utc] of [
    ['1991-07-01T12:00:00', '1991-07-01T03:00:00.000Z'],
    ['1991-04-14T02:30:00', '1991-04-13T18:30:00.000Z'],
    ['1991-09-15T01:30:00', '1991-09-14T16:30:00.000Z'],
  ]) {
    assert.equal(normalizeSchedule({ schedule_kind: 'interval', interval_minutes: 1, start_at: local }, () => {}, 0).start_at?.toISOString(), utc)
  }
})
