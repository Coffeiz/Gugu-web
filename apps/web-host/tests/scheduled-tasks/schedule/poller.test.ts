import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOnceTaskPoller } from '../../../src/modules/scheduled-tasks/schedule/once.js'
import type { ScheduledTaskRunner } from '@gugu/core/scheduled-task-runner'

test('停止轮询等待执行完成且不继续触发后续任务', async () => {
  let finish!: () => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  const calls: string[] = []
  const runner = {
    async recoverAbandoned() { return [] },
    async runDue(id: string, execute: () => Promise<unknown>) { calls.push(id); started(); await execute() },
  } as unknown as ScheduledTaskRunner
  const poller = createOnceTaskPoller({ runner, listDue: async () => ['1', '2'], execute: async () => { await pending; return {} }, onError: () => {} })
  poller.start()
  await entered
  let stopped = false
  const stopping = poller.stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false)
  finish()
  await stopping
  assert.deepEqual(calls, ['1'])
})
