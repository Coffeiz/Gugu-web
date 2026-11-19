import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { ProviderError } from '@gugu/core/providers'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'
import { createILinkClient } from '../../../src/modules/im/gateway/platforms/wechat/client.js'
import { decryptAesEcb, encryptAesEcb } from '../../../src/modules/im/gateway/platforms/wechat/media-crypto.js'
import { createWechatMedia, validateWechatCdnUrl, WechatMediaError } from '../../../src/modules/im/gateway/platforms/wechat/media.js'

const origin = 'https://novac2c.cdn.weixin.qq.com'
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
function fixture(options: { maxBytes?: number } = {}) {
  const requests: ProviderHttpRequest[] = []
  const uploads: Record<string, unknown>[] = []
  let cancelled = 0, closed = 0, status = 200
  let downloadBody = encryptAesEcb(png, key)
  let downloadHeaders: Record<string, string> = {}
  let uploadResponse: Record<string, unknown> = { ret: 0, upload_param: 'synthetic-signed-upload' }
  let cdnHeader: Record<string, string> = { 'X-Encrypted-Param': 'synthetic-download-param' }
  let failure: unknown
  let failuresRemaining = 0
  const transport: ProviderTransport = {
    async request(input) {
      requests.push(input)
      if (input.url.includes('/ilink/bot/getuploadurl')) {
        uploads.push(JSON.parse(Buffer.from(input.body as Uint8Array).toString()))
        return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(uploadResponse)) })(), cancel() { cancelled++ } }
      }
      if (failuresRemaining > 0) { failuresRemaining--; throw failure }
      return { status, headers: input.method === 'GET' ? downloadHeaders : cdnHeader,
        body: (async function* () { yield downloadBody })(), cancel() { cancelled++ } }
    },
    async close() { closed++ },
  }
  const client = createILinkClient({ botToken: 'synthetic-bot-token', transport })
  const media = createWechatMedia({ client, transport, ...options })
  return { media, requests, uploads, transport, get cancelled() { return cancelled }, get closed() { return closed },
    setStatus(value: number) { status = value }, setDownload(value: Buffer, headers: Record<string, string> = {}) { downloadBody = value; downloadHeaders = headers },
    setUpload(value: Record<string, unknown>) { uploadResponse = value }, setCdnHeader(value: Record<string, string>) { cdnHeader = value },
    fail(error: unknown, count: number) { failure = error; failuresRemaining = count } }
}

test('入站图片实际下载并用既有AES解密，支持引用图片CDN参数且不伪造附件ID', async () => {
  const f = fixture()
  const result = await f.media.downloadImage({ type: 2, image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'abc/def+123=' } } })
  assert.deepEqual(result, { bytes: png, ext: 'png', mime: 'image/png' })
  assert.equal(f.requests[0]!.url, `${origin}/c2c/download?encrypted_query_param=abc%2Fdef%2B123%3D`)
  assert.deepEqual(f.requests[0]!.headers, {})
  assert.equal(f.requests[0]!.allowLocal, undefined)
  assert.equal(f.cancelled, 1)
  assert.equal('attach_id' in result!, false)
})

test('下载full_url优先且沿既有格式嗅探，缺材料或非图片不发网络请求', async () => {
  const f = fixture()
  for (const item of [{ type: 4, file_item: {} }, { image_item: {} }, { image_item: { aeskey: key.toString('hex') } }])
    assert.equal(await f.media.downloadImage(item), null)
  assert.equal(f.requests.length, 0)
  f.setDownload(encryptAesEcb(Buffer.from('GIF89a'), key))
  const result = await f.media.downloadImage({ image_item: { aeskey: key.toString('hex'), media: { full_url: `${origin}/c2c/download?encrypted_query_param=first`, encrypt_query_param: 'unused' } } })
  assert.equal(result!.mime, 'image/gif')
  assert.ok(f.requests[0]!.url.endsWith('=first'))
})

