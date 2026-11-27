import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createScheduledTaskTestNotifier } from '@gugu/scheduler/tasks'
import { createApp } from '../../../src/app.js'
import { createPostgresScheduledTaskResultDelivery, createPostgresScheduledTaskTestDelivery } from '../../../src/modules/scheduled-tasks/delivery/results.js'
import { createPostgresScheduledTaskTestEmailDelivery } from '../../../src/modules/scheduled-tasks/delivery/email.js'
import { createScheduledTaskFeishuDelivery } from '../../../src/modules/scheduled-tasks/delivery/feishu.js'
import { createScheduledTaskWechatDelivery } from '../../../src/modules/scheduled-tasks/delivery/wechat.js'
import { createScheduledTaskQqDelivery } from '../../../src/modules/scheduled-tasks/delivery/qq.js'
import type { ProviderHttpRequest } from '@gugu/core/providers'
import { signedUserToken } from '../../helpers/auth.js'
import { decryptEncryptedString, encryptEncryptedString } from '../../../src/adapters/security/encrypted-string.js'

test('飞书试投递使用当前 owner 的 Bot 和已验证的群地址', async () => {
  const owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  const secret = 'synthetic-feishu-notify-secret'
  const requests: ProviderHttpRequest[] = []
  let notifications = 0
  let disableBeforeSend = false
  const pool = { async query(sql: string, values: unknown[]) {
    if (sql.includes('FROM user_bots')) return { rows: values[0] === owner && !(disableBeforeSend && values[1] === 4)
      ? [{ id: 4, app_id: 'cli_synthetic', app_secret: 'synthetic-envelope', owner_platform_user_id: 'ou_owned' }] : [] }
    if (sql.includes('FROM conversation_sessions'))
      return { rows: values[0] === owner && values[1] === 'oc_owned' && values[2] === '4' ? [{ id: 6 }] : [] }
    notifications++
    return { rows: [{ id: 7, title: values[0], content: values[1], color: values[2], bubble: true, persist: true }] }
  } }
  const feishu = createScheduledTaskFeishuDelivery(pool as never, {
    enabled: () => true,
    decrypt: async value => {
      assert.equal(value, 'synthetic-envelope')
      return 'synthetic-app-secret'
    },
    transport: { async request(request) {
      requests.push(request)
      const body = requests.length === 1 ? { code: 0, tenant_access_token: 'synthetic-tenant-token' } : { code: 0, data: { message_id: 'om_synthetic' } }
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(body)) })(), async cancel() {} }
    } },
  })
  const notify = createScheduledTaskTestNotifier(createPostgresScheduledTaskTestDelivery(pool as never, async () => true, {
    async email() { throw new Error('未选择邮件') },
    feishu,
  }))
  const app = createApp({
    appName: 'Gugu', isReady: async () => true,
    userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) },
    scheduledTaskTestNotify: notify,
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks/test-notify',
      headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` },
      payload: { channels: ['web', 'feishu'], im_delivery: { feishu: { mode: 'group', chat_id: 'oc_foreign' } } },
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { detail: '找不到该群会话，请先让咕咕在群里收到一条消息' })
    assert.equal(notifications, 0)
    assert.equal(requests.length, 0)
  } finally { await app.close() }
  const result = await notify(owner, { channels: ['feishu'], im_delivery: { feishu: { mode: 'group', chat_id: 'oc_owned' } } })
  assert.deepEqual(result.result, { 飞书: '已发送' })
  assert.equal(requests.length, 2)
  assert.equal(requests[0]?.url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal')
  assert.equal(requests[1]?.url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
  assert.equal(requests[1]?.headers.Authorization, 'Bearer synthetic-tenant-token')
  assert.deepEqual(requests[1]?.body, {
    receive_id: 'oc_owned', msg_type: 'text',
    content: JSON.stringify({ text: '⏰ 活动提醒（测试）\n\n这是一条测试提醒——「活动提醒」。如果你收到了这条消息，说明提醒渠道工作正常。' }),
  })
  disableBeforeSend = true
  assert.deepEqual((await notify(owner, { channels: ['feishu'] })).result, { 飞书: '发送失败（请检查该平台连接）' })
  assert.equal(requests.length, 2)
})

test('测试提醒只持久化到当前用户通知中心并发布 best-effort 实时事件', async () => {
  const secret = 'synthetic-test-notify-secret'
  const owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  const writes: Array<{ sql: string; values: unknown[] }> = []
  const published: Array<[string, unknown]> = []
  const emailPlans: Array<{ ownerId: string; channels: string[]; title: string; text: string }> = []
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
  const notify = createScheduledTaskTestNotifier(createPostgresScheduledTaskTestDelivery(pool as never, publish, {
    async email(plan) { emailPlans.push(plan); return { '邮件': '已发送' } },
  }))
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
      color: '#7b7fb2', bubble: true, persist: true, source: 'scheduled_task',
    }]])

    const email = await app.inject({
      method: 'POST', url: '/api/v1/scheduled-tasks/test-notify', headers, payload: { channels: ['email'] },
    })
    assert.equal(email.statusCode, 200, email.body)
    assert.deepEqual(email.json(), {
      ok: true,
      result: { '邮件': '已发送' },
      msg: '测试发送结果：\n· 邮件：已发送',
    })
    assert.deepEqual(emailPlans, [{
      ownerId: owner, channels: ['email'], title: '活动提醒（测试）',
      text: '这是一条测试提醒——「活动提醒」。如果你收到了这条消息，说明提醒渠道工作正常。',
    }])
    assert.equal(writes.length, 1, '纯邮件测试不应创建 Web 通知')

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

test('旧 im 别名只采用同一启用飞书 Bot 的私聊缓存，平台停用时不外连', async () => {
  const ownerId = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  let enabled = true
  let reach = { platform: 'feishu', channel_id: '4', chat_id: null as string | null, puid: 'ou_legacy' }
  const requests: ProviderHttpRequest[] = []
  const prepare = createScheduledTaskFeishuDelivery({ async query() {
    return { rows: [{ id: 4, app_id: 'cli_synthetic', app_secret: 'synthetic-envelope', owner_platform_user_id: null }] }
  } } as never, {
    enabled: () => enabled,
    async readReach(owner) { assert.equal(owner, ownerId); return reach },
    decrypt: () => 'synthetic-app-secret',
    transport: { async request(request) {
      requests.push(request)
      const body = request.url.includes('/auth/') ? { code: 0, tenant_access_token: 'synthetic-token' } : { code: 0 }
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(body)) })(), async cancel() {} }
    } },
  })
  const plan = { ownerId, channels: ['im'], title: '测试提醒', text: '合成正文' }
  const expectNoTarget = async () => assert.equal(await (await prepare(plan))(), '无可触达地址（先给该 bot 发条消息）')
  reach.chat_id = 'oc_recent_group'
  await expectNoTarget()
  reach = { ...reach, chat_id: null, channel_id: '99' }
  await expectNoTarget()
  assert.equal(requests.length, 0)

  reach.channel_id = '4'
  assert.equal(await (await prepare(plan))(), '已发送')
  assert.match(requests[1]!.url, /receive_id_type=open_id$/)
  assert.equal((requests[1]!.body as Record<string, unknown>).receive_id, 'ou_legacy')
  const send = await prepare(plan)
  enabled = false
  assert.equal(await send(), '发送失败（请检查该平台连接）')
  assert.equal(requests.length, 2)
})

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('周期结果和停用通知共用冻结收件人，Bot 归属变化时不改发', async () => {
  const ownerId = randomUUID()
  let email = 'original@example.test'
  let recipient = 'ou_original'
  const mailRecipients: string[] = []
  const imRecipients: string[] = []
  const pool = { async query(statement: string, args: unknown[]) {
    assert.equal(args[0], ownerId)
    if (statement.includes('FROM users')) return { rows: [{ owner_email: email, smtp_host: null }] }
    return { rows: [{ id: 4, app_id: 'cli_synthetic', app_secret: 'sealed', owner_platform_user_id: recipient }] }
  } } as never
  const deliver = createPostgresScheduledTaskResultDelivery(pool, async () => true, {
    email: createPostgresScheduledTaskTestEmailDelivery(pool, {
      secretKey: 'synthetic-secret',
      globalSmtp: { host: 'smtp.example.test', port: 465, user: 'synthetic', password: '', fromAddress: 'from@example.test', enabled: true, useSsl: true },
      send: async message => { mailRecipients.push(message.toAddress) },
    }),
    feishu: createScheduledTaskFeishuDelivery(pool, {
      enabled: () => true, decrypt: () => 'synthetic-secret',
      transport: { async request(request) {
        if (!request.url.includes('/auth/')) imRecipients.push((request.body as { receive_id: string }).receive_id)
        const body = { code: 0, tenant_access_token: 'synthetic-token' }
        return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(body)) })(), async cancel() {} }
      } },
    }),
  })
  const send = await deliver.bindRecipients({
    id: '1', ownerId, name: '周期任务', payload: '', channels: ['email', 'feishu'],
    deliveryTargets: {}, emailAttachmentFilePaths: [], authorizedTools: [], workspaceId: null, filesystemGrantId: null,
  })
  email = 'new@example.test'
  assert.deepEqual(await send({ text: '任务结果', status: 'success', files: [] }), { 邮件: '已发送', 飞书: '已发送' })
  recipient = 'ou_new'
  const notice = await send({ text: '周期任务已停用', status: 'success', files: [] }, undefined, '周期任务（已停用）')
  assert.equal(notice.邮件, '已发送')
  assert.notEqual(notice.飞书, '已发送')
  assert.deepEqual(mailRecipients, ['original@example.test', 'original@example.test'])
  assert.deepEqual(imRecipients, ['ou_original'])
})

test('邮件投递后租约被接管时不再写网页通知', async () => {
  let held = true
  let emails = 0
  let webNotifications = 0
  const pool = {
    async query() { webNotifications++; return { rows: [] } },
  }
  const deliver = createPostgresScheduledTaskResultDelivery(pool as never, async () => true, {
    async email() {
      emails++
      held = false
      return { 邮件: '已发送' }
    },
  })
  await assert.rejects(deliver({
    id: '1', ownerId: randomUUID(), name: '周期任务', payload: '', channels: ['email', 'web'],
    deliveryTargets: {}, emailAttachmentFilePaths: [], authorizedTools: [], workspaceId: null,
    filesystemGrantId: null,
  }, { text: '测试', status: 'success', files: [] }, async () => {
    if (!held) throw new Error('任务执行租约已失效')
  }), /任务执行租约已失效/)
  assert.equal(emails, 1)
  assert.equal(webNotifications, 0)
})

test('实际定时正文使用保存的飞书 Bot 和群，并如实报告附件缺失', async () => {
  const ownerId = randomUUID()
  const requests: ProviderHttpRequest[] = []
  const queries: unknown[][] = []
  const pool = { async query(sql: string, params: unknown[]) {
    queries.push(params)
    if (sql.includes('FROM user_bots')) return { rows: params[1] === 8
      ? [{ id: 8, app_id: 'cli_saved', app_secret: 'sealed-synthetic', owner_platform_user_id: 'ou_saved' }] : [] }
    if (sql.includes('FROM conversation_sessions')) return { rows: params[2] === '8' ? [{ id: 1 }] : [] }
    if (sql.includes('FROM users')) return { rows: [{ owner_email: 'owner@example.test', smtp_host: null }] }
    return { rows: [{ id: 10, title: params[0], content: params[1], color: params[2], bubble: true, persist: true }] }
  } } as never
  const feishu = createScheduledTaskFeishuDelivery(pool, {
    enabled: () => true, decrypt: () => 'synthetic-app-secret',
    transport: { async request(request) {
      requests.push(request)
      const body = request.url.includes('/auth/') ? { code: 0, tenant_access_token: 'synthetic-token' } : { code: 0 }
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(body)) })(), async cancel() {} }
    } },
  })
  const deliver = createPostgresScheduledTaskResultDelivery(pool, async () => true, {
    feishu,
    email: createPostgresScheduledTaskTestEmailDelivery(pool, {
      secretKey: 'synthetic-secret',
      globalSmtp: { host: 'smtp.example.test', port: 465, user: '', password: '', fromAddress: '', enabled: true, useSsl: true },
      async send() { assert.fail('附件不支持时不发送缺附件的邮件') },
    }),
  })
  const task = { id: '3', ownerId, name: '汇报', payload: '', channels: ['web', 'feishu', 'email'],
    deliveryTargets: { feishu: { platform: 'feishu', chat_type: 'group', chat_id: 'oc_saved', channel_id: '8' } },
    authorizedTools: [], emailAttachmentFilePaths: [], workspaceId: null, filesystemGrantId: null }
  assert.deepEqual(await deliver(task, { status: 'failed', text: '执行结果', files: [{ id: 7 }] }), {
    邮件: '附件不可用（本轮生成的附件已过期，无法添加到邮件）',
    'web 通知': '已发送（网页通知不支持附件，图片未随通知显示）',
    飞书: '文字已发送，附件发送失败（0/1）',
  })
  assert.equal((requests[0]?.body as Record<string, unknown>).app_id, 'cli_saved')
  assert.deepEqual(requests[1]?.body, { receive_id: 'oc_saved', msg_type: 'text',
    content: JSON.stringify({ text: '⏰ 汇报（执行失败）\n\n执行结果' }) })
  assert.ok(queries.some(values => values[0] === ownerId && values[1] === 'oc_saved' && values[2] === '8'))
  const rejected = await deliver({ ...task, channels: ['feishu'], deliveryTargets: {
    feishu: { chat_type: 'group', chat_id: 'oc_saved', channel_id: '99' },
  } }, { status: 'success', text: '执行结果', files: [] })
  assert.deepEqual(rejected, { 飞书: '无可触达地址（先给该 bot 发条消息）' })
  assert.equal(requests.length, 2)
})

test('QQ 旧群目标仍需 owner 与 Bot 授权，使用固定沙箱消息地址且只发送一次', async () => {
  const ownerId = randomUUID()
  const requests: ProviderHttpRequest[] = []
  const bot = { id: 4, app_id: 'synthetic-app', app_secret: 'synthetic-envelope', sandbox: true, owner_platform_user_id: 'private-user', private_message_format: 'markdown', group_message_format: 'compat' }
  let accepted = true
  const pool = { async query(sql: string, params: unknown[]) {
    assert.equal(params[0], ownerId)
    if (sql.includes('FROM conversation_sessions'))
      return { rows: params[1] === 'group-owned' && params[2] === '4' ? [{ id: 8 }] : [] }
    return { rows: [bot] }
  } } as never
  const qq = createScheduledTaskQqDelivery(pool, {
    enabled: () => true, decrypt: value => {
      assert.equal(value, bot.app_secret)
      return 'synthetic-app-secret'
    },
    transport: { async request(request) {
      requests.push(request)
      const body = request.url.endsWith('/getAppAccessToken')
        ? { access_token: 'synthetic-token' }
        : accepted ? { id: 'synthetic-message' } : { code: 22009, message: 'synthetic-secret' }
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(body)) })(), async cancel() {} }
    } },
  })
  const notify = createScheduledTaskTestNotifier(createPostgresScheduledTaskTestDelivery(pool, async () => true, {
    async email() { throw new Error('未选择邮件') }, qq,
  }))
  const run = (chat_id: string) => notify(ownerId, { channels: ['qq'], qq_delivery: { mode: 'group', chat_id } })
  await assert.rejects(run('group-foreign'), { statusCode: 400 })
  assert.equal(requests.length, 0)
  assert.deepEqual((await run('group-owned')).result, { QQ: '已发送' })
  assert.deepEqual(requests.map(request => request.url), [
    'https://bots.qq.com/app/getAppAccessToken', 'https://sandbox.api.sgroup.qq.com/v2/groups/group-owned/messages',
  ])
  assert.equal(requests[1]?.headers.Authorization, 'QQBot synthetic-token')
  assert.deepEqual(JSON.parse(String(requests[1]?.body)), {
    msg_type: 0,
    msg_seq: 1,
    content: '⏰ 活动提醒（测试）\n\n这是一条测试提醒——「活动提醒」。如果你收到了这条消息，说明提醒渠道工作正常。',
  })
  accepted = false
  assert.deepEqual((await notify(ownerId, { channels: ['qq'] })).result, { QQ: '发送失败（请检查该平台连接）' })
  assert.equal(requests[3]?.url, 'https://sandbox.api.sgroup.qq.com/v2/users/private-user/messages')
  assert.equal(requests.length, 4)
  assert.equal(JSON.parse(String(requests[3]?.body)).msg_type, 2)
})

test('微信试投递只向同 owner 的当前 Bot 私聊发送，使用最新 context_token 且不掩盖业务失败', async () => {
  const ownerId = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  const requests: ProviderHttpRequest[] = []
  let reach = { platform: 'wechat', channel_id: '4', chat_id: null as string | null, puid: 'synthetic-user', context_token: 'old-context' }
  let base = 'https://ilinkai.weixin.qq.com'
  let ret = 0
  let enabled = true
  let exactReach: typeof reach | null = null
  const pool = { async query(_query: string, params: unknown[]) {
    assert.equal(params[0], ownerId)
    return { rows: [{ id: 4, app_id: base, app_secret: 'encrypted-synthetic-secret' }] }
  } } as never
  const wechat = createScheduledTaskWechatDelivery(pool, {
    enabled: () => enabled,
    readReach: async owner => { assert.equal(owner, ownerId); return reach },
    readTarget: async (owner: string, recipient: string) => {
      assert.equal(owner, ownerId)
      assert.equal(recipient, 'saved-user')
      return exactReach
    },
    decrypt: () => 'synthetic-bot-token',
    randomUin: () => 123,
    generateId: () => 'synthetic-message-id',
    transport: { async request(request) {
      requests.push(request)
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify({ ret })) })(), async cancel() {} }
    } },
  })
  const notify = createScheduledTaskTestNotifier(createPostgresScheduledTaskTestDelivery(pool, async () => true, {
    async email() { throw new Error('未选择邮件') }, wechat,
  }))
  const run = () => notify(ownerId, { channels: ['wechat'] })
  const send = await wechat({ ownerId, channels: ['wechat'], title: '任务', text: '合成正文' })
  reach.context_token = 'fresh-context'
  assert.equal(await send(), '已发送')
  assert.equal(requests[0]?.url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage')
  assert.equal(requests[0]?.headers.Authorization, 'Bearer synthetic-bot-token')
  assert.equal(requests[0]?.headers['X-WECHAT-UIN'], 'MTIz')
  assert.deepEqual(requests[0]?.body, {
    msg: { from_user_id: '', to_user_id: 'synthetic-user', client_id: 'synthetic-message-id', message_type: 2, message_state: 2,
      context_token: 'fresh-context', item_list: [{ type: 1, text_item: { text: '⏰ 任务\n\n合成正文' } }] },
    base_info: { channel_version: '2.0.1' },
  })
  ret = -1
  assert.deepEqual((await run()).result, { 微信: '发送失败（请检查该平台连接）' })
  assert.equal(requests.length, 2)
  enabled = false
  assert.deepEqual((await run()).result, { 微信: '发送失败（请检查该平台连接）' })
  enabled = true
  base = 'https://wrong.example.test'
  assert.deepEqual((await run()).result, { 微信: '发送失败（请检查该平台连接）' })
  base = ''
  for (const invalid of [{ chat_id: 'synthetic-group' }, { context_token: '' }, { channel_id: '5' }]) {
    const previous = reach
    reach = { ...reach, ...invalid }
    assert.deepEqual((await run()).result, { 微信: '无可触达地址（先给该 bot 发条消息）' })
    reach = previous
  }
  assert.equal(requests.length, 2)

  ret = 0
  const fixed = { ownerId, channels: ['wechat'], title: '任务', text: '合成正文', fixedTargets: {
    wechat: { platform: 'wechat', channel_id: '4', chat_type: 'c2c', puid: 'saved-user', context_token: 'untrusted' },
  } }
  assert.equal(await (await wechat(fixed))(), '无可触达地址（先给该 bot 发条消息）')
  exactReach = { ...reach, puid: 'saved-user', context_token: 'saved-context' }
  const sendFixed = await wechat(fixed)
  exactReach = { ...exactReach, context_token: 'fresh-saved-context' }
  assert.equal(await sendFixed(), '已发送')
  const sent = requests[2]?.body as { msg: { to_user_id: string; context_token: string } }
  assert.equal(sent.msg.to_user_id, 'saved-user')
  assert.equal(sent.msg.context_token, 'fresh-saved-context')
  exactReach = { ...exactReach, channel_id: '99' }
  assert.equal(await sendFixed(), '发送失败（请检查该平台连接）')
  assert.equal(requests.length, 3)
})
test('隔离 PostgreSQL 校验飞书、微信和 QQ 的收件人归属及 Bot 变更', { skip: !pgUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `test_notify_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE user_bots(id integer PRIMARY KEY, user_id uuid NOT NULL, platform varchar(20), enabled boolean,
      app_id varchar(128), app_secret text, owner_platform_user_id varchar(128));
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY, user_id uuid NOT NULL, source varchar(20),
      chat_type varchar(20), chat_id varchar(128), bot_id varchar(128))`)
    const ownerId = randomUUID(), other = randomUUID(), secretKey = 'synthetic-notify-master-key'
    const envelope = encryptEncryptedString(secretKey, 'synthetic-bot-secret')
    await pool.query("INSERT INTO user_bots VALUES (4,$1,'feishu',TRUE,'cli_synthetic',$3,'ou_owner'), (5,$2,'feishu',TRUE,'cli_other',$3,'ou_other')", [ownerId, other, envelope])
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'feishu','group','oc_foreign','4'), (2,$2,'feishu','group','oc_wrong_bot','5'), (3,$2,'feishu','group','oc_owned','4')", [other, ownerId])
    const requests: ProviderHttpRequest[] = []
    const prepare = createScheduledTaskFeishuDelivery(pool, {
      enabled: () => true, decrypt: value => decryptEncryptedString(secretKey, value),
      transport: { async request(request) {
        requests.push(request)
        const body = request.url.includes('/auth/')
          ? { code: 0, tenant_access_token: 'synthetic-token' } : { code: 0 }
        return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(body)) })(), async cancel() {} }
      } },
    })
    const plan = (chat_id: string) => ({ ownerId, channels: ['feishu'], title: '测试提醒', text: '合成正文',
      imDelivery: { feishu: { mode: 'group', chat_id } } })
    await assert.rejects(prepare(plan('oc_foreign')), { statusCode: 400 })
    await assert.rejects(prepare(plan('oc_wrong_bot')), { statusCode: 400 })
    const fixedPlan = (chat_id: string, channel_id: string) => ({
      ownerId, channels: ['feishu'], title: '执行结果', text: '合成正文',
      fixedTargets: { feishu: { chat_type: 'group', chat_id, channel_id } },
    })
    for (const denied of [fixedPlan('oc_foreign', '4'), fixedPlan('oc_wrong_bot', '5')])
      assert.equal(await (await prepare(denied))(), '无可触达地址（先给该 bot 发条消息）')
    assert.equal(requests.length, 0)
    const send = await prepare(plan('oc_owned'))
    assert.equal(await send(), '已发送')
    assert.deepEqual(requests[0]?.body, { app_id: 'cli_synthetic', app_secret: 'synthetic-bot-secret' })
    await pool.query("UPDATE user_bots SET app_id='cli_replaced' WHERE id=4")
    assert.equal(await send(), '发送失败（请检查该平台连接）')
    assert.equal(requests.length, 2)
    await pool.query("INSERT INTO user_bots VALUES (10,$1,'feishu',TRUE,'cli_saved',$2,'ou_saved')", [ownerId, envelope])
    await pool.query("INSERT INTO conversation_sessions VALUES (6,$1,'feishu','group','oc_saved','10')", [ownerId])
    const sendSaved = await prepare(fixedPlan('oc_saved', '10'))
    assert.equal(await sendSaved(), '已发送')
    assert.deepEqual(requests[2]?.body, { app_id: 'cli_saved', app_secret: 'synthetic-bot-secret' })
    await pool.query('DELETE FROM conversation_sessions WHERE id=6')
    assert.equal(await sendSaved(), '发送失败（请检查该平台连接）')
    assert.equal(requests.length, 4)

    await pool.query("INSERT INTO user_bots VALUES (6,$1,'wechat',TRUE,'',$3,NULL), (7,$2,'wechat',TRUE,'',$3,NULL)", [ownerId, other, envelope])
    const wechatRequests: ProviderHttpRequest[] = []
    let reachableBotId = '7'
    const wechat = createScheduledTaskWechatDelivery(pool, {
      enabled: () => true,
      readReach: async owner => {
        assert.equal(owner, ownerId)
        return { platform: 'wechat', channel_id: reachableBotId, chat_id: null, puid: 'synthetic-user', context_token: 'synthetic-context' }
      },
      decrypt: value => decryptEncryptedString(secretKey, value),
      generateId: randomUUID, randomUin: () => 1,
      transport: { async request(request) {
        wechatRequests.push(request)
        return { status: 200, headers: {}, body: (async function* () { yield Buffer.from('{"ret":0}') })(), async cancel() {} }
      } },
    })
    const privatePlan = { ownerId, channels: ['wechat'], title: '提醒', text: '合成正文' }
    assert.equal(await (await wechat(privatePlan))(), '无可触达地址（先给该 bot 发条消息）')
    assert.equal(wechatRequests.length, 0)
    reachableBotId = '6'
    const sendWechat = await wechat(privatePlan)
    assert.equal(await sendWechat(), '已发送')
    assert.equal(wechatRequests[0]?.headers.Authorization, 'Bearer synthetic-bot-secret')
    await pool.query('UPDATE user_bots SET enabled=FALSE WHERE id=6')
    assert.equal(await sendWechat(), '发送失败（请检查该平台连接）')
    assert.equal(wechatRequests.length, 1)

    await pool.query('ALTER TABLE user_bots ADD COLUMN sandbox boolean NOT NULL DEFAULT FALSE')
    await pool.query('ALTER TABLE user_bots ADD COLUMN private_message_format text, ADD COLUMN group_message_format text')
    await pool.query("INSERT INTO user_bots VALUES (8,$1,'qq',TRUE,'qq-synthetic',$3,'private-owner',FALSE), (9,$2,'qq',TRUE,'qq-other',$3,'private-other',FALSE)", [ownerId, other, envelope])
    await pool.query("INSERT INTO conversation_sessions VALUES (4,$1,'qq','group','qq-foreign','8'), (5,$2,'qq','group','qq-owned','8')", [other, ownerId])
    const qqRequests: ProviderHttpRequest[] = []
    const qq = createScheduledTaskQqDelivery(pool, {
      enabled: () => true, decrypt: value => decryptEncryptedString(secretKey, value),
      transport: { async request(request) {
        qqRequests.push(request)
        const body = request.url.endsWith('/getAppAccessToken') ? '{"access_token":"synthetic-token"}' : '{"id":"synthetic-message"}'
        return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(body) })(), async cancel() {} }
      } },
    })
    const qqPlan = (chat_id: string) => ({ ...privatePlan, channels: ['qq'],
      imDelivery: { qq: { mode: 'group', chat_id } } })
    await assert.rejects(qq(qqPlan('qq-foreign')), { statusCode: 400 })
    assert.equal(qqRequests.length, 0)
    const sendQq = await qq(qqPlan('qq-owned'))
    assert.equal(await sendQq(), '已发送')
    assert.deepEqual(JSON.parse(String(qqRequests[0]?.body)), { appId: 'qq-synthetic', clientSecret: 'synthetic-bot-secret' })
    assert.equal(qqRequests[1]?.url, 'https://api.sgroup.qq.com/v2/groups/qq-owned/messages')
    await pool.query('UPDATE user_bots SET sandbox=TRUE WHERE id=8')
    assert.equal(await sendQq(), '发送失败（请检查该平台连接）')
    assert.equal(qqRequests.length, 2)
  } finally {
    await pool.end()
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`) } finally { await admin.end() }
  }
})
