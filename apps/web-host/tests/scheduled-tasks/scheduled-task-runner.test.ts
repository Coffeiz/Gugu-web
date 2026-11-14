import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ScheduledTaskRunner,
  type OnceTaskRepository,
  type ScheduledTaskLease,
  type ScheduledTaskRecord,
} from '../../src/scheduled-task-runner.js'

class MemoryTaskRepository implements OnceTaskRepository {
  readonly tasks = new Map<string, ScheduledTaskRecord>()
  readonly history: string[] = []

  async getOnce(taskId: string) {
    return this.tasks.get(taskId) ?? null
  }

  async markStarted(taskId: string, at: number) {
    const task = this.tasks.get(taskId)
    if (!task || !task.enabled || task.scheduleKind !== 'once') return false
    if (task.lastRunAt !== null && !task.lastRunFailed) return false
    task.lastRunAt = at
    task.lastRunFailed = false
    this.history.push(`started:${taskId}`)
    return true
  }

  async markFailed(taskId: string) {
    const task = this.tasks.get(taskId)
    if (!task) return
    task.lastRunFailed = true
    this.history.push(`failed:${taskId}`)
  }

  async deleteCompleted(taskId: string) {
    this.tasks.delete(taskId)
    this.history.push(`deleted:${taskId}`)
  }

  async findStartedOnceBefore(at: number) {
    return [...this.tasks.values()].filter(task =>
      task.scheduleKind === 'once' && task.lastRunAt !== null &&
      !task.lastRunFailed && task.lastRunAt < at,
    )
  }
}

class MemoryLease implements ScheduledTaskLease {
  readonly owners = new Map<string, string>()
  readonly held = new Set<string>()

  async acquire(taskId: string, owner: string) {
    if (this.owners.has(taskId)) return false
    this.owners.set(taskId, owner)
    this.held.add(taskId)
    return true
  }

  async renew(taskId: string, owner: string) {
    return this.owners.get(taskId) === owner
  }

  async release(taskId: string, owner: string) {
    if (this.owners.get(taskId) === owner) {
      this.owners.delete(taskId)
      this.held.delete(taskId)
    }
  }

  async isHeld(taskId: string) {
    return this.held.has(taskId)
  }
}

function onceTask(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: 'once-1',
    userId: 'user-test',
    enabled: true,
    scheduleKind: 'once',
    startAt: 100,
    lastRunAt: null,
    lastRunFailed: false,
    ...overrides,
  }
}

test('一次性任务到期后先持久化开始态，投递成功删除；重复触发不重放副作用', async () => {
  const repository = new MemoryTaskRepository()
  const lease = new MemoryLease()
  repository.tasks.set('once-1', onceTask())
  const runner = new ScheduledTaskRunner({
    repository, lease, createOwner: () => 'owner-a',
    notifyTasksChanged: async userId => { repository.history.push(`notified:${userId}`) },
  })
  let sideEffects = 0

  const first = await runner.runDue('once-1', async () => {
    assert.deepEqual(repository.history, ['started:once-1'])
    sideEffects++
    return { 网页通知: '已发送' }
  }, 101)
  const duplicate = await runner.runDue('once-1', async () => {
    sideEffects++
    return { 网页通知: '已发送' }
  }, 102)

  assert.equal(first, 'completed')
  assert.equal(duplicate, 'not_found')
  assert.equal(sideEffects, 1)
  assert.deepEqual(repository.history, ['started:once-1', 'deleted:once-1', 'notified:user-test'])
})