test('AES密钥和下载声明/实际大小边界在公开静态错误内失败', async () => {
  const f = fixture({ maxBytes: 8 })
  const item = { image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'synthetic' } } }
  await assert.rejects(f.media.downloadImage({ image_item: { ...item.image_item, aeskey: 'private-invalid-key' } }), WechatMediaError)
  assert.equal(f.requests.length, 0)
  f.setDownload(Buffer.alloc(32), { 'Content-Length': '32' })
  await assert.rejects(f.media.downloadImage(item), WechatMediaError)
  f.setDownload(Buffer.alloc(32))
  await assert.rejects(f.media.downloadImage(item), WechatMediaError)
  f.setDownload(Buffer.alloc(17))
  await assert.rejects(f.media.downloadImage(item), WechatMediaError)
})

test('CDN固定HTTPS目标和路径，禁止重定向、凭据query、userinfo与任意平台URL', async () => {
  for (const url of ['http://novac2c.cdn.weixin.qq.com/c2c/upload', `${origin}/other`, 'https://example.invalid/c2c/upload', 'https://novac2c.cdn.weixin.qq.com.evil.invalid/c2c/upload', `${origin}:9443/c2c/upload`, `${origin}/c2c/upload?token=synthetic`, 'https://synthetic@novac2c.cdn.weixin.qq.com/c2c/upload', `${origin}/c2c/upload#private`])
    assert.throws(() => validateWechatCdnUrl(url, 'upload'), WechatMediaError)
  const f = fixture(); f.setStatus(302)
  await assert.rejects(f.media.downloadImage({ image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'synthetic' } } }), WechatMediaError)
  assert.equal(f.requests.length, 1)
})

test('真实iLink客户端取上传URL，CDN只收密文，图片item遵循当前JSON协议', async () => {
  const f = fixture()
  const item = await f.media.prepareItem({ kind: 'image', data: png, toUserId: 'sender-synthetic' })
  assert.equal(f.uploads.length, 1)
  const body = f.uploads[0]!
  assert.equal(body.media_type, 1); assert.equal(body.to_user_id, 'sender-synthetic')
  assert.equal(body.rawsize, png.byteLength); assert.equal(body.filesize, 16); assert.equal(body.no_need_thumb, true)
  assert.equal(body.rawfilemd5, createHash('md5').update(png).digest('hex'))
  const cdn = f.requests[1]!
  assert.equal(cdn.method, 'POST')
  assert.deepEqual(cdn.headers, { 'Content-Type': 'application/octet-stream' })
  assert.equal(new URL(cdn.url).searchParams.get('filekey'), body.filekey)
  assert.deepEqual(decryptAesEcb(cdn.body as Uint8Array, Buffer.from(String(body.aeskey), 'hex')), png)
  assert.deepEqual(item, { type: 2, image_item: { media: { encrypt_query_param: 'synthetic-download-param', aes_key: Buffer.from(String(body.aeskey)).toString('base64'), encrypt_type: 1 }, mid_size: 16 } })
  assert.equal(f.requests.some(request => request.url.includes('sendmessage')), false)
})

test('文件上传类型与明文len字符串不混淆，文件名只存在待发送item', async () => {
  const f = fixture()
  const item = await f.media.prepareItem({ kind: 'file', data: Buffer.from('abc'), toUserId: 'sender-synthetic', fileName: '合成说明.txt' })
  assert.equal(f.uploads[0]!.media_type, 3)
  assert.equal(JSON.stringify(f.uploads).includes('合成说明.txt'), false)
  assert.deepEqual(item, { type: 4, file_item: { media: { encrypt_query_param: 'synthetic-download-param', aes_key: Buffer.from(String(f.uploads[0]!.aeskey)).toString('base64'), encrypt_type: 1 }, file_name: '合成说明.txt', len: '3' } })
})

