import assert from 'node:assert/strict'
import test from 'node:test'
import { createScheduledTaskTestNotifier } from '@gugu/core/scheduled-task-test-notify'
import { createApp } from '../../src/app.js'
import { createPostgresScheduledTaskTestDelivery } from '../../src/modules/scheduled-tasks/test-notify-postgres.js'
import { signedUserToken } from '../helpers/auth.js'

test('测试提醒只持久化到当前用户通知中心并发布 best-effort 实时事件', async () => {
  const secret = 'synthetic-test-notify-secret'
  const owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  const writes: Array<{ sql: string; values: unknown[] }> = []
  const published: Array<[string, unknown]> = []
  let databaseAvailable = true
  let redisAvailable = true
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      writes.push({ sql, values })
      if (!databaseAvailable) throw new Error('synthetic database outage')
      return { rows: [{ id: 501, title: values[0], content: values[1], color: values[2], bubble: true, persist: true }] }
    },
  }
  const publish = async (target: string, note: unknown) => { published.push([target, note]); return redisAvailable }
  const notify = createScheduledTaskTestNotifier(createPostgresScheduledTaskTestDelivery(pool as never, publish))
  const app = createApp({
    appName: 'Gugu', isReady: async () => true,
    userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) },
    scheduledTaskTestNotify: notify,
  })
  try {
    const headers = { authorization: `Bearer ${signedUserToken(secret, owner)}` }
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks/test-notify', payload: {} })).statusCode, 401)
    const response = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks/test-notify', headers, payload: { channels: ['web'], name: '活动提醒' } })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), {
      ok: true,
      result: { 'web 通知': '已发送' },
      msg: '测试发送结果：\n· web 通知：已发送',
    })
    assert.equal(writes.length, 1)
    assert.match(writes[0]!.sql, /INSERT INTO site_notifications/)
    assert.deepEqual(writes[0]!.values, [
      '活动提醒（测试）',
      '这是一条测试提醒——「活动提醒」。如果你收到了这条消息，说明提醒渠道工作正常。',
      '#7b7fb2', owner,
    ])
    assert.deepEqual(published, [[owner, {
      id: 501,
      title: '活动提醒（测试）',
      content: '这是一条测试提醒——「活动提醒」。如果你收到了这条消息，说明提醒渠道工作正常。',
      color: '#7b7fb2', bubble: true, persist: true,
    }]])

    const unsupported = await app.inject({
      method: 'POST', url: '/api/v1/scheduled-tasks/test-notify', headers, payload: { channels: ['email'] },
    })
    assert.equal(unsupported.statusCode, 200, unsupported.body)
    assert.deepEqual(unsupported.json(), {
      ok: true,
      result: { '邮件': 'Node 服务暂未接入该投递渠道' },
      msg: '测试发送结果：\n· 邮件：Node 服务暂未接入该投递渠道',
    })
    assert.equal(writes.length, 1, '未接入的邮件渠道不能假写 Web 通知')

    redisAvailable = false
    const redisFailure = await app.inject({
      method: 'POST', url: '/api/v1/scheduled-tasks/test-notify', headers, payload: { name: '实时故障' },
    })
    assert.equal(redisFailure.statusCode, 200, redisFailure.body)
    assert.equal(redisFailure.json().result['web 通知'], '已保存（实时提示失败）')

    databaseAvailable = false
    const databaseFailure = await app.inject({
      method: 'POST', url: '/api/v1/scheduled-tasks/test-notify', headers, payload: { name: '数据库故障' },
    })
    assert.equal(databaseFailure.statusCode, 200, databaseFailure.body)
    assert.equal(databaseFailure.json().result['web 通知'], '发送失败（通知中心不可用）')
  } finally { await app.close() }
})
