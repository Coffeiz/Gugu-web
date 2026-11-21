import { expect, it, vi } from 'vitest'
import { createScheduledTaskExecution } from '../../src/scheduled-tasks/execute.js'

it.each([true, false])('提醒原样投递，立即执行=%s，无需模型端口', async isTrial => {
  const deliver = vi.fn(async () => ({ QQ: '已发送' }))
  const readMemory = vi.fn(async () => { throw new Error('提醒不应读取上下文') })
  const assertLease = vi.fn(async () => {})
  const task = {
    id: '1', ownerId: 'synthetic-owner', name: '工时', payload: '  工时\n原样保留 ✅  ',
    executionMode: 'reminder' as const, channels: ['qq'], deliveryTargets: {},
    authorizedTools: [], emailAttachmentFileIds: [], workspaceId: null, filesystemGrantId: null,
  }
  const execute = createScheduledTaskExecution({ deliver, loadGroupMemory: readMemory })
  const recurring = { deliver: vi.fn(async () => ({ QQ: '已发送' })), disable: vi.fn(async () => true), notifyChanged: vi.fn(async () => {}) }
  const outcome = { status: 'success', text: task.payload, files: [] }
  expect(await execute(task, isTrial, assertLease, recurring)).toEqual({ QQ: '已发送' })
  if (isTrial) expect(deliver).toHaveBeenCalledWith(task, outcome, assertLease)
  else expect(recurring.deliver).toHaveBeenCalledWith(outcome, assertLease)
  expect(recurring.disable).not.toHaveBeenCalled()
  expect(assertLease).toHaveBeenCalledOnce()
  expect(readMemory).not.toHaveBeenCalled()
})
