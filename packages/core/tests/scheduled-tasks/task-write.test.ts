import { describe, expect, it } from 'vitest'
import { createScheduledTask, updateScheduledTask } from '../../src/scheduled-tasks/task-write.js'

describe('定时任务写入用例', () => {
  it('活动提醒重复提交返回原任务且只在首次提交后发布', async () => {
    let created = true, unavailable = true
    const published: unknown[] = []
    const deps = {
      validateCron() {},
      async persist(owner, input, schedule, contextId) {
        if (unavailable) throw new Error('工作区不存在')
        expect(owner).toBe('owner')
        expect(input.event_id).toBe(7)
        expect(schedule.cron).toBe('@once:2099-01-01T00:00:00+00:00')
        expect(contextId).toBe('undo-1')
        return { task: { id: 11 }, created: created && ((created = false), true) }
      },
      async publish(...args) { published.push(args) },
    }

    const input = { name: '活动提醒', schedule_kind: 'once', start_at: '2099-01-01T08:00:00', event_id: 7 }
    await expect(createScheduledTask(deps, 'owner', input, 'undo-1', 'client-1', 0)).rejects.toThrow('工作区不存在')
    expect(published).toHaveLength(0)
    unavailable = false
    expect(await createScheduledTask(deps, 'owner', input, 'undo-1', 'client-1', 0)).toEqual({ task: { id: 11 }, created: true })
    expect(await createScheduledTask(deps, 'owner', input, 'undo-1', 'client-1', 0)).toEqual({ task: { id: 11 }, created: false })
    expect(published).toHaveLength(1)
  })

  it('更新在 owner 行事务内校验新调度并在提交后发布', async () => {
    const published: unknown[] = []
    let reject = true, commits = 0
    const deps = {
      validateCron() {},
      async persist(owner, id, patch, prepare) {
        expect(owner).toBe('owner')
        expect(id).toBe(4)
        return prepare(
          { schedule_kind: 'cron', cron: '0 9 * * *', interval_minutes: null, start_at: null, end_at: null, event_id: null },
          async (_current, _patch, schedule) => {
            if (reject) throw new Error('目标不存在')
            expect(schedule?.cron).toBe('*/15 * * * *')
          },
        ).then(result => { commits++; return result })
      },
      async publish(...args) { published.push(args) },
    }

    await expect(updateScheduledTask(deps, 'owner', 4, { schedule_kind: 'interval', interval_minutes: 15 }, 'client-1', 0)).rejects.toThrow('目标不存在')
    expect(commits).toBe(0)
    expect(published).toHaveLength(0)
    reject = false
    const task = await updateScheduledTask(deps, 'owner', 4, { schedule_kind: 'interval', interval_minutes: 15 }, 'client-1', 0)
    expect(task.schedule?.cron).toBe('*/15 * * * *')
    expect(commits).toBe(1)
    expect(published).toHaveLength(1)
  })

  it('新调度验证失败时不调用持久化或提交后通知', async () => {
    let persisted = false, published = false
    const deps = {
      validateCron() {},
      async persist(_owner, _id, _patch, prepare) {
        const prepared = await prepare(
          { schedule_kind: 'cron', cron: '0 9 * * *', interval_minutes: null, start_at: null, end_at: null, event_id: null },
          async () => {},
        )
        persisted = true
        return prepared
      },
      async publish() { published = true },
    }
    await expect(updateScheduledTask(deps, 'owner', 2, { schedule_kind: 'once' }, null, 0)).rejects.toThrow('start_at')
    expect(persisted).toBe(false)
    expect(published).toBe(false)
  })
})
