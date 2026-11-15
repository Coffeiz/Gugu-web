import assert from 'node:assert/strict'
import test from 'node:test'
import { createScheduledTaskTestNotifier } from '../../src/scheduled-tasks/test-notify.js'

test('测试提醒过滤未知渠道、回退 Web 并按 Python 契约生成消息', async () => {
  const plans: unknown[] = []
  const notify = createScheduledTaskTestNotifier(async plan => {
    plans.push(plan)
    return { 'web 通知': '已保存（实时提示失败）' }
  })
  const result = await notify('owner-1', { channels: ['unknown', 'web', 'web'], name: '  周会  ' })
  assert.deepEqual(plans, [{
    ownerId: 'owner-1', channels: ['web'], title: '周会（测试）',
    text: '这是一条测试提醒——「周会」。如果你收到了这条消息，说明提醒渠道工作正常。',
  }])
  assert.deepEqual(result, {
    ok: true,
    result: { 'web 通知': '已保存（实时提示失败）' },
    msg: '测试发送结果：\n· web 通知：已保存（实时提示失败）',
  })
})

test('空或全部不支持的渠道回退 Web，空名称使用默认标题', async () => {
  const plans: unknown[] = []
  const notify = createScheduledTaskTestNotifier(async plan => { plans.push(plan); return {} })
  await notify('owner-2', { channels: ['future-channel'], name: '' })
  assert.deepEqual(plans, [{
    ownerId: 'owner-2', channels: ['web'], title: '活动提醒（测试）',
    text: '这是一条测试提醒——「活动提醒」。如果你收到了这条消息，说明提醒渠道工作正常。',
  }])
})
