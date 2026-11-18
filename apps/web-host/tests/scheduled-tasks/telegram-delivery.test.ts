import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderHttpRequest } from '@gugu/core/providers'
import { createTelegramBotApi } from '@gugu/core/im/telegram-connect'
import { createScheduledTaskTestNotifier } from '@gugu/core/scheduled-task-test-notify'
import { createApp } from '../../src/app.js'
import { createPostgresScheduledTaskTestDelivery } from '../../src/modules/scheduled-tasks/test-notify-postgres.js'
import { createScheduledTaskTelegramDelivery } from '../../src/modules/scheduled-tasks/telegram-delivery.js'
import { signedUserToken } from '../helpers/auth.js'

const owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
const token = '123456:syntheticTelegramToken_0123456789'

test('Telegram 试投递只向 owner Bot 的私聊或已验证群发送固定模板', async () => {
  const requests: ProviderHttpRequest[] = []
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const pool = { async query(sql: string, values: unknown[]) {
    queries.push({ sql, values })
    if (sql.includes('FROM user_bots')) return { rows: values[0] === owner
      ? [{ id: 4, app_id: '987654', app_secret: 'synthetic-envelope', owner_platform_user_id: '123456789' }] : [] }
    if (sql.includes('FROM conversation_sessions'))
      return { rows: values[0] === owner && values[1] === '-1007002' && values[2] === '4' ? [{ id: 10 }] : [] }
    return { rows: [] }
  } }
  const transport = { async request(request: ProviderHttpRequest) {
    requests.push(request)
    return { status: 200, headers: {}, body: (async function* () {
      yield Buffer.from(JSON.stringify({ ok: true, result: { message_id: 7 } }))
    })(), async cancel() {} }
  } }
  const delivery = createScheduledTaskTelegramDelivery(pool as never, {
    enabled: () => true,
    decrypt: value => { assert.equal(value, 'synthetic-envelope'); return token },
    sendMessage: (value, chatId, text) => createTelegramBotApi(transport).sendMessage(value, chatId, text),
  })
  const plan = { ownerId: owner, channels: ['telegram'], title: '活动提醒（测试）',
    text: '这是合成测试正文', imDelivery: { telegram: { mode: 'private' } } }

  const privateSend = await delivery(plan)
  assert.equal(await privateSend(), '已发送')
  assert.equal(requests[0]?.url, `https://api.telegram.org/bot${token}/sendMessage`)
  assert.deepEqual(requests[0]?.body, { chat_id: '123456789', text: '⏰ 活动提醒（测试）\n\n这是合成测试正文' })

  await assert.rejects(delivery({ ...plan, imDelivery: { telegram: { mode: 'group', chat_id: '-1007999' } } }),
    { statusCode: 400 })
  assert.equal(requests.length, 1)

  const groupSend = await delivery({ ...plan, imDelivery: { telegram: { mode: 'group', chat_id: '-1007002' } } })
  assert.equal(await groupSend(), '已发送')
  assert.deepEqual(requests[1]?.body, { chat_id: '-1007002', text: '⏰ 活动提醒（测试）\n\n这是合成测试正文' })
  assert.ok(queries.some(query => query.sql.includes('conversation_sessions') && query.values[1] === '-1007002'))
})

test('Telegram 试投递在 Bot 停用或平台关闭后不会调用外部服务', async () => {
  const requests: ProviderHttpRequest[] = []
  let enabled = true
  let botEnabled = true
  const delivery = createScheduledTaskTelegramDelivery({ async query(sql: string) {
    if (sql.includes('FROM user_bots')) return { rows: botEnabled ? [{ id: 4, app_id: '987654', app_secret: 'synthetic-envelope', owner_platform_user_id: '123456789' }] : [] }
    return { rows: [] }
  } } as never, {
    enabled: () => enabled, decrypt: () => token,
    sendMessage: (value, chatId, text) => createTelegramBotApi({ async request(request) {
      requests.push(request)
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from('{"ok":true,"result":{"message_id":8}}') })(), async cancel() {} }
    } }).sendMessage(value, chatId, text),
  })
  const plan = { ownerId: owner, channels: ['telegram'], title: '活动提醒（测试）', text: '正文',
    imDelivery: { telegram: { mode: 'private' } } }
  const send = await delivery(plan)
  botEnabled = false
  assert.equal(await send(), '发送失败（请检查该平台连接）')
  assert.equal(requests.length, 0)
  botEnabled = true
  enabled = false
  const disabled = await delivery(plan)
  assert.equal(await disabled(), '发送失败（请检查该平台连接）')
  assert.equal(requests.length, 0)
})

