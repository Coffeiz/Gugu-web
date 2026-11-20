import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderError } from '@gugu/core/providers'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'
import { createILinkClient, ILinkApiError } from '@gugu/gateway/wechat'
import { decryptAesEcb } from '@gugu/gateway/wechat'
import { createWechatMedia, WechatMediaError } from '../../../src/modules/im/gateway/platforms/wechat/media.js'
import { createWechatSender } from '../../../src/modules/im/gateway/platforms/wechat/sender.js'

const target = { userId: 'sender-synthetic', contextToken: 'synthetic-context' }
function realAdapters() {
  const requests: ProviderHttpRequest[] = []
  let ret = 0, sendFailure: unknown, failures = 0
  const transport: ProviderTransport = {
    async request(input) {
      requests.push(input)
      if (input.url.includes('/sendmessage') && failures > 0) { failures--; throw sendFailure }
      const value = input.url.includes('/getuploadurl') ? { ret: 0, upload_param: 'synthetic-upload' } : { ret }
      const headers: Record<string, string> = input.url.includes('/c2c/upload') ? { 'x-encrypted-param': 'synthetic-download' } : {}
      return { status: 200, headers,
        body: (async function* () { yield Buffer.from(JSON.stringify(value)) })(), cancel() {} }
    },
    async close() {},
  }
  const client = createILinkClient({ botToken: 'synthetic-token', transport })
  const media = createWechatMedia({ client, transport })
  const sender = createWechatSender({ client, media, generateId: () => 'synthetic-client-id' })
  return { sender, requests, setRet(value: number) { ret = value }, failSend(error: unknown, count = 1) { sendFailure = error; failures = count } }
}

test('真实client与媒体adapter执行图片上传和sendmessage，保持上下文和协议密文', async () => {
  const f = realAdapters(), bytes = Buffer.from('synthetic-image-data')
  assert.deepEqual(await f.sender.image(target, bytes), { outcome: 'accepted' })
  assert.equal(f.requests.length, 3)
  const upload = JSON.parse(Buffer.from(f.requests[0]!.body as Uint8Array).toString())
  assert.deepEqual(decryptAesEcb(f.requests[1]!.body as Uint8Array, Buffer.from(upload.aeskey, 'hex')), bytes)
  const body = JSON.parse(Buffer.from(f.requests[2]!.body as Uint8Array).toString())
  assert.deepEqual(body.msg, { from_user_id: '', to_user_id: target.userId, client_id: 'synthetic-client-id', message_type: 2, message_state: 2, context_token: target.contextToken,
    item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'synthetic-download', aes_key: Buffer.from(upload.aeskey).toString('base64'), encrypt_type: 1 }, mid_size: 32 } }] })
})

test('真实文本与文件保持context_token，文件len使用明文长度字符串', async () => {
  const f = realAdapters()
  assert.deepEqual(await f.sender.text(target, '合成正文'), { outcome: 'accepted' })
  assert.deepEqual(await f.sender.file(target, Buffer.from('abc'), '合成文件.txt'), { outcome: 'accepted' })
  const sends = f.requests.filter(request => request.url.includes('/sendmessage')).map(request => JSON.parse(Buffer.from(request.body as Uint8Array).toString()).msg)
  assert.deepEqual(sends[0].item_list, [{ type: 1, text_item: { text: '合成正文' } }])
  assert.equal(sends[1].context_token, target.contextToken)
  assert.equal(sends[1].item_list[0].file_item.len, '3')
  assert.equal(sends[1].item_list[0].file_item.file_name, '合成文件.txt')
})

test('空上下文在上传或客户端调用之前拒绝，取消排队消息同样不下载', async () => {
  const f = realAdapters(), invalid = { ...target, contextToken: '' }
  assert.deepEqual(await f.sender.text(invalid, '正文'), { outcome: 'rejected' })
  assert.deepEqual(await f.sender.image(invalid, Buffer.alloc(1)), { outcome: 'rejected' })
  assert.deepEqual(await f.sender.file(invalid, Buffer.alloc(1), '合成.txt'), { outcome: 'rejected' })
  const controller = new AbortController(); controller.abort()
  assert.deepEqual(await f.sender.image(target, Buffer.alloc(1), controller.signal), { outcome: 'rejected' })
  assert.equal(f.requests.length, 0)
})