test('一次性任务执行或投递失败保留任务并标失败，后续正式重试可成功', async () => {
  const repository = new MemoryTaskRepository()
  const lease = new MemoryLease()
  repository.tasks.set('once-1', onceTask())
  const runner = new ScheduledTaskRunner({
    repository, lease, createOwner: () => 'owner-a',
    notifyTasksChanged: async userId => { repository.history.push(`notified:${userId}`) },
  })

  const failed = await runner.runDue('once-1', async () => ({ 网页通知: '发送失败' }), 101)
  const failedSnapshot = await repository.getOnce('once-1')
  const rowAfterFailure = failedSnapshot ? { ...failedSnapshot } : null
  const retried = await runner.runDue('once-1', async () => ({ 网页通知: '已发送' }), 102)

  assert.equal(failed, 'failed')
  assert.equal(rowAfterFailure?.lastRunFailed, true)
  assert.equal(retried, 'completed')
  assert.equal(await repository.getOnce('once-1'), null)
  assert.deepEqual(repository.history, [
    'started:once-1', 'failed:once-1', 'notified:user-test',
    'started:once-1', 'deleted:once-1', 'notified:user-test',
  ])
})

test('任务尚未到期、已成功或被另一执行者持有时不运行副作用', async () => {
  const repository = new MemoryTaskRepository()
  const lease = new MemoryLease()
  repository.tasks.set('future', onceTask({ id: 'future', startAt: 200 }))
  repository.tasks.set('done', onceTask({ id: 'done', lastRunAt: 100, lastRunFailed: false }))
  repository.tasks.set('busy', onceTask({ id: 'busy' }))
  lease.owners.set('busy', 'other-owner')
  const runner = new ScheduledTaskRunner({
    repository, lease, createOwner: () => 'owner-a', notifyTasksChanged: async () => {},
  })
  let sideEffects = 0
  const execute = async () => { sideEffects++; return { 网页通知: '已发送' } }

  assert.equal(await runner.runDue('future', execute, 199), 'not_due')
  assert.equal(await runner.runDue('done', execute, 201), 'already_run')
  assert.equal(await runner.runDue('busy', execute, 201), 'busy')
  assert.equal(sideEffects, 0)
})

test('重启恢复只把超过锁宽限且没有活跃租约的一次性任务标记失败', async () => {
  const repository = new MemoryTaskRepository()
  const lease = new MemoryLease()
  repository.tasks.set('abandoned', onceTask({ id: 'abandoned', lastRunAt: 100 }))
  repository.tasks.set('active', onceTask({ id: 'active', lastRunAt: 100 }))
  lease.held.add('active')
  const runner = new ScheduledTaskRunner({
    repository, lease, createOwner: () => 'owner-a', lockTimeoutMs: 600,
    heartbeatIntervalMs: 300,
    notifyTasksChanged: async () => {},
  })

  const recovered = await runner.recoverAbandoned(701)

  assert.deepEqual(recovered, ['abandoned'])
  assert.equal((await repository.getOnce('abandoned'))?.lastRunFailed, true)
  assert.equal((await repository.getOnce('active'))?.lastRunFailed, false)
})

test('获锁后立即开始续租，单次续租异常后继续重试且提交完成后再通知', async () => {
  const repository = new MemoryTaskRepository()
  const lease = new MemoryLease()
  repository.tasks.set('once-1', onceTask())
  const waitForTaskRead = repository.getOnce.bind(repository)
  repository.getOnce = async taskId => {
    await new Promise(resolve => setTimeout(resolve, 30))
    return waitForTaskRead(taskId)
  }
  let renewCalls = 0
  let renewErrors = 0
  lease.renew = async (taskId, owner) => {
    renewCalls++
    if (renewCalls === 1) throw new Error('合成 Redis 短暂故障')
    return lease.owners.get(taskId) === owner
  }
  const runner = new ScheduledTaskRunner({
    repository,
    lease,
    createOwner: () => 'owner-a',
    lockTimeoutMs: 100,
    heartbeatIntervalMs: 5,
    onLeaseRenewError: () => { renewErrors++ },
    notifyTasksChanged: async userId => { repository.history.push(`notified:${userId}`) },
  })

  const result = await runner.runDue('once-1', async () => ({ 网页通知: '已发送' }), 101)

  assert.equal(result, 'completed')
  assert.ok(renewCalls >= 2)
  assert.equal(renewErrors, 1)
  assert.equal(repository.history.at(-2), 'deleted:once-1')
  assert.equal(repository.history.at(-1), 'notified:user-test')
})
