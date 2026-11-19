import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderError } from '@gugu/core/providers'
import type { ProviderHttpRequest, ProviderHttpResponse, ProviderTransport } from '@gugu/core/providers'
import { NodeProviderTransport } from '@gugu/core/providers/node'
import { createILinkClient, ILinkApiError, validateILinkBaseUrl } from '../../../src/modules/im/gateway/wechat/client.js'

const token = 'synthetic-wechat-token', contextToken = 'synthetic-context-token'
function fixture() {
  const requests: ProviderHttpRequest[] = []
  let cancellations = 0, closures = 0
  let handler: (request: ProviderHttpRequest, signal: AbortSignal) => Promise<ProviderHttpResponse> = async () => ({ status: 200, headers: {}, body: (async function* () { yield Buffer.from('{"ret":0}') })(), cancel: () => { cancellations++ } })
  const transport: ProviderTransport = { request: async (request, signal) => { requests.push(request); return handler(request, signal) }, close: async () => { closures++ } }
  const client = createILinkClient({ botToken: token, transport, randomUin: () => 123, generateId: () => 'synthetic-client-id' })
  const body = (index = requests.length - 1) => JSON.parse(Buffer.from(requests[index]!.body as Uint8Array).toString())
  return { client, requests, body, cancellations: () => cancellations, closures: () => closures, setHandler: (value: typeof handler) => { handler = value } }
}

test('微信轮询及文字消息携带原始上下文凭证、协议版本和独立UIN头', async () => {
  const f = fixture()
  await f.client.getUpdates('cursor-1')
  assert.equal(f.requests[0]!.url, 'https://ilinkai.weixin.qq.com/ilink/bot/getupdates')
  assert.equal(f.requests[0]!.timeoutMs, 45_000)
  assert.deepEqual(f.requests[0]!.headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': 'MTIz', Authorization: `Bearer ${token}` })
  assert.deepEqual(f.body(), { get_updates_buf: 'cursor-1', base_info: { channel_version: '2.0.1' } })
  await f.client.sendText('wx-synthetic', '合成回复', contextToken)
  assert.deepEqual(f.body(), { msg: { from_user_id: '', to_user_id: 'wx-synthetic', client_id: 'synthetic-client-id', message_type: 2, message_state: 2,
    context_token: contextToken, item_list: [{ type: 1, text_item: { text: '合成回复' } }] }, base_info: { channel_version: '2.0.1' } })
  assert.equal(f.requests[1]!.timeoutMs, 15_000)
  assert.equal(f.cancellations(), 2)
  await f.client.close(); await f.client.close(); assert.equal(f.closures(), 1)
})

test('微信媒体上传、config、typing和通道通知保持现有协议，不新增扫码入口', async () => {
  const f = fixture(), base_info = { channel_version: '2.0.1' }
  const upload = { filekey: 'synthetic-filekey', aeskey: 'synthetic-aeshex', media_type: 1, rawsize: 3, filesize: 16, to_user_id: 'wx-synthetic', rawfilemd5: 'synthetic-md5', no_need_thumb: true }
  await f.client.getUploadUrl(upload); assert.deepEqual(f.body(), { ...upload, base_info })
  await f.client.getConfig('wx-synthetic', contextToken); assert.deepEqual(f.body(), { ilink_user_id: 'wx-synthetic', context_token: contextToken, base_info })
  await f.client.sendTyping('wx-synthetic', 'synthetic-ticket', 1); assert.deepEqual(f.body(), { ilink_user_id: 'wx-synthetic', typing_ticket: 'synthetic-ticket', status: 1, base_info })
  const count = f.requests.length
  assert.deepEqual(await f.client.sendTyping('wx-synthetic', '', 2), { ret: 0, errmsg: 'no typing_ticket, skipped' }); assert.equal(f.requests.length, count)
  await f.client.notifyStart(); assert.equal(f.requests.at(-1)!.url.endsWith('/msg/notifystart'), true)
  await f.client.notifyStop(); assert.equal(f.requests.at(-1)!.url.endsWith('/msg/notifystop'), true)
})

test('微信baseURL拒绝非官方主机、非HTTPS、路径、凭据和query，缺context在发送前拒绝', async () => {
  assert.equal(validateILinkBaseUrl('https://ilinkai.weixin.qq.com/'), 'https://ilinkai.weixin.qq.com')
  assert.equal(validateILinkBaseUrl('https://regional.weixin.qq.com:443'), 'https://regional.weixin.qq.com')
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.invalid', 'https://evil.invalid', 'https://127.0.0.1', 'https://ilinkai.weixin.qq.com:8443', 'https://user:secret@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com?token=secret', 'https://ilinkai.weixin.qq.com/#secret']) {
    assert.throws(() => validateILinkBaseUrl(url), ILinkApiError)
  }
  assert.throws(() => createILinkClient({ botToken: 'bad\r\nheader' }), ILinkApiError)
  const f = fixture()
  await assert.rejects(f.client.sendText('wx-synthetic', '合成回复', ''), error => error instanceof ILinkApiError && error.outcome === 'rejected')
  assert.equal(f.requests.length, 0)
})

