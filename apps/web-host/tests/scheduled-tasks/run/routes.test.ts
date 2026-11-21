import type { ScheduledTaskExecutionCallback } from '@gugu/core/scheduled-task-runner'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createScheduledTaskRunNow } from '@gugu/core/scheduled-task-run-now'
import { ScheduledTaskRunner } from '@gugu/core/scheduled-task-runner'
import { createApp } from '../../../src/app.js'
import { signedUserToken } from '../../helpers/auth.js'

test('run-now Fastify routes authenticate before owner-scoped run and preserve Python outcomes', async () => {
  const secret = 'synthetic-scheduled-task-run-secret'
  const owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  const other = '327d3a83-76b8-4577-a4e9-66f38cbd1aa1'
  const calls: unknown[][] = []
  const runner = {
    async runTrial(id: string, execute: ScheduledTaskExecutionCallback) {
      calls.push(['trial', id])
      return { status: 'completed' as const, delivery: await execute(async () => {}) }
    },
    async runDue(id: string, execute: ScheduledTaskExecutionCallback, _now: number, options: { beforeStart: () => Promise<boolean> }) {
      calls.push(['formal', id])
      if (!await options.beforeStart()) return 'failed' as const
      await execute(async () => {})
      return 'completed' as const
    },
  }
  const runNow = createScheduledTaskRunNow({
    async readOwned(userId, id) {
      calls.push(['read', userId, id])
      if (userId !== owner || id === '99') return null
      return id === '43'
        ? { scheduleKind: 'once', enabled: true, endAt: null, lastRunFailed: true }
        : { scheduleKind: id === '44' ? 'interval' : 'cron', enabled: true, endAt: id === '44' ? 1 : null, lastRunFailed: false }
    },
    runner: runner as unknown as ScheduledTaskRunner,
    async prepare(_owner, _id, isTrial) {
      return { async execute() { calls.push(['execute', isTrial]); return { QQ: '已发送' } } }
    },
    now: () => 2,
    waitSeconds: 1,
  })
  const app = createApp({
    appName: 'Gugu', isReady: async () => true,
    userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) },
    scheduledTaskRunNow: runNow,
  })
  try {
    const path = '/api/v1/scheduled-tasks/42/run'
    assert.equal((await app.inject({ method: 'POST', url: path })).statusCode, 401)
    const headers = { authorization: `Bearer ${signedUserToken(secret, owner)}` }
    const trial = await app.inject({ method: 'POST', url: path, headers })
    assert.equal(trial.statusCode, 200, trial.body)
    assert.deepEqual(trial.json(), { ok: true, result: { QQ: '已发送' }, msg: '试运行结果：\n· QQ：已发送' })
    assert.deepEqual(calls, [['read', owner, '42'], ['trial', '42'], ['read', owner, '42'], ['execute', true]])

    const retry = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks/43/run', headers })
    assert.equal(retry.statusCode, 200, retry.body)
    assert.deepEqual(calls.slice(4), [['read', owner, '43'], ['formal', '43'], ['execute', false]])

    const ended = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks/44/run', headers })
    assert.deepEqual(ended.json(), { ok: false, msg: '任务已结束，不能立即运行' })
    const hidden = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks/99/run', headers: { authorization: `Bearer ${signedUserToken(secret, other)}` } })
    assert.equal(hidden.statusCode, 404)
    assert.deepEqual(hidden.json(), { detail: '任务不存在' })
    assert.equal(calls.filter(call => call[0] === 'execute').length, 2)
  } finally { await app.close() }
})