test('明确发送前连接失败重试保持同filekey URL和密文，不重新获取上传URL', async () => {
  const f = fixture()
  f.fail(new ProviderError('network', { retryable: true, requestStarted: false }), 2)
  await f.media.prepareItem({ kind: 'image', data: png, toUserId: 'sender-synthetic' })
  assert.equal(f.uploads.length, 1)
  const cdn = f.requests.slice(1)
  assert.equal(cdn.length, 3)
  assert.equal(new Set(cdn.map(request => request.url)).size, 1)
  assert.deepEqual(cdn[0]!.body, cdn[1]!.body)
  assert.deepEqual(cdn[1]!.body, cdn[2]!.body)
})

test('明确CDN5xx有限重试，4xx和缺下载参数不重试，不重复sendmessage', async () => {
  for (const [status, expected] of [[503, 3], [403, 1], [429, 1]]) {
    const f = fixture(); f.setStatus(status!)
    await assert.rejects(f.media.prepareItem({ kind: 'image', data: png, toUserId: 'sender-synthetic' }), WechatMediaError)
    assert.equal(f.requests.length - 1, expected)
  }
  const f = fixture(); f.setCdnHeader({})
  await assert.rejects(f.media.prepareItem({ kind: 'image', data: png, toUserId: 'sender-synthetic' }), WechatMediaError)
  assert.equal(f.requests.length, 2)
})

test('网络结果未知不重试，平台错误与媒体秘密不进入异常', async () => {
  const f = fixture(); f.fail(new Error('synthetic-private-response-and-key'), 1)
  await assert.rejects(f.media.prepareItem({ kind: 'image', data: png, toUserId: 'sender-synthetic' }), error => error instanceof WechatMediaError && error.outcome === 'unknown' && !JSON.stringify(error).includes('private'))
  assert.equal(f.requests.length, 2)
  const g = fixture(); g.setUpload({ ret: 0, upload_full_url: 'https://example.invalid/private?token=synthetic-secret' })
  await assert.rejects(g.media.prepareItem({ kind: 'image', data: png, toUserId: 'sender-synthetic' }), error => error instanceof WechatMediaError && !error.message.includes('secret'))
  assert.equal(g.requests.length, 1)
})

test('取消和关闭清理响应及transport，不发起后续媒体请求', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort()
  await assert.rejects(f.media.prepareItem({ kind: 'image', data: png, toUserId: 'sender-synthetic' }, controller.signal), WechatMediaError)
  assert.equal(f.requests.length, 0)
  await f.media.close(); await f.media.close()
  assert.equal(f.closed, 1)
  await assert.rejects(f.media.downloadImage({ image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'synthetic' } } }), WechatMediaError)
})

test('真实Node公共连接校验拒绝官方域名解析到本地地址，不放宽allowLocal', async () => {
  const { NodeProviderTransport } = await import('@gugu/core/providers/node')
  const transport = new NodeProviderTransport({ trustEnvironment: false, resolve: async () => [{ address: '127.0.0.1', family: 4 }] })
  const media = createWechatMedia({ client: { getUploadUrl: async () => ({}) }, transport })
  try {
    await assert.rejects(media.downloadImage({ image_item: { aeskey: key.toString('hex'), media: { encrypt_query_param: 'synthetic' } } }), WechatMediaError)
  } finally { await media.close() }
})

test('上传资源和文件名限制在取URL之前拒绝，不隐式访问文件系统', async () => {
  const f = fixture({ maxBytes: 4 })
  await assert.rejects(f.media.prepareItem({ kind: 'file', data: Buffer.alloc(5), toUserId: 'sender-synthetic', fileName: '合成.txt' }), WechatMediaError)
  await assert.rejects(f.media.prepareItem({ kind: 'file', data: Buffer.alloc(1), toUserId: 'sender-synthetic', fileName: '合成\r\n.txt' }), WechatMediaError)
  assert.equal(f.requests.length, 0)
})
