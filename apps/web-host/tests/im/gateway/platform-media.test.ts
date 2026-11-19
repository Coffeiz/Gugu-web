import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseQqMessage } from '@gugu/core/im/qq-message'
import { createPlatformMedia, type PlatformAttachmentStore } from '../../../src/modules/im/gateway/media/platform.js'
import type { ProviderTransport } from '@gugu/core/providers'
import { createTelegramBotApi } from '@gugu/gateway/telegram'
import { normalizeTelegramMessage } from '@gugu/core/im/telegram-message'

const scope = { ownerId: '11111111-1111-4111-8111-111111111111', botId: '4', platform: 'qq' as const, chatType: 'c2c' as const, chatId: null, platformUserId: 'member-a' }
const signal = new AbortController().signal
const response = (status: number, headers: Record<string, string> = {}, bytes: Uint8Array = Buffer.from('data')) => ({ status, headers, body: (async function* () { yield bytes })(), cancel() {} })
function storage() {
  const staged: unknown[] = [], released: unknown[] = []
  const value: PlatformAttachmentStore = {
    stage: async (input, signal) => { assert.equal(signal?.aborted, false); staged.push(input); return { ownerId: scope.ownerId, attachId: `attachment-${staged.length}`, created: true, creationReceipt: `receipt-${staged.length}` } },
    reuse: async () => { throw new Error('测试不应复用引用') }, release: async input => { released.push(input) },
  }
  return { value, staged, released }
}
test('QQ每次重定向均经正式公网校验，拒绝私网前不发第二次HTTP且不暂存', async () => {
  const store = storage(), requests: string[] = []
  const transport: ProviderTransport = { request: async input => { requests.push(input.url); return response(302, { location: 'http://127.0.0.1/private' }) }, async close() {} }
  const media = createPlatformMedia({ storage: store.value, transport, resolve: async () => [{ address: '9.9.9.9', family: 4 }] })
  const parsed = parseQqMessage('C2C_MESSAGE_CREATE', { id: 'qq-a', content: '附件', author: { user_openid: 'member-a' }, attachments: [{ url: 'https://cdn.example.test/file', filename: '合成.txt' }] }, { botId: '4', ownerId: scope.ownerId })!
  await assert.rejects(media.qq(scope, parsed, signal), error => error instanceof Error && error.message === 'IM 媒体接入未完成' && !error.cause)
  assert.deepEqual(requests, ['https://cdn.example.test/file']); assert.equal(store.staged.length, 0)
  await media.close()
})
test('批次暂存失败仅释放本批创建收据，不清理复用或其他owner附件', async () => {
  const store = storage(); let attempts = 0
  const original = store.value.stage
  store.value.stage = async (input, signal) => { if (++attempts === 2) throw new Error('synthetic-sensitive-path'); return original(input, signal) }
  const media = createPlatformMedia({ storage: store.value, transport: { request: async () => response(200), async close() {} }, resolve: async () => [{ address: '9.9.9.9', family: 4 }] })
  const parsed = parseQqMessage('C2C_MESSAGE_CREATE', { id: 'qq-a', content: '附件', author: { user_openid: 'member-a' }, attachments: [
    { url: 'https://cdn.example.test/one', filename: '一.txt' }, { url: 'https://cdn.example.test/two', filename: '二.txt' },
  ] }, { botId: '4', ownerId: scope.ownerId })!
  await assert.rejects(media.qq(scope, parsed, signal), /IM 媒体接入未完成/)
  assert.deepEqual(store.released, [{ scope, attachId: 'attachment-1', creationReceipt: 'receipt-1' }])
  await media.close()
})
test('Telegram引用仅查同scope历史，目标平台消息绑定新draft引用，不重下远程原附件', async () => {
  const store = storage(), refs: unknown[] = [], notices: string[] = []
  store.value.reuse = async input => { refs.push(input); return { ownerId: scope.ownerId, attachId: 'quoted-draft', created: true, creationReceipt: 'quote-receipt' } }
  const media = createPlatformMedia({ storage: store.value }), privateScope = { ...scope, platform: 'telegram' as const }
  const parsed = normalizeTelegramMessage({ update_id: 99, message: { message_id: 31, date: 100, chat: { id: 9, type: 'private' }, from: { id: 9 }, text: '引用这张图',
    reply_to_message: { message_id: 30, chat: { id: 9, type: 'private' }, from: { id: 9 }, photo: [{ file_id: 'never-download-this-file', width: 1, height: 1 }] } } }, { botId: '4', ownerId: scope.ownerId, botUsername: 'gugu', botPlatformId: '99' })!
  const api = createTelegramBotApi({ transport: { request: async () => { throw new Error('引用不得调用网络') }, async close() {} } })
  const payload = await media.telegram(privateScope, parsed, api, async () => { throw new Error('纯引用不取token') }, signal, async text => { notices.push(text) })
  assert.deepEqual(payload?.attachments, ['quoted-draft']); assert.deepEqual(payload?.quoted_attachments, [])
  assert.equal(refs.length, 1); assert.equal((refs[0] as { targetPlatformMessageId: string }).targetPlatformMessageId, '4:9:31')
  assert.equal(store.staged.length, 0); assert.deepEqual(notices, [])
  await media.close(); await api.close()
})
