import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createImInboundEnvelope } from '../../../src/modules/im/gateway/inbound/envelope.js'
import { createNodeImInbox } from '../../../src/modules/im/gateway/inbound/inbox.js'

const binding = { platform: 'wechat' as const, botId: '7', ownerId: 'owner-a' }
const payload = { platform: 'wechat', bot_id: '7', channel_id: '7', owner_user_id: 'owner-a', chat_type: 'c2c',
  platform_user_id: 'sender-a', message_id: 'synthetic-context', context_token: 'synthetic-context', text: '合成入站正文',
  attachments: ['attach-a'], quoted_text: '合成引用', media: { aes_key: 'synthetic-media-material' } }

test('入站真实AES-GCM包封隐藏正文/context token/媒体材料，随机密文仍有稳定去重身份', () => {
  const codec = createImInboundEnvelope('synthetic-key')
  const a = codec.seal(binding, payload), b = codec.seal(binding, payload)
  assert.notEqual(a.__sealed_im, b.__sealed_im)
  assert.equal(a.message_id, b.message_id)
  for (const secret of ['合成入站正文', 'synthetic-context', 'synthetic-media-material', '合成引用', 'attach-a'])
    assert.equal(JSON.stringify(a).includes(secret), false)
  assert.deepEqual(codec.open(binding, a), payload)
})

test('入站跨owner/Bot/群/发言人篡改或错误密钥不能解封；不回落成明文', () => {
  const codec = createImInboundEnvelope('synthetic-key')
  const envelope = codec.seal(binding, payload)
  for (const changed of [{ ...envelope, owner_user_id: 'owner-b' }, { ...envelope, bot_id: '8', channel_id: '8' },
    { ...envelope, platform_user_id: 'sender-b' }, { ...envelope, chat_type: 'group', chat_id: 'group-b' },
    { ...envelope, text: '不能夹带明文' }, { ...envelope, __sealed_im: String(envelope.__sealed_im).slice(0, -5) + 'AAAAA' }])
    assert.throws(() => codec.open(binding, changed), /密封载荷无效/)
  assert.throws(() => createImInboundEnvelope('another-synthetic-key').open(binding, envelope), /密封载荷无效/)
  assert.throws(() => codec.open(binding, payload), /密封载荷无效/)
  assert.throws(() => codec.seal({ ...binding, ownerId: 'owner-b' }, payload), /密封载荷无效/)
})

test('sealed载荷实际经过Node inbox编码，Redis命令不含正文或凭证且Worker可验证解封', async () => {
  let stored: Record<string, unknown> | undefined
  const inbox = createNodeImInbox({ async sendCommand(args) {
    const keyCount = Number(args[2])
    stored = JSON.parse(args[3 + keyCount + 1]!)
    assert.equal(args.join('').includes('synthetic-context'), false)
    assert.equal(args.join('').includes('合成入站正文'), false)
    return '100-0'
  } })
  const codec = createImInboundEnvelope('synthetic-key')
  assert.equal(await inbox.enqueue(binding, codec.seal(binding, payload)), '100-0')
  assert.deepEqual(codec.open(binding, stored!), payload)
})

test('Gateway可信准入使用独立密钥/AAD，改前缀、payload布尔或外层字段均不能伪造', () => {
  const codec = createImInboundEnvelope('synthetic-key'), raw = codec.seal(binding, { ...payload, __preflight_done: true }), admitted = codec.sealAdmitted(binding, payload)
  assert.equal(codec.openForWorker(binding, raw).admission, 'raw')
  assert.equal(codec.openForWorker(binding, admitted).admission, 'gateway')
  assert.deepEqual(codec.openForWorker(binding, admitted).payload, payload)
  assert.equal(raw.message_id, admitted.message_id, '准入证明不改变原生事件稳定去重身份')
  for (const changed of [
    { ...raw, __sealed_im: String(raw.__sealed_im).replace(/^im1:/u, 'im2:') },
    { ...admitted, __sealed_im: String(admitted.__sealed_im).replace(/^im2:/u, 'im1:') },
    { ...raw, __preflight_done: true }, { ...admitted, message_id: 'a'.repeat(64) },
    { ...admitted, owner_user_id: 'other-owner' }, { ...admitted, bot_id: '8', channel_id: '8' },
    { ...admitted, chat_type: 'group', chat_id: 'another-group' }, { ...admitted, platform_user_id: 'another-sender' },
  ]) assert.throws(() => codec.openForWorker(binding, changed), /密封载荷无效/)
})
