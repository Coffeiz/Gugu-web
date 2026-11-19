import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'
import { createTelegramBotApi } from '../../../src/modules/im/gateway/telegram-api.js'
import { createTelegramMediaIngress, TELEGRAM_INGRESS_MAX_BYTES, TelegramMediaIngressError } from '../../../src/modules/im/gateway/telegram-media.js'
import type { TelegramMediaStageInput, TelegramMediaStorage } from '../../../src/modules/im/gateway/telegram-media.js'

const ownerId = 'owner-synthetic', botId = '41', token = '123456:synthetic_Telegram_Token_0000'
const base = { ownerId, botId, platformMessageId: '41:-1007002:55', attachments: [{ file_id: 'synthetic-file', file_size: 4, file_name: 'sample.txt', mime_type: 'text/plain', media_type: 'document' }], quotedAttachments: [] }
function fixture() {
  const requests: ProviderHttpRequest[] = [], staged: TelegramMediaStageInput[] = [], released: unknown[] = [], reuses: unknown[] = []
  let remoteSize: unknown = 4, returnOwner = ownerId, allowed = true, failStage = false
  let data: Buffer = Buffer.from('data')
  const transport: ProviderTransport = { async request(input) {
    requests.push(input)
    return { status: 200, headers: {}, body: (async function* () {
      yield input.method === 'POST' ? Buffer.from(JSON.stringify({ ok: true, result: { file_path: 'documents/sample.txt', file_size: remoteSize } })) : data
    })(), cancel() {} }
  } }
  const api = createTelegramBotApi({ transport })
  const storage: TelegramMediaStorage = {
    async reuse(input) { reuses.push(input); return { ownerId: returnOwner, attachId: 'existing-synthetic' } },
    async stage(input) { staged.push(input); if (failStage) throw new Error('synthetic-private-storage-error'); return { ownerId: returnOwner, attachId: `created-${staged.length}`, created: true, creationReceipt: `creation-${staged.length}` } },
    async release(input) { released.push(input) },
  }
  const ingress = createTelegramMediaIngress({ api, resolveToken: async input => { assert.equal(input.ownerId, ownerId); assert.equal(input.botId, botId); return allowed ? token : null }, storage })
  return { ingress, requests, staged, released, reuses, storage, api,
    setRemoteSize(value: unknown) { remoteSize = value }, setData(value: Buffer) { data = value }, setOwner(value: string) { returnOwner = value },
    setAllowed(value: boolean) { allowed = value }, failStage() { failStage = true } }
}

test('真实Telegram API适配器getFile与官方下载按顺序执行，暂存替身收到归属和来源', async () => {
  const f = fixture()
  const result = await f.ingress.ingest(base)
  assert.deepEqual(result, { attachmentIds: ['created-1'], sizeLimitExceeded: false, failureNotice: null })
  assert.equal(f.requests.length, 2)
  assert.deepEqual(JSON.parse(Buffer.from(f.requests[0]!.body as Uint8Array).toString()), { file_id: 'synthetic-file' })
  assert.equal(f.requests[0]!.url, `https://api.telegram.org/bot${token}/getFile`)
  assert.equal(f.requests[1]!.url, `https://api.telegram.org/file/bot${token}/documents/sample.txt`)
  assert.deepEqual(f.staged[0], { ownerId, botId, name: 'sample', ext: 'txt', mime: 'text/plain', data: Buffer.from('data'), kind: 'file', duration: null, platform: 'telegram', platformMessageId: base.platformMessageId, attachmentIndex: 0 })
  assert.deepEqual(f.released, [])
})
test('取消清理新建的引用draft收据，保留既有引用附件', async () => {
  const f = fixture(), controller = new AbortController()
  f.storage.reuse = async () => { controller.abort(); return { ownerId, attachId: 'new-quoted-draft', created: true, creationReceipt: 'quoted-creation' } }
  await assert.rejects(f.ingress.ingest({ ...base, quotedAttachments: [{ source_platform_message_id: 'quoted-source', source_attachment_index: 0 }] }, controller.signal), TelegramMediaIngressError)
  assert.deepEqual(f.released, [{ ownerId, attachId: 'new-quoted-draft', creationReceipt: 'quoted-creation' }])
})

test('实际单文件边界为decimal 20MB，声明超限在任何下载之前拒绝', async () => {
  assert.equal(TELEGRAM_INGRESS_MAX_BYTES, 20_000_000)
  const f = fixture()
  const result = await f.ingress.ingest({ ...base, attachments: [{ ...base.attachments[0], file_size: 20_000_001 }] })
  assert.equal(result.sizeLimitExceeded, true)
  assert.ok(result.failureNotice?.includes('20 MB'))
  assert.equal(f.requests.length, 0)
  f.setRemoteSize(20_000_001)
  assert.equal((await f.ingress.ingest(base)).sizeLimitExceeded, true)
  assert.equal(f.requests.length, 1)
  assert.equal(f.staged.length, 0)
})

test('真实API下载显式20MB上限而非底层20MiB，响应体超限不暂存', async () => {
  const f = fixture(); f.setRemoteSize(undefined); f.setData(Buffer.alloc(20_000_001))
  const result = await f.ingress.ingest(base)
  assert.deepEqual(result.attachmentIds, [])
  assert.ok(result.failureNotice)
  assert.equal(f.staged.length, 0)
})

