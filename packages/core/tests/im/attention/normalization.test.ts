import assert from 'node:assert/strict'
import { test } from 'vitest'
import { normalizeAttentionText, buildLogicalCandidates } from '../../../src/im/attention/normalization.js'
import { attentionMessageFromPayload } from '../../../src/im/attention/message.js'

test('话题文本执行 NFKC、casefold 并去掉标点与空白', () => {
  assert.equal(normalizeAttentionText(' ＦＯＯ，Straße！ 咕咕 '), 'foostrasse咕咕')
})

test('候选仅按事件去重排序，附件邻近消息不拼接', () => {
  const base = { platform: 'qq', channel_id: 'bot', chat_id: 'group' }
  const later = attentionMessageFromPayload('1700000000002-1', { ...base, text: '后面' })
  const first = attentionMessageFromPayload('1700000000001-1', { ...base, text: '前面' })
  const replacement = { ...first, rawText: '替换' }
  const result = buildLogicalCandidates([later, first, replacement])
  assert.deepEqual(result.map(item => item.candidateText), ['替换', '后面'])
  assert.equal(result.length, 2)
})