test('同一目标文本与媒体串行，不同用户可独立发送，绑定与字节入队后不能被改写', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const observed: Record<string, unknown>[] = [], order: string[] = []
  const sender = createWechatSender({ generateId: () => 'synthetic-client-id',
    client: { async sendMessage(message) { observed.push(message); order.push(String(message.to_user_id)); return { ret: 0 } } },
    media: { async prepareItem(input) { if (input.toUserId === target.userId) await gate; order.push(Buffer.from(input.data).toString()); return { type: 2 } } },
  })
  const mutableTarget = { ...target }, bytes = Buffer.from('before')
  const image = sender.image(mutableTarget, bytes)
  const text = sender.text(mutableTarget, '后续文本')
  const controller = new AbortController()
  const cancelled = sender.text(mutableTarget, '已取消排队文本', controller.signal)
  controller.abort()
  mutableTarget.userId = 'untrusted-change'; mutableTarget.contextToken = 'untrusted-change'; bytes.fill(0)
  await sender.text({ userId: 'other-synthetic', contextToken: 'other-context' }, '独立文本')
  assert.deepEqual(order, ['other-synthetic'])
  release(); await Promise.all([image, text]); await sender.idle()
  assert.deepEqual(await cancelled, { outcome: 'rejected' })
  assert.deepEqual(order, ['other-synthetic', 'before', target.userId, target.userId])
  assert.equal(observed[1]!.context_token, target.contextToken)
  assert.equal(observed[2]!.context_token, target.contextToken)
})

test('ret非零返回拒绝而不是假成功，失败后队列继续且不公开响应内容', async () => {
  const f = realAdapters(); f.setRet(-14)
  assert.deepEqual(await f.sender.text(target, '正文'), { outcome: 'rejected' })
  f.setRet(0)
  assert.deepEqual(await f.sender.text(target, '后续'), { outcome: 'accepted' })
  let attempts = 0
  const sender = createWechatSender({ client: { async sendMessage() { attempts++; return { ret: 1, private: 'synthetic-private-content' } } }, media: { async prepareItem() { return {} } } })
  assert.deepEqual(await sender.text(target, '正文'), { outcome: 'rejected' })
  assert.equal(attempts, 1)
})

test('媒体上传后发送网络结果未知不重传不重发整个流程', async () => {
  const f = realAdapters(); f.failSend(new Error('synthetic-private-upstream-response'))
  const result = await f.sender.image(target, Buffer.from('abc'))
  assert.deepEqual(result, { outcome: 'unknown' })
  assert.equal(f.requests.filter(request => request.url.includes('/getuploadurl')).length, 1)
  assert.equal(f.requests.filter(request => request.url.includes('/c2c/upload')).length, 1)
  assert.equal(f.requests.filter(request => request.url.includes('/sendmessage')).length, 1)
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('SDK内部确定未发送连接错误可重试，sendmessage原文和client_id保持不变', async () => {
  const f = realAdapters(); f.failSend(new ProviderError('network', { retryable: true, requestStarted: false }))
  assert.deepEqual(await f.sender.text(target, '合成正文'), { outcome: 'accepted' })
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.requests[0]!.body, f.requests[1]!.body)
})

test('已分类媒体和API错误沿用安全结果，未知异常只返回unknown', async () => {
  for (const error of [new WechatMediaError('upload', 'rejected'), new ILinkApiError('sendmessage', 'unknown'), new Error('synthetic-private')]) {
    const sender = createWechatSender({ client: { async sendMessage() { throw error } }, media: { async prepareItem() { throw error } } })
    assert.deepEqual(await sender.image(target, Buffer.alloc(1)), { outcome: error instanceof WechatMediaError ? 'rejected' : 'unknown' })
  }
})
