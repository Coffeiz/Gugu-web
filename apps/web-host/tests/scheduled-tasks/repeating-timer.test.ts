import assert from 'node:assert/strict'
import test from 'node:test'
import { createRepeatingTimer, nextRepeatingFire } from '../../src/modules/scheduled-tasks/repeating-timer.js'
type RepeatingSchedule = Parameters<typeof nextRepeatingFire>[0]

const timerLimit = 2 ** 31 - 1
const fixture = (startAt: number, id = '3'): RepeatingSchedule => ({
  id, kind: 'interval', cron: '', intervalMinutes: 1, startAt, createdAt: 0, endAt: startAt,
})

function clock() {
  let now = 0, sequence = 0
  const timers = new Map<number, { at: number; callback(): void }>()
  return {
    now: () => now,
    timers,
    setTimer(callback: () => void, delay: number) {
      assert.ok(delay > 0 && delay <= timerLimit)
      const id = ++sequence
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimer(id: unknown) { timers.delete(Number(id)) },
    fire(at: number) {
      now = at
      for (const [id, timer] of [...timers]) {
        if (timer.at > at) continue
        timers.delete(id)
        timer.callback()
      }
    },
  }
}

test('远期任务分段等待，长延时不会提前投递或丢失触发', async () => {
  const time = clock()
  const startAt = 2 * timerLimit + 10_000
  const fires: number[] = []
  const worker = createRepeatingTimer({
    ...time, reconcileMs: timerLimit, list: async () => [fixture(startAt)],
    async dispatch(fire) { fires.push(fire.fireAt) }, onError(error) { assert.fail(String(error)) },
  })
  worker.start()
  await Promise.resolve()
  for (const at of [timerLimit, 2 * timerLimit]) {
    time.fire(at)
    await Promise.resolve()
    assert.deepEqual(fires, [])
  }
  time.fire(startAt)
  await worker.stop()
  assert.deepEqual(fires, [startAt])
  assert.equal(time.timers.size, 0)
})

test('停启期间旧的协调结果不能覆盖当前任务或留下额外定时器', async () => {
  const time = clock()
  const fires: string[] = []
  let calls = 0
  let resolveOld!: (rows: RepeatingSchedule[]) => void
  const old = new Promise<RepeatingSchedule[]>(resolve => { resolveOld = resolve })
  const worker = createRepeatingTimer({
    ...time, list: () => ++calls === 1 ? old : Promise.resolve([fixture(2000, 'new')]),
    async dispatch(fire) { fires.push(fire.taskId) }, onError(error) { assert.fail(String(error)) },
  })
  worker.start()
  const stopped = worker.stop()
  worker.start()
  await Promise.resolve()
  resolveOld([fixture(1000, 'old')])
  await stopped
  assert.equal(time.timers.size, 2)
  time.fire(1000)
  time.fire(2000)
  await worker.stop()
  assert.deepEqual(fires, ['new'])
  assert.equal(time.timers.size, 0)
})

test('任务改期后，已经排队的旧回调不能再投递或重置新计划', async () => {
  const time = clock()
  const fires: number[] = []
  let schedule = fixture(5000)
  const worker = createRepeatingTimer({
    ...time, reconcileMs: 1000, list: async () => [schedule],
    async dispatch(fire) { fires.push(fire.fireAt) }, onError(error) { assert.fail(String(error)) },
  })
  worker.start()
  await Promise.resolve()
  const previous = [...time.timers.values()].find(timer => timer.at === 5000)!
  schedule = fixture(7000)
  time.fire(1000)
  await Promise.resolve()
  time.fire(5000)
  previous.callback()
  time.fire(7000)
  await worker.stop()
  assert.deepEqual(fires, [7000])
})

test('一次性调度只触发一次，超过 Python 误点窗口时跳过', async () => {
  const time = clock()
  const calls: string[] = []
  const worker = createRepeatingTimer({
    ...time, reconcileMs: 10000,
    list: async () => [{ id: 'on-time', kind: 'once' as const, startAt: 3000 },
      { id: 'missed', kind: 'once' as const, startAt: 1000 }],
    async dispatch(fire) { calls.push(fire.taskId) },
    onError(error) { assert.fail(String(error)) },
  })
  worker.start()
  await Promise.resolve()
  time.fire(3000)
  await Promise.resolve()
  assert.deepEqual(calls, ['on-time'])
  time.fire(10000)
  await Promise.resolve()
  time.fire(20000)
  await worker.stop()
  assert.deepEqual(calls, ['on-time'])
})

test('提交后的主动刷新发现下一次轮询前到期的任务，旧扫描回调失效', async () => {
  const time = clock()
  const fired: string[] = []
  let tasks: Array<{ id: string; kind: 'once'; startAt: number }> = []
  let scans = 0
  const worker = createRepeatingTimer({
    ...time, reconcileMs: 30_000, async list() { scans++; return tasks },
    async dispatch(fire) { fired.push(fire.taskId) },
    onError(error) { assert.fail(String(error)) },
  })
  worker.start()
  await Promise.resolve()
  const stale = [...time.timers.values()][0]!
  tasks = [{ id: 'new', kind: 'once', startAt: 2000 }]
  await Promise.all([worker.refresh(), worker.refresh()])
  const scansAfterRefresh = scans
  stale.callback()
  assert.equal(scans, scansAfterRefresh)
  assert.equal(time.timers.size, 2)
  time.fire(2000)
  await worker.stop()
  assert.deepEqual(fired, ['new'])
  assert.equal(time.timers.size, 0)
})

test('关闭等待在途投递并取消后续触发', async () => {
  const time = clock()
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const fired: string[] = []
  const worker = createRepeatingTimer({
    ...time, list: async () => [fixture(1000, 'first'), fixture(2000, 'second')],
    async dispatch(fire) { fired.push(fire.taskId); await hold },
    onError(error) { assert.fail(String(error)) },
  })
  worker.start()
  await Promise.resolve()
  time.fire(1000)
  await Promise.resolve()
  let closed = false
  const closing = worker.stop().then(() => { closed = true })
  time.fire(2000)
  await Promise.resolve()
  assert.equal(closed, false)
  release()
  await closing
  assert.deepEqual(fired, ['first'])
})

test('Cron 支持月末和超过一年的稀疏触发', () => {
  const cron: RepeatingSchedule = { id: 'sparse', kind: 'cron', cron: '15 9 last * *',
    intervalMinutes: null, startAt: null, createdAt: 0, endAt: null }
  assert.equal(nextRepeatingFire(cron, Date.parse('2027-02-01T00:00:00Z')), Date.parse('2027-02-28T01:15:00Z'))
  assert.equal(nextRepeatingFire({ ...cron, cron: '15 9 29 feb *' }, Date.parse('2024-03-01T00:00:00Z')),
    Date.parse('2028-02-29T01:15:00Z'))
  assert.equal(nextRepeatingFire({ ...cron, cron: '15 9 30 feb *' }, Date.parse('2024-03-01T00:00:00Z')), null)
})
