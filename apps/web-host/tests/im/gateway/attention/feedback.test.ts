import assert from 'node:assert/strict'
import test from 'node:test'
import { Agent } from 'node:https'
import type { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { ProviderError, type ProviderTransport } from '@gugu/core/providers'
import type { TrustedGatewayBot } from '../../../../src/modules/im/gateway/bot-config.js'
import { createPlatformConnections, type GatewayConnectionServices } from '../../../../src/modules/im/gateway/connections.js'
import type { QqSocket } from '@gugu/gateway/qq'

const owner = '00000000-0000-4000-8000-000000000087', cutoff = '2026-01-01 00:00:00.123456+00'
const token = '123456:synthetic_telegram_feedback_token_123'
const spec = (platform: 'telegram' | 'wechat'): TrustedGatewayBot => ({ key: `${platform}:4`, id: '4', platform, owner,
  revision: 'synthetic-feedback-v1', sandbox: false, credentials: { appId: platform === 'wechat' ? 'https://ilinkai.weixin.qq.com' : '', appSecret: platform === 'telegram' ? token : 'synthetic-wechat-token' } })
const response = (body: unknown, status = 200) => ({ status, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(body)) })(), async cancel() {} })
const waiting = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
  if (signal.aborted) reject(new Error('合成停止'))
  else signal.addEventListener('abort', () => reject(new Error('合成停止')), { once: true })
})

/** 平台协议/parser/预检/sender/API使用生产实现；准入、当前授权、控制事务和Redis为显式替身。 */
async function scenario(input: { platform: 'telegram' | 'wechat'; mode: 'control' | 'retry' | 'media'; revoke: boolean; admitted?: boolean }) {
  let allowed = true, polls = 0, sends = 0, media = 0, inspected = 0, enqueued = 0
  let done!: () => void
  const completed = new Promise<void>(resolve => { done = resolve })
  const scopes: unknown[] = [], reports: string[] = []
  const services: GatewayConnectionServices = {
    admission: {
      async begin() { return input.admitted ? { status: 'admitted', receivedAt: cutoff, controlEventId: 'a'.repeat(64) }
        : { status: 'first', token: 'synthetic-admission', receivedAt: cutoff, controlEventId: 'a'.repeat(64) } },
      async finish() {}, async markUnknown() {},
    },
    controls: {
      async authorize(scope) {
        assert.equal(scope.ownerId, owner); assert.equal(scope.botId, '4'); assert.equal(scope.chatId, null)
        assert.equal(scope.platformUserId, input.platform === 'telegram' ? '9' : 'synthetic-wx-user')
        assert.equal(scope.admissionCutoff, cutoff); assert.equal(scope.eventId, 'a'.repeat(64)); scopes.push(scope)
        return allowed
      },
      async inspectSecret() { inspected++; return { status: 'none' } },
      async applySecret() { throw new Error('不应消费秘密') }, async bindQqOwnerIfUnbound() {}, async consumeBinding() { return false },
      async consumeTextChoice() { return null },
      async decideShortcut() { return { action: 'cancel', reference: 'synthetic-run', reply: '已取消合成任务' } },
      async cancel() { if (input.mode === 'control' && input.revoke) allowed = false; return true },
    },
    attachments: { async stage() { throw new Error('不应暂存') }, async reuse() { return null }, async release() {} },
    async callback() { return { consumed: true, accepted: false } },
    async telegramToken() { return token },
  }
  const transport: ProviderTransport = { async request(request, signal) {
    const path = new URL(request.url).pathname
    if (path.endsWith('/getMe')) return response({ ok: true, result: { id: 99, username: 'synthetic_bot' } })
    if (path.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '' } })
    if (path.endsWith('/notifystart') || path.endsWith('/notifystop')) return response({ ret: 0 })
    if (path.endsWith('/getUpdates') || path.endsWith('/getupdates')) {
      if (polls++) { done(); return waiting(signal) }
      if (input.platform === 'telegram') return response({ ok: true, result: [{ update_id: 4, message: {
        message_id: 19, date: 100, chat: { id: 9, type: 'private' }, from: { id: 9 },
        ...(input.mode === 'media' ? { photo: [{ file_id: 'synthetic-file', file_size: 4 }] } : { text: '取消' }),
      } }] })
      return response({ ret: 0, msgs: [{ message_type: 1, from_user_id: 'synthetic-wx-user', context_token: 'synthetic-context-private',
        item_list: [{ type: 1, text_item: { text: '取消' } }] }], get_updates_buf: 'synthetic-cursor' })
    }
    if (path.endsWith('/getFile')) {
      media++; if (input.revoke) allowed = false
      return response({ ok: false, error_code: 503 }, 503)
    }
    if (path.endsWith('/sendMessage') || path.endsWith('/sendmessage')) {
      sends++
      if (input.mode === 'retry' && sends === 1) {
        if (input.revoke) allowed = false
        if (input.platform === 'telegram') return response({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429)
        throw new ProviderError('network', { retryable: true, requestStarted: false })
      }
      return response(input.platform === 'telegram' ? { ok: true, result: { message_id: 71 } } : { ret: 0 })
    }
    throw new Error('未预期的合成协议方法')
  }, async close() {} }
  const connections = createPlatformConnections({ secretKey: 'synthetic-feedback-key', sanitizeText: value => value,
    redis: { async sendCommand(args) {
      if (args[0] === 'GET') return null
      // Telegram控制消息仍以payload=''提交游标；仅非空载荷代表普通消息入队。
      if (args[0] === 'EVAL' && args[4 + Number(args[2])]) enqueued++
      return 1
    } },
    services: () => services, transport: () => transport,
    clock: { now: () => 0, sleep: async (_ms, signal) => waiting(signal) },
    report(code) { reports.push(code); done() },
  })
  const connection = await connections.connect(spec(input.platform), new AbortController().signal)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([completed, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('合成反馈未完成')), 5000); timeout.unref() })])
    return { sends, media, inspected, enqueued, scopes, reports }
  } finally { if (timeout) clearTimeout(timeout); await connection.stop() }
}

