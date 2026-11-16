import assert from 'node:assert/strict'
import test from 'node:test'
import { encryptEncryptedString } from '../../src/adapters/encrypted-string.js'
import { createPostgresScheduledTaskTestEmailDelivery } from '../../src/modules/scheduled-tasks/test-notify-email.js'

const owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
const secret = 'synthetic-smtp-secret'
const globalSmtp = {
  host: 'global.smtp.example.test', port: 465, user: 'global-user', password: 'global-password',
  fromAddress: 'global@example.test', enabled: true, useSsl: true,
}

function pool(row: Record<string, unknown> | undefined) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  return {
    calls,
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values })
      return { rows: row ? [row] : [] }
    },
  }
}

test('邮件测试通知只投递当前 owner 注册邮箱，并优先使用其启用的 SMTP 与外观偏好', async () => {
  const smtpPassword = encryptEncryptedString(secret, 'user-smtp-password')
  const database = pool({
    owner_email: 'owner@example.test', preferences: { theme: 'dark', palette: 'blue' },
    smtp_host: 'user.smtp.example.test', smtp_port: 587, smtp_user: 'user-smtp',
    smtp_password: smtpPassword, smtp_from_addr: '咕咕提醒', smtp_use_ssl: false,
  })
  const deliveries: unknown[] = []
  const deliver = createPostgresScheduledTaskTestEmailDelivery(database as never, {
    secretKey: secret, globalSmtp,
    async send(value) { deliveries.push(value) },
  })
  const result = await deliver({
    ownerId: owner, channels: ['email'], title: '活动提醒（测试）',
    text: '这是一条合成提醒正文。',
  })

  assert.deepEqual(result, { '邮件': '已发送' })
  assert.deepEqual(database.calls.map(call => call.values), [[owner]])
  assert.match(database.calls[0]!.sql, /users/)
  assert.match(database.calls[0]!.sql, /user_smtp_configs/)
  assert.match(database.calls[0]!.sql, /s\.enabled IS TRUE/)
  const sentDelivery = deliveries[0] as {
    host: string; port: number; user: string; password: string; fromName: string
    fromAddress: string; toAddress: string; secure: boolean
    message: { subject: string; plain: string; html: string; images: unknown[] }
  }
  assert.deepEqual({ ...sentDelivery, message: undefined }, {
    host: 'user.smtp.example.test', port: 587, user: 'user-smtp', password: 'user-smtp-password',
    fromName: '咕咕提醒', fromAddress: 'user-smtp', toAddress: 'owner@example.test', secure: false,
    message: undefined,
  })
  const sent = sentDelivery
  assert.equal(sent.message.subject, '咕咕 · 活动提醒（测试）')
  assert.equal(sent.message.plain, '这是一条合成提醒正文。')
  assert.match(sent.message.html, /这是一条合成提醒正文。/)
  assert.equal(sent.message.images.length, 2)
})

test('缺少注册邮箱时不连接 SMTP', async () => {
  const database = pool({ owner_email: '', preferences: {}, smtp_host: null })
  let sent = false
  const deliver = createPostgresScheduledTaskTestEmailDelivery(database as never, {
    secretKey: secret, globalSmtp,
    async send() { sent = true },
  })
  const result = await deliver({ ownerId: owner, channels: ['email'], title: '测试', text: '正文' })
  assert.deepEqual(result, { '邮件': '收件人邮箱不存在' })
  assert.equal(sent, false)
})

test('无启用用户 SMTP 时使用平台 SMTP；发送失败返回脱敏状态', async () => {
  const database = pool({ owner_email: 'owner@example.test', preferences: {}, smtp_host: null })
  const deliveries: unknown[] = []
  const deliver = createPostgresScheduledTaskTestEmailDelivery(database as never, {
    secretKey: secret, globalSmtp,
    async send(value) { deliveries.push(value); throw new Error('credential must not escape') },
  })
  const result = await deliver({ ownerId: owner, channels: ['email'], title: '测试', text: '正文' })
  assert.deepEqual(result, { '邮件': '发送失败（smtp_delivery_error）' })
  assert.equal(deliveries.length, 1)
  assert.equal((deliveries[0] as { host: string }).host, globalSmtp.host)
  assert.equal(JSON.stringify(result).includes('credential must not escape'), false)
})
