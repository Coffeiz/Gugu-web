import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesImInteractionScope, readImReceivedInteraction } from '../src/ir/interaction.ts'

test('QQ 回调保留卡片定位事实并绑定可信连接', () => {
  const connection = { ownerId: 'owner', botId: '17', platform: 'qq' }
  const input = { id: 'event', user_openid: 'sender', group_openid: 'group', message_id: 'message', action_data: '1:test-token' }
  const event = readImReceivedInteraction(connection, 'qq', input)
  assert.equal(event.kind, 'interaction.received')
  assert.deepEqual(event.action, { promptId: 1, token: 'test-token', operator: 'sender', eventId: 'event',
    messageId: 'message', chatId: 'group', chatType: 'group' })
  assert.throws(() => readImReceivedInteraction(connection, 'telegram', input), /连接范围/)
})

test('飞书拒绝声明其他机器人的回调', () => {
  assert.throws(() => readImReceivedInteraction({ ownerId: 'owner', botId: '17', platform: 'feishu' },
    'feishu', { ownerId: 'owner', botId: '18' }), /连接范围/)
})


test('已投递的确认提示拒绝跨连接、跨群和其他私聊用户的回调', () => {
  const connection = { ownerId: 'owner', botId: '17', platform: 'qq' }
  const input = { id: 'event', user_openid: 'sender', action_data: '1:test-token' }
  const privateEvent = readImReceivedInteraction(connection, 'qq', input)
  const privateScope = { ...connection, chatType: 'c2c', chatId: null, platformUserId: 'sender' }
  assert.equal(matchesImInteractionScope(privateEvent, privateScope), true)
  assert.equal(matchesImInteractionScope(privateEvent, { ...privateScope, platformUserId: 'other' }), false)
  assert.equal(matchesImInteractionScope(privateEvent, { ...privateScope, botId: '18' }), false)
  const groupEvent = readImReceivedInteraction(connection, 'qq', { ...input, group_openid: 'group' })
  const groupScope = { ...privateScope, chatType: 'group', chatId: 'group' }
  assert.equal(matchesImInteractionScope(groupEvent, groupScope), true)
  assert.equal(matchesImInteractionScope(groupEvent, { ...groupScope, chatId: 'other' }), false)
  assert.equal(matchesImInteractionScope(groupEvent, privateScope), false)
})