test('TG/微信控制事务等待后撤权，实际预检回复不发送；有效授权仍可发送', async () => {
  for (const platform of ['telegram', 'wechat'] as const) for (const revoke of [false, true]) {
    const result = await scenario({ platform, mode: 'control', revoke })
    assert.equal(result.sends, revoke ? 0 : 1)
    assert.ok(result.scopes.length >= 2)
    assert.equal(result.enqueued, 0)
  }
})

test('TG控制回复429等待与微信确定连接前重试，每次实际HTTP前复核撤权', async () => {
  for (const platform of ['telegram', 'wechat'] as const) {
    const result = await scenario({ platform, mode: 'retry', revoke: true })
    assert.equal(result.sends, 1)
    assert.equal(result.enqueued, 0)
    assert.ok(result.scopes.length >= 3)
  }
})

test('Telegram媒体失败通知实时复核授权；已准入重投用原收据guard且不重跑控制', async () => {
  for (const admitted of [false, true]) for (const revoke of [false, true]) {
    const result = await scenario({ platform: 'telegram', mode: 'media', revoke, admitted })
    assert.equal(result.media, 1); assert.equal(result.sends, revoke ? 0 : 1); assert.equal(result.enqueued, 0)
    assert.equal(result.inspected, admitted ? 0 : 1)
    assert.ok(result.scopes.length > 0)
  }
})

