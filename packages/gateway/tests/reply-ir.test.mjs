import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createImRequestedReply } from '../src/ir/reply.ts'

const scope = { ownerId: 'owner', botId: 'bot', platform: 'qq', chatType: 'group', chatId: 'group', platformUserId: 'member' }
const input = { ownerId: 'owner', deliveryId: 'delivery', text: '测试回复' }

test('群聊回复使用绑定群，私聊回复使用绑定用户', () => {
  const reply = createImRequestedReply(scope, input, 'source')
  assert.equal(reply.kind, 'reply.requested')
  assert.equal(reply.recipient, 'group')
  assert.equal(reply.originalMessageId, 'source')
  assert.equal(createImRequestedReply({ ...scope, chatType: 'c2c', chatId: null }, input).recipient, 'member')
})

test('拒绝跨账号投递和缺少群目标的回复', () => {
  assert.equal(createImRequestedReply(scope, { ...input, ownerId: 'another-owner' }), null)
  assert.equal(createImRequestedReply({ ...scope, chatId: null }, input), null)
})