test('全批20MB按实际下载计数，第二个越界附件不stage且保留第一个成功项', async () => {
  const f = fixture(); f.setRemoteSize(12_000_000); f.setData(Buffer.alloc(12_000_000))
  const result = await f.ingress.ingest({ ...base, attachments: [base.attachments[0], { ...base.attachments[0], file_id: 'second' }] })
  assert.deepEqual(result.attachmentIds, ['created-1'])
  assert.equal(result.sizeLimitExceeded, true)
  assert.equal(f.staged.length, 1)
  assert.equal(f.requests.length, 4)
  assert.deepEqual(f.released, [])
})

test('引用只复用当前owner Bot的源消息附件，不下载历史且不改变主消息正文', async () => {
  const f = fixture()
  const quoted = { source_platform_message_id: '41:-1007002:54', source_attachment_index: 2, file_id: 'ignored-quote-file' }
  const input = { ...base, text: '保留用户正文', attachments: [], quotedAttachments: [quoted] }
  assert.deepEqual(await f.ingress.ingest(input), { attachmentIds: ['existing-synthetic'], sizeLimitExceeded: false, failureNotice: null })
  assert.deepEqual(f.reuses, [{ ownerId, botId, platform: 'telegram', platformMessageId: quoted.source_platform_message_id, attachmentIndex: 2, quoted: true }])
  assert.equal(input.text, '保留用户正文')
  assert.equal(f.requests.length, 0)
})

test('源附件索引和安全文件名MIME按实际媒体类型传给stage', async () => {
  const f = fixture()
  await f.ingress.ingest({ ...base, attachments: [{ ...base.attachments[0], file_name: '../目录/合成\n图片.JPG', media_type: 'photo', mime_type: 'text/html', source_attachment_index: 3 }] })
  assert.equal(f.staged[0]!.name, '合成图片')
  assert.equal(f.staged[0]!.ext, 'jpg')
  assert.equal(f.staged[0]!.mime, 'image/jpeg')
  assert.equal(f.staged[0]!.kind, 'image')
  assert.equal(f.staged[0]!.attachmentIndex, 3)
  await f.ingress.ingest({ ...base, attachments: [{ ...base.attachments[0], file_name: 'voice', media_type: 'voice', mime_type: 'not a mime', duration: 3.5 }] })
  assert.equal(f.staged[1]!.ext, 'ogg')
  assert.equal(f.staged[1]!.mime, 'audio/ogg')
  assert.equal(f.staged[1]!.kind, 'voice')
  assert.equal(f.staged[1]!.duration, 3.5)
})

test('跨owner的暂存/引用结果拒绝，未授权Bot不下载，不释放其他用户附件', async () => {
  const f = fixture(); f.setOwner('other-owner')
  await assert.rejects(f.ingress.ingest(base), error => error instanceof TelegramMediaIngressError && error.code === 'storage_contract')
  assert.deepEqual(f.released, [])
  await assert.rejects(f.ingress.ingest({ ...base, attachments: [], quotedAttachments: [{ source_platform_message_id: '41:chat:54' }] }), TelegramMediaIngressError)
  const g = fixture(); g.setAllowed(false)
  const result = await g.ingress.ingest(base)
  assert.ok(result.failureNotice)
  assert.equal(g.requests.length, 0)
})

test('保存与下载失败文案不同且均不包含原始错误或token', async () => {
  const f = fixture(); f.failStage()
  const staged = await f.ingress.ingest(base)
  assert.equal(staged.failureNotice, '有附件已从 Telegram 下载，但保存失败，请稍后重试或重新发送。')
  assert.equal(JSON.stringify(staged).includes('private'), false)
  const g = fixture(); g.setRemoteSize(3)
  const failed = await g.ingress.ingest(base)
  assert.equal(failed.failureNotice, '有附件暂时无法从 Telegram 下载，请稍后重试或重新发送。')
  assert.equal(g.staged.length, 0)
})

test('取消只清理本轮创建收据，不清理引用附件或历史复用项', async () => {
  const f = fixture(), controller = new AbortController()
  const stage = f.storage.stage
  f.storage.stage = async (input, signal) => { const result = await stage(input, signal); controller.abort(); return result }
  await assert.rejects(f.ingress.ingest({ ...base, quotedAttachments: [{ source_platform_message_id: '41:chat:54' }] }, controller.signal), error => error instanceof TelegramMediaIngressError && error.code === 'cancelled')
  assert.deepEqual(f.released, [{ ownerId, attachId: 'created-1', creationReceipt: 'creation-1' }])
  const g = fixture(), second = new AbortController()
  g.storage.stage = async () => { second.abort(); return { ownerId, attachId: 'existing-main', created: false } }
  await assert.rejects(g.ingress.ingest(base, second.signal), TelegramMediaIngressError)
  assert.deepEqual(g.released, [])
})

test('清理失败明确报未完成，不忽略资源异常；关闭后不继续下载', async () => {
  const f = fixture(), controller = new AbortController()
  f.storage.stage = async () => { controller.abort(); return { ownerId, attachId: 'created', created: true, creationReceipt: 'receipt' } }
  f.storage.release = async () => { throw new Error('synthetic-private-cleanup') }
  await assert.rejects(f.ingress.ingest(base, controller.signal), error => error instanceof TelegramMediaIngressError && error.code === 'cleanup_failed' && !error.message.includes('private'))
  const g = fixture(); await g.ingress.close()
  await assert.rejects(g.ingress.ingest(base), TelegramMediaIngressError)
  assert.equal(g.requests.length, 0)
})
