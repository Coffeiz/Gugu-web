import { selectQqFaceAsset } from '@gugu/gateway/qq'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProviderTransport } from '@gugu/core/providers'
import { parseQqMessage } from '@gugu/gateway/qq'
import { createQqMessagePreparer } from '../../../../src/modules/im/gateway/platforms/qq/prepare.js'
import { qqRedisDouble } from '../helpers/qq-redis-double.js'
import type { ImAttachmentScope } from '../../../../src/modules/im/gateway/inbound/attachments.js'
import { createPlatformConnections, type GatewayConnectionServices } from '../../../../src/modules/im/gateway/connections.js'
import { createPlatformMedia } from '../../../../src/modules/im/gateway/media/platform.js'

const owner = '11111111-1111-4111-8111-111111111111', master = 'synthetic-reference-master'
const scope: ImAttachmentScope = { ownerId: owner, botId: '4', platform: 'qq', chatType: 'group', chatId: 'group-a', platformUserId: 'member-a' }
const signal = new AbortController().signal
function parsed(id: string, content: string, options: { sender?: string; group?: string; reference?: string; attachments?: unknown[]; private?: boolean } = {}) {
  return parseQqMessage(options.private ? 'C2C_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE', { id, content,
    author: { user_openid: options.sender || 'member-a', bot: false }, group_openid: options.group || 'group-a', attachments: options.attachments || [],
    message_scene: { ext: [{ key: 'msg_idx', value: `idx-${id}` }, ...(options.reference ? [{ key: 'ref_msg_idx', value: options.reference }] : [])] },
  }, { ownerId: owner, botId: '4' })!
}
const face = (id: string, type = '6') => `<faceType=${type},faceId="${id}",ext="">`
const response = (value: unknown, status = 200) => ({ status, headers: {}, body: (async function* () { yield Buffer.from(JSON.stringify(value)) })(), cancel() {} })
function fixture() {
  const db = qqRedisDouble(), requests: string[] = [], reports: string[] = []
  let index: unknown = [{ emojiId: 1, qzoneCode: 101, assets: [{ type: 0, path: 'assets/qq_emoji/one-small.png' }, { type: 2, path: 'assets/qq_emoji/one.png', name: '系统表情.png' }] }], status = 200
  const transport: ProviderTransport = { request: async input => { requests.push(input.url); return response(index, status) }, async close() {} }
  const prepare = createQqMessagePreparer({ redis: db.redis, secretKey: master, now: db.now, authorize: async () => true, transport, report: code => reports.push(code) })
  return { db, prepare, transport, requests, reports, fail: () => { status = 500 }, recover: () => { status = 200 }, setIndex: (value: unknown) => { index = value } }
}
test('同群引用他人恢复正文/附件和reply sender；重建prepare服务仍读同scope加密索引', async () => {
  const f = fixture()
  await f.prepare.prepare(scope, parsed('one', '合成原消息', { attachments: [{ url: 'https://cdn.example.test/file?sign=synthetic', filename: '合成.png' }] }), signal)
  const reopened = createQqMessagePreparer({ redis: f.db.redis, secretKey: master, now: f.db.now, authorize: async () => true, transport: f.transport })
  const reply = await reopened.prepare({ ...scope, platformUserId: 'member-b' }, parsed('reply', '引用它', { sender: 'member-b', reference: 'idx-one' }), signal)
  assert.equal(reply?.payload.quoted_text, '合成原消息'); assert.equal(reply?.payload.reply_target_sender_id, 'member-a')
  assert.equal(reply?.payload.reply_target_is_bot, false)
  assert.equal(reply?.mediaItems[0]?.source, 'quote'); assert.equal(reply?.mediaItems[0]?.sourcePlatformMessageId, 'idx-one')
  assert.equal(f.requests.length, 0); assert.ok(!JSON.stringify(f.db.calls).includes('合成原消息'))
  const otherGroup = await reopened.prepare({ ...scope, chatId: 'group-b' }, parsed('other', '引用', { group: 'group-b', reference: 'idx-one' }), signal)
  assert.equal(otherGroup?.payload.quoted_text, null); assert.equal(otherGroup?.payload.reply_target_sender_id, null)
  await reopened.close(); await f.prepare.close()
})
test('分离收藏表情3秒FIFO按本人匹配，重连/同image重试复用配对收据不吃下一项', async () => {
  const f = fixture(), attachment = [{ url: 'https://cdn.example.test/face.png', filename: 'face.png' }]
  assert.equal(await f.prepare.prepare(scope, parsed('face-a', face('a')), signal), null)
  assert.equal(await f.prepare.prepare(scope, parsed('face-b', face('b')), signal), null)
  const other = await f.prepare.prepare({ ...scope, platformUserId: 'member-b' }, parsed('image-other', '', { sender: 'member-b', attachments: attachment }), signal)
  assert.notEqual(other?.mediaItems[0]?.item.qq_face, true)
  const first = await f.prepare.prepare(scope, parsed('image-a', '', { attachments: attachment }), signal)
  assert.equal(first?.mediaItems[0]?.item.qq_face, true); assert.equal(first?.splitFace.emojiRefs[0]?.face_id, 'a')
  const retried = await f.prepare.prepare(scope, parsed('image-a', '', { attachments: attachment }), signal)
  assert.equal(retried?.splitFace.emojiRefs[0]?.face_id, 'a')
  assert.equal((await f.prepare.prepare(scope, parsed('image-b', '', { attachments: attachment }), signal))?.splitFace.emojiRefs[0]?.face_id, 'b')
  await f.prepare.prepare(scope, parsed('late-face', face('late')), signal); f.db.advance(3000)
  assert.notEqual((await f.prepare.prepare(scope, parsed('late-image', '', { attachments: attachment }), signal))?.mediaItems[0]?.item.qq_face, true)
  await f.prepare.close()
})
test('QFace实际索引请求仅type1/3，优先type2资源，6小时缓存；未知类型保留占位', async () => {
  const f = fixture()
  const first = await f.prepare.prepare(scope, parsed('system-a', face('1', '1')), signal)
  assert.equal(first?.mediaItems[0]?.item.url, 'https://koishi.js.org/QFace/assets/qq_emoji/one.png')
  assert.equal(first?.mediaItems[0]?.item.qface_generated, true)
  const second = await f.prepare.prepare(scope, parsed('system-b', face('101', '3')), signal)
  assert.equal(second?.mediaItems.length, 1); assert.equal(f.requests.length, 1)
  assert.equal((await f.prepare.prepare(scope, parsed('unknown', face('1', '2')), signal))?.payload.text, '[QQ表情]')
  f.db.advance(6 * 3600 * 1000)
  await f.prepare.prepare(scope, parsed('refresh', face('1', '1')), signal)
  assert.equal(f.requests.length, 2); await f.prepare.close()
})
test('QFace失败60秒退避保留真实文本占位，报告固定码且不生成假媒体', async () => {
  const f = fixture(); f.fail()
  const first = await f.prepare.prepare(scope, parsed('system-a', face('1', '1')), signal)
  assert.equal(first?.payload.text, '[QQ表情]'); assert.deepEqual(first?.mediaItems, [])
  await f.prepare.prepare(scope, parsed('system-b', face('1', '1')), signal)
  assert.equal(f.requests.length, 1); assert.deepEqual(f.reports, ['qface-unavailable'])
  f.recover(); f.db.advance(60_000)
  assert.equal((await f.prepare.prepare(scope, parsed('system-c', face('1', '1')), signal))?.mediaItems.length, 1)
  assert.equal(f.requests.length, 2); await f.prepare.close()
})
test('QFace索引选择拒绝越目录、编码跳转及外部URL，精确emojiId优先qzone fallback', () => {
  assert.equal(selectQqFaceAsset([{ emojiId: 1, assets: [{ type: 2, path: 'assets/qq_emoji/../private' }] }], '1'), null)
  assert.equal(selectQqFaceAsset([{ emojiId: 1, assets: [{ type: 2, path: 'assets/qq_emoji/%2e%2e/private' }] }], '1'), null)
  assert.equal(selectQqFaceAsset([{ emojiId: 1, assets: [{ type: 2, path: 'https://evil.example.test/file' }] }], '1'), null)
  const selected = selectQqFaceAsset([{ qzoneCode: '1', assets: [{ type: 2, path: 'assets/qq_emoji/fallback.png' }] },
    { emojiId: '1', assets: [{ type: 0, path: 'assets/qq_emoji/exact.png' }] }], '1')
  assert.equal(selected?.url, 'https://koishi.js.org/QFace/assets/qq_emoji/exact.png')
})
test('QFace真实prepare→受控图片下载→stage；补图失败保留原占位，成功才清除纯表情文字', async () => {
  const f = fixture(), prepared = await f.prepare.prepare(scope, parsed('system-a', face('1', '1')), signal)
  assert.ok(prepared)
  let status = 200; const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]), stages: unknown[] = []
  const media = createPlatformMedia({ storage: {
    stage: async input => { stages.push(input); return { ownerId: owner, attachId: 'qface-draft', created: false } },
    reuse: async () => null, release: async () => { throw new Error('未创建附件不得清理') },
  }, resolve: async () => [{ address: '9.9.9.9', family: 4 }], transport: {
    request: async input => { assert.equal(input.url, 'https://koishi.js.org/QFace/assets/qq_emoji/one.png'); return { status, headers: {}, body: (async function* () { yield png })(), cancel() {} } }, async close() {},
  } })
  const accepted = await media.qq(scope, prepared, signal)
  assert.equal(accepted.text, ''); assert.deepEqual(accepted.attachments, ['qface-draft']); assert.equal(stages.length, 1)
  status = 500
  const unavailable = await media.qq(scope, prepared, signal)
  assert.equal(unavailable.text, '[QQ表情]'); assert.deepEqual(unavailable.attachments, []); assert.equal(stages.length, 1)
  await media.close(); await f.prepare.close()
})
test('准备前撤权/冒用scope不写引用索引或发QFace请求', async () => {
  const f = fixture(), denied = createQqMessagePreparer({ redis: f.db.redis, secretKey: master, authorize: async () => false, transport: f.transport })
  await assert.rejects(denied.prepare(scope, parsed('one', '合成正文'), signal), /QQ 消息引用或表情准备未完成/)
  await assert.rejects(f.prepare.prepare({ ...scope, ownerId: 'other-owner' }, parsed('one', '合成正文'), signal), /QQ 消息引用或表情准备未完成/)
  assert.equal(f.db.calls.length, 0); assert.equal(f.requests.length, 0)
  await denied.close(); await f.prepare.close()
})
test('实际QQ协议→Core秘密预检消费后不调用真实prepare写索引/FIFO或下载', async () => {
  const f = fixture(), privateScope = { ...scope, chatType: 'c2c' as const, chatId: null }
  let secretValues = 0, waiting = false
  const admissions = new Map<string, 'pending' | 'enqueue' | 'consumed' | 'unknown'>()
  const services: GatewayConnectionServices = {
    admission: {
      begin: async input => { const key = input.scope.eventId; if (admissions.get(key) === 'consumed') return { status: 'consumed', receivedAt: '2026-01-01 00:00:00+00', controlEventId: 'a'.repeat(64) }; admissions.set(key, 'pending'); return { status: 'first', token: 'synthetic-admission-token', receivedAt: '2026-01-01 00:00:00+00', controlEventId: 'a'.repeat(64) } },
      finish: async (scope, _token, outcome) => { admissions.set(scope.eventId, outcome) },
      markUnknown: async scope => { admissions.set(scope.eventId, 'unknown') },
    },
    controls: { authorize: async () => true, inspectSecret: async () => ({ status: 'awaiting_secret', reference: 'synthetic-stage-reference' }), applySecret: async () => { secretValues++; return { status: 'completed' } },
      bindQqOwnerIfUnbound: async () => { throw new Error('秘密不能进入绑定') }, consumeBinding: async () => { throw new Error('秘密不能进入绑定') },
      consumeTextChoice: async () => { throw new Error('秘密不能进入普通交互') }, decideShortcut: async () => { throw new Error('秘密不能进入shortcut') }, cancel: async () => false },
    attachments: { stage: async () => { throw new Error('秘密不能进入附件暂存') }, reuse: async () => null, release: async () => {} },
    callback: async () => { throw new Error('此测试不接收按钮回调') }, prepareQq: f.prepare.prepare,
  }
  const transport: ProviderTransport = { request: async input => {
    if (input.url.includes('/app/getAppAccessToken')) return response({ access_token: 'synthetic-access', expires_in: 7200 })
    if (input.url.endsWith('/gateway')) return response({ url: 'wss://api.sgroup.qq.com/websocket' })
    if (input.url.includes('/messages')) { const body = JSON.parse(Buffer.from(input.body as Uint8Array).toString()); assert.ok(!JSON.stringify(body).includes('synthetic-secret-value')); return response({ id: 'reply-a' }) }
    throw new Error('秘密消息不应发其他HTTP')
  }, async close() {} }
  let socketSignal!: AbortSignal
  const runtime = createPlatformConnections({ redis: f.db.redis, secretKey: master, services: () => services, sanitizeText: value => value, transport: () => transport,
    resolve: async () => [{ address: '9.9.9.9', family: 4 }], qqSocket: async (_url, signal) => {
      socketSignal = signal
      return { send: async () => {}, close: async () => {}, packets: (async function* () {
        yield { op: 10, d: { heartbeat_interval: 60_000 } }
        yield { op: 0, t: 'C2C_MESSAGE_CREATE', s: 1, d: { id: 'secret-a', content: 'synthetic-secret-value', author: { user_openid: privateScope.platformUserId } } }
        waiting = true
        await new Promise<void>(resolve => { if (socketSignal.aborted) resolve(); else socketSignal.addEventListener('abort', () => resolve(), { once: true }) })
      })() }
    } })
  const connection = await runtime.connect({ id: '4', key: 'qq:4', owner, platform: 'qq', revision: 'synthetic', sandbox: false,
    credentials: { appId: 'synthetic-app', appSecret: 'synthetic-bot-secret' } }, signal)
  for (let i = 0; i < 100 && !waiting; i++) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(waiting, true); assert.equal(secretValues, 1); assert.equal(f.db.calls.length, 0); assert.equal(f.requests.length, 0)
  await connection.stop(); await f.prepare.close()
})