test('Telegram 定时结果附件先按 owner 读取，再复核平台和 Bot 后发送', async () => {
  let enabled = true
  let botEnabled = true
  const reads: Array<{ ownerId: string; artifact: unknown; limit: number }> = []
  const sends: Array<{ value: string; chatId: string; file: unknown }> = []
  const delivery = createScheduledTaskTelegramDelivery({ async query(sql: string) {
    if (sql.includes('FROM user_bots')) return { rows: botEnabled
      ? [{ id: 4, app_id: '987654', app_secret: 'synthetic-envelope', owner_platform_user_id: '123456789' }] : [] }
    return { rows: [] }
  } } as never, {
    enabled: () => enabled,
    decrypt: () => token,
    sendMessage: async () => true,
    sendAttachment: async (value, chatId, file) => { sends.push({ value, chatId, file }); return true },
    readAttachment: async (ownerId, artifact, limit) => {
      reads.push({ ownerId, artifact, limit: limit('pdf') })
      return { bytes: new Uint8Array([1, 2, 3]), filename: 'report.pdf', mime: 'application/pdf', ext: 'pdf' }
    },
  })
  const plan = { ownerId: owner, channels: ['telegram'], title: '结果', text: '已完成',
    artifacts: [{ file_id: 91, name: 'report.pdf' }], imDelivery: { telegram: { mode: 'private' } } }
  const prepared = await delivery(plan)
  assert.equal(await prepared.sendAttachment?.(plan.artifacts[0]), true)
  assert.deepEqual(reads, [{ ownerId: owner, artifact: plan.artifacts[0], limit: 50_000_000 }])
  assert.deepEqual(sends, [{ value: token, chatId: '123456789', file: {
    bytes: new Uint8Array([1, 2, 3]), filename: 'report.pdf', mime: 'application/octet-stream',
  } }])
  enabled = false
  assert.equal(await prepared.sendAttachment?.(plan.artifacts[0]), false)
  enabled = true
  botEnabled = false
  assert.equal(await prepared.sendAttachment?.(plan.artifacts[0]), false)
  assert.equal(sends.length, 1)
})

test('Telegram 文字成功但附件失败时保留可重试的失败结果', async () => {
  const pool = { async query(sql: string) {
    if (sql.includes('FROM user_bots')) return { rows: [{ id: 4, app_id: '987654', app_secret: 'synthetic-envelope', owner_platform_user_id: '123456789' }] }
    return { rows: [] }
  } }
  const notifier = createPostgresScheduledTaskTestDelivery(pool as never, async () => true, {
    async email() { throw new Error('未选择邮件') },
    telegram: createScheduledTaskTelegramDelivery(pool as never, {
      enabled: () => true, decrypt: () => token,
      sendMessage: async () => true,
    sendAttachment: async () => false,
      readAttachment: async () => ({ bytes: new Uint8Array([1]), filename: 'report.pdf', ext: 'pdf' }),
    }),
  })
  const result = await notifier({ ownerId: owner, channels: ['telegram'], title: '日报', text: '已生成',
    artifacts: [{ file_id: 91, name: 'report.pdf' }] } as never)
  assert.deepEqual(result, { Telegram: '文字已发送，附件发送失败（0/1）' })
})

test('认证后的生产试投递路由返回 Telegram 发送状态且不回显 Token', async () => {
  const requests: ProviderHttpRequest[] = []
  const pool = { async query(sql: string, values: unknown[]) {
    if (sql.includes('FROM user_bots')) return { rows: values[0] === owner
      ? [{ id: 4, app_id: '987654', app_secret: 'synthetic-envelope', owner_platform_user_id: '123456789' }] : [] }
    return { rows: [] }
  } }
  const notify = createScheduledTaskTestNotifier(createPostgresScheduledTaskTestDelivery(pool as never, async () => true, {
    async email() { throw new Error('未选择邮件') },
    telegram: createScheduledTaskTelegramDelivery(pool as never, {
      enabled: () => true, decrypt: () => token,
      sendMessage: (value, chatId, text) => createTelegramBotApi({ async request(request) {
        requests.push(request)
        return { status: 200, headers: {}, body: (async function* () {
          yield Buffer.from('{"ok":true,"result":{"message_id":9}}')
        })(), async cancel() {} }
      } }).sendMessage(value, chatId, text),
    }),
  }))
  const secret = 'synthetic-test-notify-auth'
  const app = createApp({
    appName: 'Gugu', isReady: async () => true,
    userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: null,
      isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null,
      timezone: null, emailSubscribed: false, imChannels: [] }) },
    scheduledTaskTestNotify: notify,
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks/test-notify',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` },
      payload: { channels: ['telegram'], im_delivery: { telegram: { mode: 'private' } } },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().result, { Telegram: '已发送' })
    assert.equal(response.body.includes(token), false)
    assert.equal(requests.length, 1)
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks/test-notify',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` },
      payload: { channels: ['telegram'], im_delivery: { telegram: { mode: 'group', chat_id: '-1007999' } } },
    })
    assert.equal(foreign.statusCode, 400)
    assert.equal(requests.length, 1)
  } finally { await app.close() }
})
