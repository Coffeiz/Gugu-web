import assert from 'node:assert/strict'
import { test } from 'vitest'
import { attentionMessageFromPayload } from '../../../src/im/attention/message.js'

test('注意力消息只接受可信流时间并归一媒体与提及事实', () => {
  const message = attentionMessageFromPayload('1700000000123-4', {
    platform: 'qq', channel_id: 'bot', chat_id: 'group', platform_user_id: 'member',
    text: '', attachments: [{ type: 'photo' }, { type: 'voice' }],
    native_bot_mentioned: false, platform_sent_ms: 1700000000,
  })
  assert.equal(message.eventReceivedMs, 1700000000123)
  assert.equal(message.platformSentMs, 1700000000000)
  assert.deepEqual(message.mediaKinds, ['audio', 'image'])
  assert.equal(message.mediaOnly, true)
  assert.equal(message.mentionedCurrentBot, false)
  assert.throws(() => attentionMessageFromPayload('untrusted', { platform: 'qq', channel_id: 'bot', chat_id: 'group' }))
  assert.throws(() => attentionMessageFromPayload('1700000000123-4', { platform: 'qq' }))
})

test('未知原生提及时标记未解析而明确否定不推断', () => {
  const base = { platform: 'qq', channel_id: 'bot', chat_id: 'group', text: '@someone 看一下' }
  assert.equal(attentionMessageFromPayload('1700000000123-4', base).hasUnresolvedMention, true)
  assert.equal(attentionMessageFromPayload('1700000000123-4', { ...base, native_bot_mentioned: false }).hasUnresolvedMention, false)
})