/** QQ WS与飞书SDK仅替代传输；消息解析、控制预检、文本sender及Token刷新均为生产模块。 */
async function pushFeedback(platform: 'qq' | 'feishu', phase: 'cancel' | 'refresh', revoke: boolean) {
  let allowed = true, cancelled = false, sends = 0, authCalls = 0, checks = 0, socketSignal!: AbortSignal
  let done!: () => void
  const completed = new Promise<void>(resolve => { done = resolve })
  const bot: TrustedGatewayBot = { key: `${platform}:4`, id: '4', owner, platform, revision: 'synthetic-push-feedback', sandbox: false,
    credentials: { appId: platform === 'feishu' ? 'cli_0123456789abcdef' : 'synthetic-app', appSecret: 'synthetic-bot-secret' } }
  const services: GatewayConnectionServices = {
    admission: { async begin() { return { status: 'first', token: 'synthetic-admission', receivedAt: cutoff, controlEventId: 'b'.repeat(64) } },
      async finish() { done() }, async markUnknown() { done() } },
    controls: {
      async authorize(scope) {
        assert.equal(scope.ownerId, owner); assert.equal(scope.botId, '4'); assert.equal(scope.platform, platform)
        assert.equal(scope.chatId, null); assert.equal(scope.platformUserId, platform === 'qq' ? 'member-a' : 'ou_member')
        assert.equal(scope.admissionCutoff, cutoff); assert.equal(scope.eventId, 'b'.repeat(64)); checks++
        return allowed
      },
      async inspectSecret() { return { status: 'none' } }, async applySecret() { throw new Error('不应处理秘密') },
      async bindQqOwnerIfUnbound() {}, async consumeBinding() { return false }, async consumeTextChoice() { return null },
      async decideShortcut() { return { action: 'cancel', reference: 'synthetic-push-run', reply: '已取消合成任务' } },
      async cancel() { await new Promise(resolve => setImmediate(resolve)); cancelled = true; if (phase === 'cancel' && revoke) allowed = false; return true },
    },
    attachments: { async stage() { throw new Error('不应保存附件') }, async reuse() { return null }, async release() {} },
    async prepareQq(_scope, parsed) { return parsed }, async callback() { return { consumed: true, accepted: false } },
  }
  const transport: ProviderTransport = { async request(request) {
    const path = new URL(request.url).pathname
    if (path.includes('/tenant_access_token/') || path.endsWith('/getAppAccessToken')) {
      authCalls++
      if (cancelled && phase === 'refresh' && revoke) allowed = false
      return response(platform === 'feishu' ? { code: 0, tenant_access_token: 'synthetic-tenant', expire: 1 }
        : { access_token: 'synthetic-qq-access', expires_in: 1 })
    }
    if (path.endsWith('/bot/v3/info')) return response({ code: 0, data: { bot: { open_id: 'ou_bot' } } })
    if (path.endsWith('/callback/ws/endpoint')) return response({ code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/ws/v2?ticket=synthetic', ClientConfig: {} } })
    if (path.endsWith('/gateway')) return response({ url: 'wss://api.sgroup.qq.com/websocket' })
    if (path.endsWith('/messages')) { sends++; return response(platform === 'feishu' ? { code: 0, data: { message_id: 'om_feedback' } } : { id: 'qq_feedback_out' }) }
    throw new Error('未预期的合成业务请求')
  }, async close() {} }
  const agent = new Agent()
  let dispatcher!: EventDispatcher
  const socket: QqSocket = { async send() {}, async close() {}, packets: (async function* () {
    yield { op: 10, d: { heartbeat_interval: 60000 } }
    yield { op: 0, t: 'READY', s: 1, d: { session_id: 'synthetic-feedback-session' } }
    yield { op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, d: { id: 'qq_feedback_in', content: '取消', author: { user_openid: 'member-a' } } }
    try { await waiting(socketSignal) } catch { /* 合成WS取消后结束迭代。 */ }
  })() }
  const connections = createPlatformConnections({ secretKey: 'synthetic-feedback-secret', sanitizeText: text => text,
    services: () => services, redis: { async sendCommand() { return 1 } }, transport: () => transport,
    now: () => 1800000000000, resolve: async () => [{ address: '9.9.9.9', family: 4 }],
    qqSocket: async (_url, signal) => { socketSignal = signal; return socket },
    clock: { now: () => 0, sleep: async (_ms, signal) => waiting(signal) },
    feishuNetwork: () => ({ agent, async validateEndpoint() {}, async close() { agent.destroy() } }),
    createFeishuSdk: config => ({ async start(input) {
      dispatcher = input.eventDispatcher
      await config.httpInstance!.request({ method: 'post', url: 'https://open.feishu.cn/callback/ws/endpoint', data: { AppID: bot.credentials.appId, AppSecret: bot.credentials.appSecret } })
      config.onReady!()
    }, close() {} }),
  })
  const connection = await connections.connect(bot, new AbortController().signal)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    if (platform === 'feishu') {
      const invocation = dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', app_id: bot.credentials.appId,
        create_time: '1800000000000', event_id: 'feishu_feedback_event' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_member' } },
        message: { message_id: 'om_feedback_in', chat_id: 'oc_feedback', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '取消' }), mentions: [] } } }, { needCheck: false })
      if (revoke) await assert.rejects(invocation, /飞书连接失败/)
      else await invocation
    }
    await Promise.race([completed, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('合成控制未完成')), 5000); timeout.unref() })])
    assert.equal(cancelled, true)
    assert.equal(sends, revoke ? 0 : 1)
    assert.ok(checks >= 2)
    if (phase === 'refresh') assert.ok(authCalls >= (platform === 'qq' ? 3 : 2), '必须经历真实控制回复Token刷新')
  } finally { if (timeout) clearTimeout(timeout); await connection.stop(); agent.destroy() }
}

test('QQ/飞书真实入站控制取消后撤权零业务HTTP，当前授权有效仍可回复', async () => {
  for (const platform of ['qq', 'feishu'] as const) for (const revoke of [false, true]) await pushFeedback(platform, 'cancel', revoke)
})

test('QQ/飞书真实Token刷新后撤权，控制回复不发业务HTTP且不回退重发', async () => {
  for (const platform of ['qq', 'feishu'] as const) for (const revoke of [false, true]) await pushFeedback(platform, 'refresh', revoke)
})
