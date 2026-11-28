import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createScheduledTaskTestNotifier } from '@gugu/scheduler/tasks'

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

test('多个选中的群投递在发送前拒绝，旧 QQ 字段与未选中的群保持兼容', async () => {
  const plans: unknown[] = []
  const notify = createScheduledTaskTestNotifier(async plan => { plans.push(plan); return {} })
  const targets = { qq_delivery: { mode: 'group', chat_id: 'qq-group' },
    im_delivery: { feishu: { mode: 'group', chat_id: 'feishu-group' } } }
  await assert.rejects(notify('owner-1', { ...targets, channels: ['email', 'qq', 'feishu'] }), {
    statusCode: 400, message: '一个定时任务目前只能设置一个群聊投递目标',
  })
  assert.equal(plans.length, 0)
  await notify('owner-1', { ...targets, channels: ['qq'] })
  assert.equal(plans.length, 1)
})