test('微信发送仅对明确未发出的连接错误重试，保留同一client_id与正文', async () => {
  const f = fixture()
  let attempts = 0
  f.setHandler(async () => {
    if (++attempts === 1) throw new ProviderError('network', { retryable: true, requestStarted: false })
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from('{"ret":0}') })(), cancel: async () => {} }
  })
  await f.client.sendText('wx-synthetic', '合成回复', contextToken)
  assert.equal(attempts, 2)
  assert.deepEqual(f.body(0), f.body(1))
  assert.equal(f.body(0).msg.client_id, 'synthetic-client-id')
})

test('微信官方域名解析至内网时由实际Node传输拒绝，不打开平台连接', async () => {
  let resolutions = 0
  const transport = new NodeProviderTransport({ trustEnvironment: false, resolve: async () => {
    resolutions++
    return [{ address: '127.0.0.1', family: 4 }]
  } })
  const client = createILinkClient({ botToken: token, transport })
  try {
    await assert.rejects(client.getUpdates(), error => error instanceof ILinkApiError && error.cause === undefined)
    assert.equal(resolutions, 1)
  } finally { await client.close() }
})

test('微信读超时、请求状态未知和连接拒绝未标记可重试时绝不重复发送', async () => {
  for (const error of [new ProviderError('timeout', { retryable: true, requestStarted: true, timeoutPhase: 'read' }), new Error(`${token}:${contextToken}`), new ProviderError('network', { requestStarted: false, retryable: false })]) {
    const f = fixture(); f.setHandler(async () => { throw error })
    await assert.rejects(f.client.sendText('wx-synthetic', '合成回复', contextToken), error => {
      assert.ok(error instanceof ILinkApiError); assert.equal(error.outcome, 'unknown'); assert.equal(error.cause, undefined)
      assert.equal(error.message.includes(token), false); assert.equal(JSON.stringify(error).includes(contextToken), false); return true
    })
    assert.equal(f.requests.length, 1)
  }
})

test('微信3xx、HTTP错误、业务ret错误和非法响应均安全失败且清理响应', async () => {
  for (const [status, raw, expected] of [[302, token, 'rejected'], [403, token, 'rejected'], [503, token, 'unknown'], [200, '{"ret":42,"errmsg":"synthetic-context-token"}', 'rejected'], [200, '[]', 'unknown'], [200, token, 'unknown']] as const) {
    const f = fixture(); let cancelled = 0
    f.setHandler(async () => ({ status, headers: { location: `https://evil.invalid/${token}` }, body: (async function* () { yield Buffer.from(raw) })(), cancel: () => { cancelled++ } }))
    await assert.rejects(f.client.sendText('wx-synthetic', '合成回复', contextToken), error => {
      assert.ok(error instanceof ILinkApiError); assert.equal(error.outcome, expected); assert.equal(error.cause, undefined)
      assert.equal(JSON.stringify(error).includes(token), false); assert.equal(error.stack!.includes(contextToken), false); return true
    })
    assert.equal(f.requests.length, 1); assert.equal(cancelled, 1)
  }
})

test('微信响应声明和实际大小均受限，取消、关闭终止读取并禁止后续请求', async () => {
  for (const declared of [true, false]) {
    const f = fixture()
    const headers: Record<string, string> = declared ? { 'Content-Length': String(4 * 1024 * 1024 + 1) } : {}
    f.setHandler(async () => ({ status: 200, headers, body: (async function* () { yield Buffer.alloc(4 * 1024 * 1024 + 1) })(), cancel: async () => {} }))
    await assert.rejects(f.client.getUpdates(), ILinkApiError)
  }
  for (const close of [true, false]) {
    const f = fixture(), controller = new AbortController()
    f.setHandler(async (_request, signal) => ({ status: 200, headers: {}, body: (async function* () {
      await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error(contextToken)), { once: true }); queueMicrotask(() => { if (close) void f.client.close(); else controller.abort(contextToken) }) })
      yield Buffer.alloc(0)
    })(), cancel: async () => {} }))
    await assert.rejects(f.client.getUpdates('', controller.signal), error => error instanceof ILinkApiError && !error.message.includes(contextToken))
    if (close) { await assert.rejects(f.client.getUpdates(), ILinkApiError); assert.equal(f.requests.length, 1) }
  }
})
