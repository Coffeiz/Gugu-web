import assert from 'node:assert/strict'
import test from 'node:test'
import { parseImReceivedMessage, readImReceivedMessage } from '../src/ir/inbound.ts'

for (const platform of ['feishu', 'qq', 'wechat', 'telegram']) {
  test(`${platform} 入站事件使用可信连接身份，拒绝跨连接载荷`, () => {
    const connection = { ownerId: 'test-owner', botId: 'test-bot', platform }
    const payload = {
      platform, owner_user_id: connection.ownerId, bot_id: connection.botId, channel_id: connection.botId,
      chat_type: 'c2c', chat_id: 'native-transport-target', platform_user_id: 'test-sender',
      platform_event_id: 'test-event', message_id: 'test-message', text: '合成消息',
      admissionCutoff: 'untrusted',
    }
    const event = readImReceivedMessage(connection, payload)
    assert.equal(event.scope.chatId, null)
    assert.equal(event.scope.platformUserId, 'test-sender')
    assert.equal(event.eventId, 'test-event')
    assert.equal(event.text, '合成消息')
    assert.equal('admissionCutoff' in event.scope, false)
    assert.throws(() => readImReceivedMessage(connection, { ...payload, owner_user_id: 'another-owner' }), /连接范围/)
    assert.throws(() => readImReceivedMessage(connection, { ...payload, channel_id: 'another-bot' }), /连接范围/)
    assert.throws(() => readImReceivedMessage(connection, { ...payload, chat_type: 'group', chat_id: null }), /连接范围/)
    assert.throws(() => readImReceivedMessage(connection, { ...payload, platform_event_id: '', message_id: '' }), /稳定标识/)
  })
}

test('准入键沿用既有摘要输入并隔离消息、发送者和机器人', async () => {
  const { imAdmissionKeys } = await import('../src/runtime/admission.ts')
  const scope = { ownerId: 'owner', platform: 'qq', botId: '17', chatType: 'group',
    chatId: 'group', platformUserId: 'sender', eventId: 'event' }
  const digest = value => JSON.stringify(value)
  const keys = imAdmissionKeys(scope, digest)
  assert.equal(keys.scopeHash, digest(['owner', 'qq', '17', 'group', 'group']))
  assert.equal(keys.eventHash, digest([keys.scopeHash, 'sender', 'event']))
  assert.notEqual(imAdmissionKeys({ ...scope, eventId: 'other' }, digest).eventHash, keys.eventHash)
  assert.notEqual(imAdmissionKeys({ ...scope, platformUserId: 'other' }, digest).eventHash, keys.eventHash)
  assert.notEqual(imAdmissionKeys({ ...scope, botId: '18' }, digest).scopeHash, keys.scopeHash)
})

test('重读入站事件时拒绝跨连接、错误会话结构和未支持版本', () => {
  const connection = { ownerId: 'test-owner', botId: 'test-bot', platform: 'wechat' }
  const event = {
    version: 1, kind: 'message.received', eventId: 'message:42',
    scope: { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'test-peer' },
    text: '合成消息', quotedText: null, botMentioned: false,
  }
  assert.deepEqual(parseImReceivedMessage(connection, JSON.parse(JSON.stringify(event))), event)
  assert.throws(() => parseImReceivedMessage({ ...connection, ownerId: 'other-owner' }, event))
  assert.throws(() => parseImReceivedMessage(connection, { ...event, scope: { ...event.scope, chatId: 'group' } }))
  assert.throws(() => parseImReceivedMessage(connection, { ...event, version: 2 }))
})
