import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRepeatingPoller, dueRepeatingFire } from '../../src/modules/scheduled-tasks/repeating-poller.js'

test('重复调度只返回窗口内最后一次触发并遵守开始与结束时间', () => {
  const base = { id: '1', cron: '* * * * *', intervalMinutes: 5, startAt: 0, createdAt: 0, endAt: null }
  assert.deepEqual(dueRepeatingFire({ ...base, kind: 'interval' }, 640_000, 400_000), { taskId: '1', fireAt: 600_000 })
  assert.equal(dueRepeatingFire({ ...base, kind: 'interval', endAt: 100_000 }, 640_000, 100_000), null)
  assert.deepEqual(dueRepeatingFire({ ...base, kind: 'cron' }, 650_000, 120_000), { taskId: '1', fireAt: 600_000 })
})

test('停止轮询等待正在执行的任务并阻止后续任务', async () => {
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const invoked: string[] = []
  const schedule = { kind: 'interval' as const, cron: '', intervalMinutes: 1, startAt: 0, createdAt: 0, endAt: null }
  const poller = createRepeatingPoller({ list: async () => [{ ...schedule, id: '1' }, { ...schedule, id: '2' }],
    now: () => 60_000, async dispatch(fire) { invoked.push(fire.taskId); started(); await pending }, onError: () => {} })
  poller.start()
  await entered
  let done = false
  const closing = poller.stop().then(() => { done = true })
  await Promise.resolve()
  assert.equal(done, false)
  release()
  await closing
  assert.deepEqual(invoked, ['1'])
})
